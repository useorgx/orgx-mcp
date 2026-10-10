/**
 * streamGrant.ts — hand a widget everything it needs to subscribe.
 *
 * A sandboxed widget cannot mint its own stream token, so the token has to ride
 * along in the tool payload. Previously only the two server-generated HTML
 * widgets got one, which is why the ten static widgets in public/widgets/ had no
 * way to go live even though the transport existed.
 *
 * A grant is embedded as `structuredContent.live`, so any tool can make its
 * widget live by calling `buildStreamGrant` and attaching the result — and the
 * widget's own `live-store.js` knows how to read it without per-tool wiring.
 *
 * The grant also carries `expiresAt`. A widget that knows when its token dies can
 * refresh proactively by re-invoking `refreshTool`, rather than waiting for the
 * stream to fail.
 */

import { signStreamToken } from '../streamToken';
import { getFeed } from './feedRegistry';

export interface StreamGrant {
  feedType: string;
  feedId: string;
  /** Absolute SSE URL with the signed token already attached. */
  streamUrl: string;
  /** Epoch ms the token stops being accepted. */
  expiresAt: number;
  /** Tool the widget re-invokes to obtain a fresh grant. */
  refreshTool: string;
  /** Arguments to pass back to `refreshTool`. */
  refreshArgs: Record<string, string>;
  /** Human label for the feed, for the widget's header fallback. */
  label: string;
}

/**
 * Live-feed grants are deliberately short-lived.
 *
 * The signed URL reaches the widget through the tool result, so it is exposed
 * more widely than a credential minted inside a request. The widget refreshes
 * through its bound MCP tool, which costs one call, so the only thing a long
 * lifetime buys is a longer replay window for a leaked URL.
 */
export const LIVE_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Lifetime for the token baked into the server-generated HTML widget.
 *
 * That widget is standalone: no MCP tool handle, so no way to obtain a fresh
 * token. The short grant lifetime above only works because a widget holding a
 * grant can re-invoke its bound tool. Applying it here would simply end the
 * widget's updates sooner, with nothing it could do about it.
 */
export const GENERATED_WIDGET_TTL_MS = 60 * 60 * 1000;

export async function buildStreamGrant(input: {
  feedType: string;
  feedId: string;
  serverUrl: string;
  secret: string;
  refreshTool: string;
  refreshArgs?: Record<string, string>;
  userId?: string;
  /** Canonical OrgX user UUID, signed into the token for user-scoped feeds. */
  orgxUserId?: string | null;
}): Promise<StreamGrant | null> {
  const feed = getFeed(input.feedType);
  if (!feed) return null;
  if (!input.feedId || !input.secret || !input.serverUrl) return null;

  const token = await signStreamToken({
    feedType: input.feedType,
    feedId: input.feedId,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.orgxUserId ? { orgxUserId: input.orgxUserId } : {}),
    secret: input.secret,
    ttlMs: LIVE_GRANT_TTL_MS,
  });

  const base = input.serverUrl.replace(/\/+$/, '');
  const streamUrl =
    `${base}/live-feed/${input.feedType}/${encodeURIComponent(input.feedId)}` +
    `/stream?t=${encodeURIComponent(token)}`;

  return {
    feedType: input.feedType,
    feedId: input.feedId,
    streamUrl,
    // Reported slightly short of the real exp so a widget that refreshes on
    // this value always beats the server's own expiry warning.
    expiresAt: Date.now() + LIVE_GRANT_TTL_MS - 30_000,
    refreshTool: input.refreshTool,
    refreshArgs: input.refreshArgs ?? {},
    label: feed.label,
  };
}

/**
 * Which feed a widget tool should subscribe to, and the tool that refreshes it.
 * Keeping this beside the registry means a tool becomes live by gaining a row
 * here rather than by growing its own token plumbing.
 */
/**
 * Where a tool's initiative id comes from.
 *
 * `initiative_id` is the only field that is reliably an initiative. The caller's
 * `effectiveInitiativeId` falls back to `data.id`, which for orgx_inspect is
 * whichever entity was inspected — a task, an artifact, a decision — and
 * subscribing a feed to a task id polls the agents API for an initiative that
 * does not exist. `entity_is_initiative` marks the tools whose own `id` *is* an
 * initiative, which is the only case where that fallback is correct.
 */
export type FeedIdSource = 'initiative_id' | 'entity_is_initiative';

export interface ToolFeedBinding {
  feedType: string;
  refreshTool: string;
  idSource: FeedIdSource;
}

// Only feeds present in FEEDS may be bound here; buildStreamGrant returns null
// for anything else, so a stale binding degrades to a static widget rather than
// a broken subscription.
export const TOOL_FEED_BINDINGS: Record<string, ToolFeedBinding> = {
  orgx_get_agent_status: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_get_initiative_progress: {
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    idSource: 'entity_is_initiative',
  },
  orgx_start_agent_task: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_handoff_task: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_create_initiative_hierarchy: {
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    idSource: 'entity_is_initiative',
  },
  orgx_list_pending_decisions: {
    feedType: 'decisions',
    refreshTool: 'orgx_list_pending_decisions',
    idSource: 'initiative_id',
  },
  orgx_open_decision_review: {
    feedType: 'decisions',
    refreshTool: 'orgx_list_pending_decisions',
    idSource: 'initiative_id',
  },
  orgx_get_operator_brief: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_get_workspace_context: {
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    idSource: 'initiative_id',
  },
  get_agent_status: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  get_initiative_pulse: {
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    // The pulse's own subject is the initiative.
    idSource: 'entity_is_initiative',
  },
  spawn_agent_task: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  delegate_agent_task: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_spawn: {
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    // A spawn returns a run id in `data.id`, not an initiative.
    idSource: 'initiative_id',
  },
  scaffold_initiative: {
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    // Scaffolding returns the initiative it just created.
    idSource: 'entity_is_initiative',
  },
  // The decision queue is the one feed scoped to a person rather than an
  // initiative; see FeedDefinition.scope.
  get_pending_decisions: {
    feedType: 'decisions',
    refreshTool: 'orgx_list_pending_decisions',
    idSource: 'initiative_id',
  },
  orgx_decide: {
    feedType: 'decisions',
    refreshTool: 'orgx_list_pending_decisions',
    idSource: 'initiative_id',
  },
  // Widgets that arrived on main after this layer was built.
  orgx_inspect: {
    // Inspecting an entity: show what is running on the initiative it belongs
    // to. `data.id` is the inspected entity and must not be used as the feed.
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  get_operator_chronicle: {
    // A chronicle answers "what happened"; the panel answers "what is happening".
    feedType: 'agent-status',
    refreshTool: 'orgx_get_agent_status',
    idSource: 'initiative_id',
  },
  orgx_bootstrap: {
    // Bootstrap can bind an initiative for the session. When it does, the
    // workspace map opens on that initiative's live state — which is the
    // "continue where the last agent left off" case this layer exists for.
    feedType: 'initiative-pulse',
    refreshTool: 'orgx_get_initiative_progress',
    idSource: 'initiative_id',
  },
};

export function feedBindingForTool(toolId: string): ToolFeedBinding | null {
  return Object.prototype.hasOwnProperty.call(TOOL_FEED_BINDINGS, toolId)
    ? TOOL_FEED_BINDINGS[toolId]!
    : null;
}

/**
 * The initiative id a tool's payload may be subscribed against, or null when it
 * has none. A tool with no initiative context simply gets no grant, and its
 * widget stays static.
 */
export function resolveFeedIdForTool(
  binding: ToolFeedBinding,
  data: Record<string, unknown>
): string | null {
  const initiativeId = data.initiative_id;
  if (typeof initiativeId === 'string' && initiativeId.trim()) return initiativeId;
  if (binding.idSource !== 'entity_is_initiative') return null;
  const entityId = data.id;
  return typeof entityId === 'string' && entityId.trim() ? entityId : null;
}
