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
  /** Always sent: it is small, and it is what the widget headers with. */
  summary: WorkSummary;
  headline?: string;
  title?: string;
  updatedAt: string;
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
    if (previousBlockers[index]?.reason !== nextBlockers[index]?.reason) return true;
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

  const summaryChanged =
    !previous ||
    previous.summary.running !== next.summary.running ||
    previous.summary.queued !== next.summary.queued ||
    previous.summary.blocked !== next.summary.blocked ||
    previous.summary.done !== next.summary.done ||
    previous.summary.total !== next.summary.total ||
    previous.summary.progress !== next.summary.progress ||
    previous.headline !== next.headline;

  if (changed.length === 0 && removed.length === 0 && !summaryChanged) {
    return null;
  }

  return {
    feedType: next.feedType,
    feedId: next.feedId,
    changed,
    removed,
    summary: next.summary,
    ...(next.headline ? { headline: next.headline } : {}),
    ...(next.title ? { title: next.title } : {}),
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
  const order: string[] = [];
  for (const node of base.nodes) {
    byId.set(node.id, node);
    order.push(node.id);
  }
  for (const node of delta.changed) {
    if (!byId.has(node.id)) order.push(node.id);
    byId.set(node.id, node);
  }
  for (const id of delta.removed) {
    byId.delete(id);
  }

  return {
    ...base,
    nodes: order.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
    summary: delta.summary,
    ...(delta.headline ? { headline: delta.headline } : { headline: undefined }),
    updatedAt: delta.updatedAt,
  };
}
