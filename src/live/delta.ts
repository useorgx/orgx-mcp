/**
 * delta.ts — row-level diffing for live feeds.
 *
 * The old DO compared whole snapshots with `JSON.stringify(a) !== JSON.stringify(b)`
 * and, on any difference, pushed the entire payload to every client. For an
 * initiative with sixty agents that meant re-sending sixty rows because one
 * progress number moved from 41 to 42 — on every 10s tick, to every connected
 * widget.
 *
 * Diffing per node lets the DO send only what moved. The client already
 * reconciles by key, so a delta carrying three changed nodes patches exactly
 * three rows.
 */

import type { WorkGraph, WorkNode, WorkSummary } from './workGraph';

export interface WorkGraphDelta {
  feedType: string;
  feedId: string;
  /** Nodes added or changed since the previous graph. */
  changed: WorkNode[];
  /** Ids of nodes that are no longer present. */
  removed: string[];
  /**
   * The server's node order, in full.
   *
   * Without it a delta cannot express a reordering at all: swapping two rows
   * changes no node's fields, so nothing was sent, and a node prepended
   * upstream was appended by the client. Ids are cheap next to the nodes.
   */
  order: string[];
  /** Always sent: it is small, and it is what the widget headers with. */
  summary: WorkSummary;
  headline?: string;
  title?: string;
  updatedAt: string;
  /** Sent only when it changed; the client keeps its held value otherwise. */
  proofHandoff?: { quiet_cta?: string };
}

/**
 * Field-wise comparison. A JSON.stringify compare would report a change on key
 * reordering, which upstream serializers do freely, and would flap the feed for
 * no user-visible reason.
 */
export function nodeChanged(previous: WorkNode | undefined, next: WorkNode): boolean {
  if (!previous) return true;
  if (
    previous.phase !== next.phase ||
    previous.status !== next.status ||
    previous.title !== next.title ||
    previous.progress !== next.progress ||
    previous.owner !== next.owner ||
    previous.domain !== next.domain ||
    previous.parentId !== next.parentId ||
    previous.updatedAt !== next.updatedAt
  ) {
    return true;
  }

  const previousBlockers = previous.blockers ?? [];
  const nextBlockers = next.blockers ?? [];
  if (previousBlockers.length !== nextBlockers.length) return true;
  for (let index = 0; index < nextBlockers.length; index += 1) {
    const before = previousBlockers[index];
    const after = nextBlockers[index];
    // Every field, not just `reason`: resolveTool drives whether the widget can
    // offer a one-click fix, and comparing the reason alone meant a blocker
    // gaining that affordance never reached the client. The DO advances
    // lastGraph regardless, so a missed field stays missed.
    if (
      before?.reason !== after?.reason ||
      before?.since !== after?.since ||
      before?.actionable !== after?.actionable ||
      before?.resolveTool !== after?.resolveTool
    ) {
      return true;
    }
  }

  const previousDeps = previous.dependsOn ?? [];
  const nextDeps = next.dependsOn ?? [];
  if (previousDeps.length !== nextDeps.length) return true;
  for (let index = 0; index < nextDeps.length; index += 1) {
    if (previousDeps[index] !== nextDeps[index]) return true;
  }

  const previousEvidence = previous.evidence ?? [];
  const nextEvidence = next.evidence ?? [];
  if (previousEvidence.length !== nextEvidence.length) return true;
  for (let index = 0; index < nextEvidence.length; index += 1) {
    if (
      previousEvidence[index]?.label !== nextEvidence[index]?.label ||
      previousEvidence[index]?.href !== nextEvidence[index]?.href
    ) {
      return true;
    }
  }

  // Fields a node may carry that this function does not name individually.
  if (previous.kind !== next.kind || previous.href !== next.href) return true;
  if (previous.startedAt !== next.startedAt) return true;

  return false;
}

export function diffGraphs(
  previous: WorkGraph | null,
  next: WorkGraph
): WorkGraphDelta | null {
  const previousById = new Map<string, WorkNode>();
  if (previous) {
    for (const node of previous.nodes) previousById.set(node.id, node);
  }

  const changed: WorkNode[] = [];
  const seen = new Set<string>();
  for (const node of next.nodes) {
    seen.add(node.id);
    if (nodeChanged(previousById.get(node.id), node)) changed.push(node);
  }

  const removed: string[] = [];
  for (const id of previousById.keys()) {
    if (!seen.has(id)) removed.push(id);
  }

  const previousOrder = previous ? previous.nodes.map((node) => node.id) : [];
  const nextOrder = next.nodes.map((node) => node.id);
  const orderChanged =
    previousOrder.length !== nextOrder.length ||
    previousOrder.some((id, index) => id !== nextOrder[index]);

  const summaryChanged =
    !previous ||
    previous.summary.running !== next.summary.running ||
    previous.summary.queued !== next.summary.queued ||
    previous.summary.blocked !== next.summary.blocked ||
    previous.summary.done !== next.summary.done ||
    previous.summary.total !== next.summary.total ||
    previous.summary.progress !== next.summary.progress ||
    previous.headline !== next.headline;

  const handoffChanged =
    (previous?.proofHandoff?.quiet_cta ?? null) !== (next.proofHandoff?.quiet_cta ?? null);

  if (
    changed.length === 0 &&
    removed.length === 0 &&
    !summaryChanged &&
    !orderChanged &&
    !handoffChanged
  ) {
    return null;
  }

  return {
    feedType: next.feedType,
    feedId: next.feedId,
    changed,
    removed,
    order: nextOrder,
    summary: next.summary,
    ...(next.headline ? { headline: next.headline } : {}),
    ...(next.title ? { title: next.title } : {}),
    ...(handoffChanged ? { proofHandoff: next.proofHandoff } : {}),
    updatedAt: next.updatedAt,
  };
}

/**
 * Apply a delta to a graph. Used by tests to prove a delta stream converges on
 * the same state a full snapshot would have produced — the property that makes
 * sending deltas safe.
 */
export function applyDelta(base: WorkGraph, delta: WorkGraphDelta): WorkGraph {
  const byId = new Map<string, WorkNode>();
  const fallbackOrder: string[] = [];
  for (const node of base.nodes) {
    byId.set(node.id, node);
    fallbackOrder.push(node.id);
  }
  for (const node of delta.changed) {
    if (!byId.has(node.id)) fallbackOrder.push(node.id);
    byId.set(node.id, node);
  }
  for (const id of delta.removed) {
    byId.delete(id);
  }

  // Prefer the server's order when the delta carries one; appending locally is
  // only a fallback for deltas produced before `order` existed.
  const order = delta.order && delta.order.length > 0 ? delta.order : fallbackOrder;

  return {
    ...base,
    nodes: order.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
    summary: delta.summary,
    ...(delta.headline ? { headline: delta.headline } : { headline: undefined }),
    updatedAt: delta.updatedAt,
  };
}
