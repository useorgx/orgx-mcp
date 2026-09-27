/**
 * feedRegistry.ts — declarative live-feed definitions.
 *
 * LiveFeedDO used to hard-code its two feeds in a `switch` inside the polling
 * method, so a third feed meant touching the Durable Object, the auth handler's
 * path regex, the widget builder, and the tests. A feed is now a record: URL
 * builder, normalizer, and cadence. The DO reads the registry, the auth handler
 * derives its route pattern from it, and nothing else needs to change.
 */

import {
  buildWorkGraph,
  readProofHandoff,
  readArray,
  readBlockers,
  readNumber,
  readString,
  resolvePhase,
  type WorkGraph,
  type WorkNode,
} from './workGraph';

type Loose = Record<string, unknown>;

export interface FeedCadence {
  /** Poll interval while any node is executing — the "something is happening" rate. */
  activeMs: number;
  /** Poll interval when every node is terminal or pending — the resting rate. */
  idleMs: number;
}

export interface FeedDefinition {
  type: string;
  /** Build the upstream OrgX API URL for this feed. */
  buildUrl(feedId: string, apiBase: string): string;
  /** Fold the upstream payload into the canonical graph. */
  normalize(raw: unknown, feedId: string): WorkGraph;
  cadence: FeedCadence;
  /** Human label, used in logs and in the widget header fallback. */
  label: string;
}

// Adaptive cadence is the main cost lever. The old DO polled every feed every
// 10s for as long as a client was attached, including initiatives where every
// workstream had been done for a week. Executing work is worth 3s; a resting
// graph is not worth more than 30s, and the client's own reconciliation means a
// slower poll costs nothing visually.
const RESPONSIVE: FeedCadence = { activeMs: 3000, idleMs: 30000 };
const CALM: FeedCadence = { activeMs: 5000, idleMs: 45000 };

function asRecord(value: unknown): Loose {
  return value && typeof value === 'object' ? (value as Loose) : {};
}

function nodeFromAgent(raw: unknown, index: number): WorkNode | null {
  const record = asRecord(raw);
  const id =
    readString(record, ['id', 'agent_id', 'agentId', 'runId', 'run_id']) ?? `agent-${index}`;
  const title =
    readString(record, ['name', 'agent_name', 'agentName', 'title']) ?? 'Agent';
  const blockers = readBlockers(record);
  const status = readString(record, ['status', 'state', 'phase']);

  return {
    id,
    title,
    kind: 'agent',
    phase: resolvePhase(status, blockers),
    ...(status ? { status } : {}),
    ...(readNumber(record, ['progress', 'percent', 'pct']) !== undefined
      ? { progress: readNumber(record, ['progress', 'percent', 'pct']) }
      : {}),
    ...(readString(record, ['domain', 'specialty', 'agent_type', 'agentType'])
      ? { domain: readString(record, ['domain', 'specialty', 'agent_type', 'agentType']) }
      : {}),
    ...(readString(record, ['currentTask', 'current_task', 'task', 'activity'])
      ? { owner: readString(record, ['currentTask', 'current_task', 'task', 'activity']) }
      : {}),
    ...(readString(record, ['workstream', 'workstream_title', 'workstreamTitle'])
      ? { parentId: readString(record, ['workstream', 'workstream_title', 'workstreamTitle']) }
      : {}),
    ...(readString(record, ['startedAt', 'started_at'])
      ? { startedAt: readString(record, ['startedAt', 'started_at']) }
      : {}),
    ...(readString(record, ['updatedAt', 'updated_at', 'lastHeartbeatAt'])
      ? { updatedAt: readString(record, ['updatedAt', 'updated_at', 'lastHeartbeatAt']) }
      : {}),
    ...(blockers.length ? { blockers } : {}),
  };
}

function nodeFromWorkstream(raw: unknown, index: number, parentId?: string): WorkNode | null {
  const record = asRecord(raw);
  const title = readString(record, ['name', 'title', 'label']) ?? `Workstream ${index + 1}`;
  const id = readString(record, ['id', 'workstream_id', 'workstreamId']) ?? title;
  const blockers = readBlockers(record);
  const status = readString(record, ['status', 'state', 'phase']);

  return {
    id,
    title,
    kind: 'workstream',
    phase: resolvePhase(status, blockers),
    ...(status ? { status } : {}),
    ...(readNumber(record, ['progress', 'percent', 'pct']) !== undefined
      ? { progress: readNumber(record, ['progress', 'percent', 'pct']) }
      : {}),
    ...(readString(record, ['domain', 'track'])
      ? { domain: readString(record, ['domain', 'track']) }
      : {}),
    ...(readString(record, ['owner', 'assignee', 'agent'])
      ? { owner: readString(record, ['owner', 'assignee', 'agent']) }
      : {}),
    ...(parentId ? { parentId } : {}),
    ...(readArray(record, ['depends_on', 'dependsOn', 'dependencies']).length
      ? {
          dependsOn: readArray(record, ['depends_on', 'dependsOn', 'dependencies'])
            .map((value) => (typeof value === 'string' ? value : ''))
            .filter(Boolean),
        }
      : {}),
    ...(blockers.length ? { blockers } : {}),
  };
}

function nodeFromDecision(raw: unknown, index: number): WorkNode | null {
  const record = asRecord(raw);
  const id = readString(record, ['id', 'decision_id', 'decisionId']) ?? `decision-${index}`;
  const title =
    readString(record, ['title', 'question', 'summary', 'decision']) ?? 'Decision';
  const status = readString(record, ['status', 'state', 'resolution']);
  // A decision awaiting a human IS a blocker, and should read as one rather
  // than as a queued item nobody needs to look at.
  const pending = !status || /pending|open|awaiting/i.test(status);
  const blockers = pending
    ? [{ reason: 'Awaiting your approval', actionable: true, resolveTool: 'orgx_decide' }]
    : readBlockers(record);

  return {
    id,
    title,
    kind: 'decision',
    phase: resolvePhase(status, blockers),
    ...(status ? { status } : {}),
    ...(readString(record, ['requested_by', 'requestedBy', 'owner'])
      ? { owner: readString(record, ['requested_by', 'requestedBy', 'owner']) }
      : {}),
    ...(readString(record, ['created_at', 'createdAt'])
      ? { startedAt: readString(record, ['created_at', 'createdAt']) }
      : {}),
    ...(blockers.length ? { blockers } : {}),
  };
}

function compact<T>(values: (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

export const FEEDS: Record<string, FeedDefinition> = {
  'agent-status': {
    type: 'agent-status',
    label: 'Agent status',
    cadence: RESPONSIVE,
    buildUrl: (feedId, apiBase) =>
      `${apiBase}/api/live/agents?initiative=${encodeURIComponent(feedId)}`,
    normalize(raw, feedId) {
      const record = asRecord(raw);
      const agents = readArray(record, ['agents', 'data', 'items']);
      const handoff = readProofHandoff(record, ...agents);
      return buildWorkGraph({
        feedType: 'agent-status',
        feedId,
        nodes: compact(agents.map(nodeFromAgent)),
        ...(handoff ? { proofHandoff: handoff } : {}),
        ...(readString(record, ['title', 'initiative_title']) !== undefined
          ? { title: readString(record, ['title', 'initiative_title']) }
          : {}),
      });
    },
  },

  'initiative-pulse': {
    type: 'initiative-pulse',
    label: 'Initiative pulse',
    cadence: RESPONSIVE,
    buildUrl: (feedId, apiBase) =>
      `${apiBase}/api/live/initiatives?id=${encodeURIComponent(feedId)}`,
    normalize(raw, feedId) {
      const record = asRecord(raw);
      const initiatives = readArray(record, ['initiatives', 'data', 'items']);
      const primary = asRecord(initiatives[0] ?? record.initiative ?? record);
      const initiativeId =
        readString(primary, ['id', 'initiative_id', 'initiativeId']) ?? feedId;

      const nodes: WorkNode[] = [];
      const workstreams = readArray(primary, ['workstreams', 'streams', 'tracks']);
      for (let index = 0; index < workstreams.length; index += 1) {
        const node = nodeFromWorkstream(workstreams[index], index, initiativeId);
        if (node) nodes.push(node);
      }

      // The initiative itself is a node so the widget can render one tree rather
      // than a header plus a disconnected list.
      const initiativeBlockers = readBlockers(primary);
      const initiativeStatus = readString(primary, ['status', 'state']);
      nodes.unshift({
        id: initiativeId,
        title: readString(primary, ['title', 'name']) ?? 'Initiative',
        kind: 'initiative',
        phase: resolvePhase(initiativeStatus, initiativeBlockers),
        ...(initiativeStatus ? { status: initiativeStatus } : {}),
        ...(readNumber(primary, ['progress', 'percent']) !== undefined
          ? { progress: readNumber(primary, ['progress', 'percent']) }
          : {}),
        ...(initiativeBlockers.length ? { blockers: initiativeBlockers } : {}),
      });

      const handoff = readProofHandoff(record, primary);
      return buildWorkGraph({
        feedType: 'initiative-pulse',
        feedId,
        nodes,
        ...(handoff ? { proofHandoff: handoff } : {}),
        ...(readString(primary, ['title', 'name']) !== undefined
          ? { title: readString(primary, ['title', 'name']) }
          : {}),
        ...(readString(primary, ['updated_at', 'updatedAt']) !== undefined
          ? { updatedAt: readString(primary, ['updated_at', 'updatedAt']) }
          : {}),
      });
    },
  },

};

// ── Not yet shipped ─────────────────────────────────────────────────────────
// `decisions` and `execution-room` are deliberately absent from FEEDS.
//
// LiveFeedDO polls with ORGX_SERVICE_KEY, and neither upstream accepts it:
//   - There is no GET /api/live/decisions at all — only .../decisions/approve.
//     The queue is served by /api/decisions, which authenticates through
//     getUserContext() (a Clerk user session).
//   - GET /api/live/execution-room exists but gates on hasViewerAuthSignal(),
//     i.e. a Clerk bearer token or session cookie.
//
// Registering them anyway would mean a widget subscribing to a feed that 404s or
// 401s on its first poll. Adding them needs a service-key-authenticated read on
// the OrgX side (lib/server/cronAuth.ts already recognizes the x-orgx-service-key
// header that the DO sends); `nodeFromDecision` below is kept ready for that.

export const FEED_TYPES = Object.keys(FEEDS);

/** Route pattern for the auth handler, derived so it cannot drift from FEEDS. */
export const FEED_ROUTE_PATTERN = new RegExp(
  `^/live-feed/(${FEED_TYPES.map((type) => type.replace(/[-]/g, '\\-')).join('|')})/([^/]+)/stream$`
);

export function getFeed(type: string): FeedDefinition | null {
  return Object.prototype.hasOwnProperty.call(FEEDS, type) ? FEEDS[type]! : null;
}

/**
 * Pick the next poll delay from the graph itself. Executing work earns the fast
 * cadence; a graph that is entirely resting does not.
 */
export function cadenceFor(feed: FeedDefinition, graph: WorkGraph | null): number {
  if (!graph) return feed.cadence.activeMs;
  const active = graph.summary.running > 0;
  // Blocked work still gets the fast cadence: a human may clear it at any
  // moment and the unblock is the transition most worth seeing promptly.
  const blocked = graph.summary.blocked > 0;
  return active || blocked ? feed.cadence.activeMs : feed.cadence.idleMs;
}
