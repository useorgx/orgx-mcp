/**
 * One entity, drawn as one card: the shape `orgx_inspect` returns as `card`
 * and the entity-card widget renders. Work that can carry proof
 * also gets a proof record with the same rows, markers and verdicts as the web app's
 * ProofRecord (components/proof/ProofRecord.tsx in hopeatina/orgx), so an
 * agent, an operator, and a homepage visitor see one object.
 */

export type ProofVerdict = 'accepted' | 'verifying' | 'needs-you' | 'open';

export interface ProofRow {
  label: string;
  value: string;
  kind: 'decision' | 'artifact' | 'check' | 'neutral';
}

export interface EntityCard {
  type: string;
  id: string;
  title: string;
  status: string | null;
  summary: string | null;
  url: string | null;
  facts: Array<{ label: string; value: string }>;
  proof: { verdict: ProofVerdict; rows: ProofRow[] } | null;
  related: Array<{ type: string; title: string }>;
}

const DEFAULT_WEB_URL = 'https://useorgx.com';

/** Web app page for each entity type; null where no detail page exists. */
const WEB_PATHS: Record<string, (id: string) => string> = {
  initiative: (id) => `/initiatives/${id}`,
  milestone: (id) => `/milestones/${id}`,
  workstream: (id) => `/workstreams/${id}`,
  task: (id) => `/tasks/${id}`,
  decision: (id) => `/decisions/${id}`,
  artifact: (id) => `/artifacts/${id}`,
  run: (id) => `/runs/${id}`,
  objective: (id) => `/goals?objective=${encodeURIComponent(id)}`,
};

const PROOF_TYPES = new Set([
  'objective',
  'run',
  'initiative',
  'milestone',
  'workstream',
  'task',
  'artifact',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function entityWebUrl(
  type: string,
  id: string,
  webUrl?: string | null
): string | null {
  const path = WEB_PATHS[type];
  if (!path || !id) return null;
  let base: URL;
  try {
    base = new URL(webUrl || DEFAULT_WEB_URL);
  } catch {
    base = new URL(DEFAULT_WEB_URL);
  }
  return new URL(path(id), base).toString();
}

const FINISHED_STATUSES = new Set(['completed', 'complete', 'done', 'approved', 'accepted', 'shipped', 'published']);

/** Generic entity inspection returns lifecycle data and context, but no independent ruling. */
export function proofVerdictForStatus(status: string | null): ProofVerdict {
  const value = (status ?? '').trim().toLowerCase();
  if (['in_review', 'review', 'submitted', 'verifying', 'pending_review'].includes(value)) {
    return 'verifying';
  }
  if (['blocked', 'failed', 'rejected', 'needs_input', 'needs_you', 'awaiting_approval', 'pending_approval'].includes(value)) {
    return 'needs-you';
  }
  return 'open';
}

function recordedArtifactReview(value: unknown): string | null {
  const review = record(value);
  if (
    review?.reviewer_kind !== 'human' ||
    review.auto_approved !== false ||
    !text(review.reviewed_by) ||
    !Number.isFinite(Date.parse(text(review.reviewed_at) ?? ''))
  ) {
    return null;
  }
  switch (review.status) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    default:
      return null;
  }
}

export function buildEntityCard(params: {
  type: string;
  id: string;
  entity: unknown;
  contextPack?: unknown;
  webUrl?: string | null;
}): EntityCard {
  const entity = record(params.entity) ?? {};
  const pack = record(params.contextPack) ?? {};
  const frame = record(pack.frame) ?? {};
  const status = text(entity.status);

  const title =
    text(entity.title) ?? text(entity.name) ?? text(entity.summary) ?? `${params.type} ${params.id}`;
  const summary = text(entity.description) ?? text(entity.summary);

  const facts: EntityCard['facts'] = [];
  const owner = text(entity.owner_name) ?? text(entity.assignee_name) ?? text(entity.agent_name);
  if (owner) facts.push({ label: 'Owner', value: owner });
  const due = text(entity.due_date) ?? text(entity.target_date) ?? text(entity.due_at);
  if (due) facts.push({ label: 'Due', value: due.slice(0, 10) });
  if (params.type === 'initiative' || params.type === 'workstream') {
    // A persisted partial-progress rollup can include active work or a manual
    // update. It is not a completed-task tally. Native parent percentages use
    // 0..100, so 1 means 1%, not a fraction representing 100%.
    const continuity = record(entity.continuity);
    const taskProgress = record(continuity?.progress);
    const completed = taskProgress?.completed;
    const total = taskProgress?.total;
    const hasTaskTally =
      continuity?.version === 'initiative-continuity.v1' &&
      continuity.source === 'workstream_tasks' &&
      typeof completed === 'number' && Number.isSafeInteger(completed) &&
      typeof total === 'number' && Number.isSafeInteger(total) &&
      total > 0 && completed >= 0 && completed <= total;
    facts.push({
      label: 'Task completion',
      value: hasTaskTally
        ? `${completed} of ${total} tasks done (${Math.round((completed / total) * 100)}%)`
        : 'Not provided',
    });
    // Use only the inspected entity's admitted projection, never an enclosing
    // initiative's context pack or a partial list of descendant tasks.
    const storedProgress = params.type === 'initiative'
      ? entity.progress_pct ?? entity.progress
      : entity.progress;
    if (typeof storedProgress === 'number' && Number.isFinite(storedProgress) &&
        storedProgress >= 0 && storedProgress <= 100) {
      facts.push({ label: 'Recorded progress', value: `${Math.round(storedProgress)}%` });
    }
  } else if (typeof entity.progress === 'number') {
    const pct = entity.progress <= 1 ? entity.progress * 100 : entity.progress;
    facts.push({ label: 'Progress', value: `${Math.round(pct)}%` });
  }
  const updated = text(entity.updated_at);
  // The full timestamp: the card formats it in the viewer's zone. A UTC date
  // slice read as a local day could say "Tomorrow".
  if (updated) facts.push({ label: 'Updated', value: updated });

  let proof: EntityCard['proof'] = null;
  if (PROOF_TYPES.has(params.type)) {
    const decisions = list(pack.decisions).length;
    const artifacts =
      list(pack.artifacts).length ||
      list(record(frame.artifacts)?.produced).length ||
      (params.type === 'artifact' ? 1 : 0);
    const checks = Array.isArray(record(frame.definitionOfDone)?.checks)
      ? (record(frame.definitionOfDone)?.checks as unknown[]).length
      : 0;
    const blockers = list(pack.blockers).length || list(frame.blockers).length;
    const rows: ProofRow[] = [];
    const verification = record(entity.verification);
    const evaluation = record(verification?.eval);
    const evaluationStatus = text(evaluation?.status)?.toLowerCase();
    const failedEvaluation = evaluationStatus === 'failed' || evaluationStatus === 'rejected' ||
      (typeof evaluation?.score === 'number' && typeof evaluation?.threshold === 'number' && evaluation.score < evaluation.threshold);
    if (decisions) rows.push({ label: 'Decisions', value: String(decisions), kind: 'decision' });
    if (artifacts) rows.push({ label: 'Artifacts', value: String(artifacts), kind: 'artifact' });
    if (checks) rows.push({ label: 'Checklist items', value: String(checks), kind: 'check' });
    if (blockers) rows.push({ label: 'Open blockers', value: String(blockers), kind: 'neutral' });
    if (evaluationStatus || failedEvaluation) rows.push({
      label: 'Evaluation',
      value: failedEvaluation ? 'Failed' : evaluationStatus!,
      kind: 'check',
    });
    const review = params.type === 'artifact' ? recordedArtifactReview(verification?.human_review) : null;
    if (review) rows.push({ label: 'Recorded review', value: review, kind: 'neutral' });
    const verdict = failedEvaluation || blockers ? 'needs-you' : proofVerdictForStatus(status);
    const finished = FINISHED_STATUSES.has((status ?? '').toLowerCase());
    if (finished) {
      rows.push({ label: 'Acceptance', value: 'Unverified', kind: 'neutral' });
    }
    if (rows.length || verdict !== 'open') proof = { verdict, rows };
  }

  const related = [
    ...list(pack.decisions).map((item) => ({ type: 'decision', item })),
    ...list(pack.related).map((item) => ({ type: text(item.type) ?? 'related', item })),
  ]
    .map(({ type, item }) => ({
      type,
      title: text(item.title) ?? text(item.name) ?? text(item.choice) ?? '',
    }))
    .filter((item) => item.title)
    .slice(0, 5);

  return {
    type: params.type,
    id: params.id,
    title,
    status,
    summary,
    url: entityWebUrl(params.type, params.id, params.webUrl),
    facts,
    proof,
    related,
  };
}
