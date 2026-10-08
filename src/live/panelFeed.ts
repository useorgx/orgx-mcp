/**
 * panelFeed.ts — the OrgX panel's live feed.
 *
 * One Durable Object per viewer and workspace polls the two reads the panel
 * itself makes (the pending-decision queue and agent status) and reports when
 * either changes. The panel uses that as its signal: a decision that left the
 * queue disappears immediately, and anything new triggers one re-read of
 * `orgx_panel_snapshot`, so the panel still renders from the single projection
 * the tool returns and approval tokens never travel over the stream.
 *
 * Both reads are marked `usage_class: "live_refresh"`, which the app exempts
 * from the person's MCP call allowance. The app echoes whether it billed a
 * call; a poll it billed halts the feed rather than spending someone's plan in
 * the background (an app deployed without the exemption, or a changed rule).
 */

import { normalizeAgentStatusPayload } from '../agentStatusPayload';
import { buildPanelWork, panelDecisionSignals, PANEL_DECISION_READ_LIMIT } from '../panelSurface';
import { buildWorkGraph, type WorkGraph, type WorkNode, type WorkPhase } from './workGraph';

export const PANEL_FEED_TYPE = 'panel' as const;
export const LIVE_REFRESH_USAGE_CLASS = 'live_refresh' as const;
/** Marks a poll whose agent read failed; see buildPanelLiveGraph. */
export const PANEL_WORK_UNAVAILABLE_ID = 'meta:work-unavailable';

/** What a feed's custom loader gets from the Durable Object. */
export interface FeedLoadContext {
  feedId: string;
  /** Verified viewer id from the stream token; required for user-scoped feeds. */
  viewerId: string | null;
  /** The viewer's canonical OrgX UUID, when known. */
  viewerOrgxId?: string | null;
  /** Calls the OrgX API with the service key and the viewer's actor token. */
  request(path: string, init: RequestInit): Promise<Response>;
}

export interface PanelFeedRaw {
  decisions: unknown[];
  /** Normalized agent status, or null when that read failed. */
  agents: Record<string, unknown> | null;
}

/**
 * Raised when the app billed a poll. Not retryable, and it halts the feed: the
 * next poll would be billed too.
 */
export class LiveRefreshMeteredError extends Error {
  readonly retryable = false;
  readonly halt = true;
  constructor(toolId: string) {
    super(`live_refresh_metered: ${toolId} was billed; the panel feed stops instead of spending allowance`);
    this.name = 'LiveRefreshMeteredError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Decide from the app's `usage` echo whether polling may continue.
 *  - No `usage` at all: an app that predates the exemption billed this call.
 *    Halt.
 *  - Over the per-person cap: this call was billed, but the cap resets each
 *    minute. Back off (retryable) rather than halt, so a person with several
 *    panels open is slowed, not cut off.
 *  - Any other billed call (the marker was ignored): halt.
 *  - Not billed (exempt, or no resolvable user): carry on.
 */
export function assertExempt(toolId: string, usage: Record<string, unknown> | null): void {
  if (!usage) throw new LiveRefreshMeteredError(toolId);
  if (usage.reason === 'over_live_cap') {
    throw Object.assign(new Error(`live_refresh_capped: ${toolId}`), { retryable: true });
  }
  const billed = typeof usage.billed === 'boolean' ? usage.billed : usage.metered !== false;
  if (billed) throw new LiveRefreshMeteredError(toolId);
}

async function readTool(
  ctx: FeedLoadContext,
  toolId: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  const response = await ctx.request('/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool_id: toolId,
      args,
      // The same identity the panel's own reads send: the canonical UUID when
      // known, beside the actor token the request already signs.
      user_id: ctx.viewerOrgxId ?? ctx.viewerId,
      usage_class: LIVE_REFRESH_USAGE_CLASS,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`API ${response.status}: ${text.slice(0, 200)}`), {
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const body = asRecord(await response.json());
  if (!body || body.ok === false) return { ok: false, data: null };
  assertExempt(toolId, asRecord(body.usage));
  return { ok: true, data: asRecord(body.data) };
}

export async function loadPanelFeed(ctx: FeedLoadContext): Promise<PanelFeedRaw> {
  if (!ctx.viewerId) {
    throw Object.assign(new Error('panel feed requires a viewer'), { retryable: false });
  }
  const workspaceId = ctx.feedId;
  const [decisions, agents] = await Promise.all([
    readTool(ctx, 'get_pending_decisions', {
      workspace_id: workspaceId,
      limit: PANEL_DECISION_READ_LIMIT,
    }),
    // The agent read may be refused (scope, plan) while decisions still work,
    // so its failure costs In progress, not the whole feed.
    readTool(ctx, 'get_agent_status', { workspace_id: workspaceId }).catch((error) => {
      if (error instanceof LiveRefreshMeteredError) throw error;
      if (error instanceof Error && error.message.startsWith('live_refresh_capped')) throw error;
      return { ok: false, data: null };
    }),
  ]);
  if (!decisions.ok) {
    throw Object.assign(new Error('pending decisions read failed'), { retryable: true });
  }
  const list = decisions.data?.decisions;
  return {
    decisions: Array.isArray(list) ? list : [],
    agents: agents.ok && agents.data ? normalizeAgentStatusPayload(agents.data) : null,
  };
}

const WORK_PHASE: Record<string, WorkPhase> = {
  running: 'executing',
  blocked: 'blocked',
  queued: 'pending',
};

/**
 * Pure: the feed's graph. Decisions are `decision:` nodes and running work is
 * `work:` nodes, so the shared delta machinery reports exactly which decision
 * left, arrived or changed version, and whether In progress moved.
 */
export function buildPanelLiveGraph(raw: unknown, feedId: string): WorkGraph {
  const record = asRecord(raw) ?? {};
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  const nodes: WorkNode[] = panelDecisionSignals(decisions).map((d) => ({
    id: `decision:${d.id}`,
    title: d.title,
    kind: 'decision',
    // Pending, not blocked: a queue that is only waiting on the viewer polls
    // at the feed's resting rate. Running or blocked agent work earns the
    // responsive rate, which is when the panel changes on its own.
    phase: 'pending',
    status: 'pending',
    updatedAt: d.version,
  }));
  const agents = asRecord(record.agents);
  if (!agents) {
    // The agent read failed. Say so, rather than report no work: the panel
    // keeps what it showed instead of flipping In progress to zero.
    nodes.push({ id: PANEL_WORK_UNAVAILABLE_ID, title: 'Agent status unavailable', kind: 'task', phase: 'pending' });
  } else {
    for (const item of buildPanelWork(agents).items) {
      nodes.push({
        id: `work:${item.id}`,
        title: item.title,
        kind: 'task',
        owner: item.agent,
        phase: WORK_PHASE[item.state] ?? 'pending',
        status: item.state,
      });
    }
  }
  return buildWorkGraph({ feedType: PANEL_FEED_TYPE, feedId, nodes });
}
