/**
 * One entity, drawn as one card: the shape `orgx_inspect` returns as `card`
 * and the entity-card widget renders. Work that can carry proof
 * (initiatives, milestones, workstreams, tasks, artifacts) also gets a proof
 * record with the same rows, markers and verdicts as the web app's
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

/** The verdict a status implies, on the same four values the app uses. */
export function proofVerdictForStatus(status: string | null): ProofVerdict {
  const value = (status ?? '').toLowerCase();
  if (['completed', 'complete', 'done', 'approved', 'accepted', 'shipped', 'published'].includes(value)) {
    return 'accepted';
  }
  if (['in_review', 'review', 'submitted', 'verifying', 'pending_review'].includes(value)) {
    return 'verifying';
  }
  if (['blocked', 'needs_input', 'needs_you', 'awaiting_approval', 'pending_approval'].includes(value)) {
    return 'needs-you';
  }
  return 'open';
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
  if (typeof entity.progress === 'number') {
    const pct = entity.progress <= 1 ? entity.progress * 100 : entity.progress;
    facts.push({ label: 'Progress', value: `${Math.round(pct)}%` });
  }
  const updated = text(entity.updated_at);
  if (updated) facts.push({ label: 'Updated', value: updated.slice(0, 10) });

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
    if (decisions) rows.push({ label: 'Decisions', value: String(decisions), kind: 'decision' });
    if (artifacts) rows.push({ label: 'Artifacts', value: String(artifacts), kind: 'artifact' });
    if (checks) rows.push({ label: 'Checks', value: String(checks), kind: 'check' });
    if (blockers) rows.push({ label: 'Open blockers', value: String(blockers), kind: 'neutral' });
    if (rows.length > 0) {
      proof = {
        // Open blockers keep work out of "accepted" whatever its status says.
        verdict: blockers && proofVerdictForStatus(status) === 'accepted'
          ? 'needs-you'
          : proofVerdictForStatus(status),
        rows,
      };
    }
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
