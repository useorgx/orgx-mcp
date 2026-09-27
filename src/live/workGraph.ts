/**
 * workGraph.ts — the canonical shape every live feed emits.
 *
 * Before this existed, each live surface passed the raw OrgX API response
 * straight through, so `agent-status` spoke `{agents:[{status}]}`, the pulse
 * spoke `{initiatives:[{workstreams:[{progress}]}]}`, and every widget grew its
 * own reader for its own dialect. Adding a feed meant writing a widget, and a
 * status string meant something slightly different on each surface.
 *
 * A feed now normalizes into one `WorkGraph`: a flat list of `WorkNode`s with a
 * shared phase vocabulary, plus the rollup counts and the control-flow edges
 * that make "what is in progress, and what is it waiting on" answerable without
 * the widget knowing which endpoint it came from.
 *
 * The phase vocabulary deliberately matches
 * public/widgets/shared/live-machine.js and
 * orgx/lib/live/executionRoomRealtimeClient.ts so a run classifies identically
 * in the widget, in this worker, and in the /live execution room.
 */

export type WorkPhase = 'pending' | 'executing' | 'blocked' | 'terminal';

/** Why a node cannot proceed. Rendered verbatim, so it must be human-readable. */
export interface WorkBlocker {
  reason: string;
  since?: string;
  /** Present when a human can clear it — an approval, a credential, a decision. */
  actionable?: boolean;
  /** Tool the widget should call to resolve it, when one exists. */
  resolveTool?: string;
}

export interface WorkNode {
  id: string;
  title: string;
  phase: WorkPhase;
  /** Raw upstream status, kept for display and for debugging normalization. */
  status?: string;
  /** 0–100 when the upstream reports it; absent means genuinely unknown. */
  progress?: number;
  kind?: 'initiative' | 'workstream' | 'task' | 'agent' | 'decision' | 'artifact';
  domain?: string;
  owner?: string;
  /** Parent node id — what makes the flat list a tree. */
  parentId?: string;
  /** Node ids this one waits on, for control-flow rendering. */
  dependsOn?: string[];
  startedAt?: string;
  updatedAt?: string;
  blockers?: WorkBlocker[];
  /** Deep link into the OrgX web app for this node. */
  href?: string;
  /** Proof that the work happened — PR URL, artifact id, receipt. */
  evidence?: { label: string; href?: string }[];
}

export interface WorkSummary {
  running: number;
  queued: number;
  blocked: number;
  done: number;
  total: number;
  /** Weighted completion across nodes that report progress, 0–100. */
  progress: number;
}

export interface WorkGraph {
  feedType: string;
  feedId: string;
  title?: string;
  nodes: WorkNode[];
  summary: WorkSummary;
  /** Set when the feed knows the whole graph is waiting on one thing. */
  headline?: string;
  updatedAt: string;
  /**
   * Proof-surface handoff carried straight through from the upstream payload.
   * It is product copy, not work state, so normalizing it would be wrong — but
   * dropping it would silently delete the one quiet CTA a proof surface shows.
   */
  proofHandoff?: { quiet_cta?: string };
}

const EXECUTING = new Set([
  'EXECUTING',
  'REEXECUTING',
  'WAITING',
  'RUNNING',
  'IN_PROGRESS',
  'ACTIVE',
  'STREAMING',
]);

const TERMINAL = new Set([
  'COMPLETED',
  'COMPLETE',
  'DONE',
  'CANCELED',
  'CANCELLED',
  'FAILED',
  'CRASHED',
  'SYSTEM_FAILURE',
  'EXPIRED',
  'TIMED_OUT',
  'INTERRUPTED',
  'SHIPPED',
  'APPROVED',
  'REJECTED',
]);

const BLOCKED = new Set([
  'BLOCKED',
  'NEEDS_APPROVAL',
  'AWAITING_APPROVAL',
  'AWAITING_INPUT',
  'NEEDS_ATTENTION',
  'ESCALATED',
  'PENDING_APPROVAL',
]);

export function phaseForStatus(status: unknown): WorkPhase {
  if (status === null || status === undefined || status === '') return 'pending';
  const normalized = String(status).toUpperCase().replace(/[\s-]+/g, '_');
  if (BLOCKED.has(normalized)) return 'blocked';
  if (TERMINAL.has(normalized)) return 'terminal';
  if (EXECUTING.has(normalized)) return 'executing';
  return 'pending';
}

/**
 * A node is blocked if anything says so, regardless of its status string. An
 * upstream that reports `status: "running"` alongside a non-empty blocker list
 * is reporting a stalled run, and filing that under "running" is how a stuck
 * initiative looks healthy on a dashboard.
 */
export function resolvePhase(
  status: unknown,
  blockers?: readonly WorkBlocker[] | null
): WorkPhase {
  const phase = phaseForStatus(status);
  if (phase === 'terminal') return 'terminal';
  if (blockers && blockers.length > 0) return 'blocked';
  return phase;
}

export function summarize(nodes: readonly WorkNode[]): WorkSummary {
  const summary: WorkSummary = {
    running: 0,
    queued: 0,
    blocked: 0,
    done: 0,
    total: 0,
    progress: 0,
  };
  let progressSum = 0;
  let progressCount = 0;

  for (const node of nodes) {
    summary.total += 1;
    if (node.phase === 'executing') summary.running += 1;
    else if (node.phase === 'blocked') summary.blocked += 1;
    else if (node.phase === 'terminal') summary.done += 1;
    else summary.queued += 1;

    if (typeof node.progress === 'number' && Number.isFinite(node.progress)) {
      progressSum += Math.max(0, Math.min(100, node.progress));
      progressCount += 1;
    } else if (node.phase === 'terminal') {
      // A finished node with no reported progress is 100% — otherwise a feed
      // that only reports progress for in-flight work reads as less complete
      // the more of it finishes.
      progressSum += 100;
      progressCount += 1;
    }
  }

  summary.progress = progressCount === 0 ? 0 : Math.round(progressSum / progressCount);
  return summary;
}

/**
 * The single most useful sentence a live surface can show: what the graph is
 * waiting on. Blocked work outranks everything because it is the only phase a
 * human can act on; an all-terminal graph is the other case worth naming,
 * because "done" needs to be unmistakable rather than inferred from zeroes.
 */
export function deriveHeadline(nodes: readonly WorkNode[], summary: WorkSummary): string | undefined {
  if (summary.total === 0) return undefined;

  const blocked = nodes.filter((node) => node.phase === 'blocked');
  if (blocked.length === 1) {
    const reason = blocked[0]!.blockers?.[0]?.reason;
    return reason
      ? `${blocked[0]!.title} is blocked — ${reason}`
      : `${blocked[0]!.title} is blocked`;
  }
  if (blocked.length > 1) {
    return `${blocked.length} workstreams blocked`;
  }
  if (summary.running > 0) {
    return `${summary.running} running · ${summary.queued} queued`;
  }
  if (summary.done === summary.total) return 'All work complete';
  if (summary.queued === summary.total) return `${summary.queued} queued, none started`;
  return undefined;
}

export function buildWorkGraph(input: {
  feedType: string;
  feedId: string;
  title?: string;
  nodes: WorkNode[];
  updatedAt?: string;
  proofHandoff?: { quiet_cta?: string };
}): WorkGraph {
  const summary = summarize(input.nodes);
  return {
    feedType: input.feedType,
    feedId: input.feedId,
    ...(input.title ? { title: input.title } : {}),
    nodes: input.nodes,
    summary,
    ...(deriveHeadline(input.nodes, summary)
      ? { headline: deriveHeadline(input.nodes, summary) }
      : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.proofHandoff ? { proofHandoff: input.proofHandoff } : {}),
  };
}

/**
 * Find the proof handoff wherever the upstream hung it — on the envelope, on the
 * initiative, or on the first agent that carries one. The three live routes each
 * place it differently.
 */
export function readProofHandoff(
  ...sources: readonly unknown[]
): { quiet_cta?: string } | undefined {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const handoff = (source as Loose).proof_handoff ?? (source as Loose).proofHandoff;
    if (!handoff || typeof handoff !== 'object') continue;
    const cta = (handoff as Loose).quiet_cta;
    if (typeof cta === 'string' && cta.trim()) return { quiet_cta: cta.trim() };
  }
  return undefined;
}

// ── Reading loosely-typed upstream payloads ──────────────────────────────────
// The live API routes have grown several spellings for the same field over
// time (`currentTask`/`current_task`, `initiativeId`/`initiative_id`). These
// readers absorb that here, once, instead of in every widget.

type Loose = Record<string, unknown>;

export function readString(source: Loose, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function readNumber(source: Loose, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

export function readArray(source: Loose, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function readBlockers(source: Loose): WorkBlocker[] {
  const raw = readArray(source, ['blockers', 'blocker_list', 'blockedBy']);
  const blockers: WorkBlocker[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      blockers.push({ reason: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Loose;
      const reason = readString(record, ['reason', 'message', 'description', 'title']);
      if (!reason) continue;
      const since = readString(record, ['since', 'created_at', 'createdAt', 'blockedAt']);
      const resolveTool = readString(record, ['resolve_tool', 'resolveTool']);
      blockers.push({
        reason,
        ...(since ? { since } : {}),
        ...(resolveTool ? { resolveTool, actionable: true } : {}),
      });
    }
  }
  const single = readString(source, ['blocker', 'blocked_reason', 'blockedReason']);
  if (single && !blockers.some((blocker) => blocker.reason === single)) {
    blockers.push({ reason: single });
  }
  return blockers;
}
