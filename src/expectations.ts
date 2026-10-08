/**
 * "Done means": the bar OrgX and a person agree on before work starts.
 *
 * The OrgX app builds an expectation set for an initiative from named sources
 * (workspace rules, the kind of work, learned calls, checks suggested in chat,
 * and drafted checks that fill gaps), holds launch behind one decision of kind
 * `expectation_agreement`, and writes the agreed checks into every receipt's
 * `intent.criteria[]` with their source.
 *
 * This module only reads those shapes. It is tolerant on purpose: the app's
 * field names are matched with the aliases it is known to use, anything it
 * cannot read is dropped rather than guessed, and a set without checks is
 * no set at all. It never invents a check: the only checks it builds itself
 * are the ones a caller passed as `suggested_checks`, and those stay
 * marked "suggested".
 */

export const EXPECTATION_SOURCES = [
  'rule',
  'artifact_type',
  'learned',
  'suggested',
  'drafted',
] as const;
export type ExpectationSource = (typeof EXPECTATION_SOURCES)[number];

export const EXPECTATION_VERIFY_KINDS = [
  'command',
  'http',
  'artifact',
  'manual',
] as const;
export type ExpectationVerify = (typeof EXPECTATION_VERIFY_KINDS)[number];

export const EXPECTATION_SET_STATUSES = [
  'drafted',
  'agreed',
  'sent_back',
  'superseded',
] as const;
export type ExpectationSetStatus = (typeof EXPECTATION_SET_STATUSES)[number];

export type ExpectationScope = 'initiative' | 'workstream' | 'task';

/** The decision kind the app raises to hold launch until a person agrees. */
export const EXPECTATION_AGREEMENT_KIND = 'expectation_agreement';

export const EXPECTATION_STATEMENT_MAX = 500;
export const EXPECTATION_CHECK_LIMIT = 120;
/** Suggested checks one workstream or task may carry into the scaffold. */
export const SUGGESTED_CHECKS_PER_NODE = 20;

export interface ExpectationCheck {
  id: string | null;
  scope: ExpectationScope;
  scope_id: string | null;
  statement: string;
  verify: ExpectationVerify;
  required: boolean;
  source: ExpectationSource;
  source_ref: string | null;
  /** What the source is, in words, when the app names it ("your call on #3211"). */
  source_label: string | null;
  owner_agent: string | null;
  /** True when this check was not in the last bar agreed for this kind of work. */
  new_since_last: boolean;
}

export interface ExpectationSet {
  id: string | null;
  status: ExpectationSetStatus;
  version: string | null;
  initiative_id: string | null;
  decision_id: string | null;
  agreed_at: string | null;
  agreed_by: string | null;
  checks: ExpectationCheck[];
  /** How many checks the app sent beyond the ones kept here. */
  omitted_count: number;
  /**
   * `app` when OrgX built the set; `suggested` when only the caller's
   * suggested_checks are known (draft mode, or an app that predates the bar
   * builder). A suggested-only set is never presented as agreed.
   */
  origin: 'app' | 'suggested';
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const clip = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

const SOURCE_ALIASES: Record<string, ExpectationSource> = {
  rule: 'rule',
  rules: 'rule',
  policy: 'rule',
  workspace_rule: 'rule',
  org_policy: 'rule',
  artifact_type: 'artifact_type',
  kind_of_work: 'artifact_type',
  work_type: 'artifact_type',
  layer_stack: 'artifact_type',
  type: 'artifact_type',
  learned: 'learned',
  promoted: 'learned',
  promotion: 'learned',
  outcome_call: 'learned',
  suggested: 'suggested',
  suggestion: 'suggested',
  chat: 'suggested',
  client: 'suggested',
  drafted: 'drafted',
  drafter: 'drafted',
  draft: 'drafted',
  generated: 'drafted',
};

export function normalizeExpectationSource(value: unknown): ExpectationSource | null {
  const key = str(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  return key ? SOURCE_ALIASES[key] ?? null : null;
}

export function normalizeExpectationVerify(value: unknown): ExpectationVerify {
  const rec = asRec(value);
  const raw = str(rec ? rec.kind ?? rec.type : value)?.toLowerCase();
  if (raw === 'command' || raw === 'cmd' || raw === 'test' || raw === 'tests') return 'command';
  if (raw === 'http' || raw === 'url' || raw === 'probe') return 'http';
  if (raw === 'artifact' || raw === 'file' || raw === 'document') return 'artifact';
  return 'manual';
}

function normalizeStatus(value: unknown): ExpectationSetStatus {
  const raw = str(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'agreed' || raw === 'approved' || raw === 'accepted') return 'agreed';
  if (raw === 'sent_back' || raw === 'rejected' || raw === 'returned' || raw === 'declined') return 'sent_back';
  if (raw === 'superseded' || raw === 'replaced') return 'superseded';
  return 'drafted';
}

function normalizeScope(value: unknown): ExpectationScope {
  const raw = str(value)?.toLowerCase();
  return raw === 'workstream' || raw === 'task' ? raw : 'initiative';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return str(value);
}

/** One check as the app (or a caller) wrote it, or null when it has no statement or source. */
export function normalizeExpectationCheck(
  raw: unknown,
  fallbackSource: ExpectationSource | null = null
): ExpectationCheck | null {
  if (typeof raw === 'string') {
    if (!fallbackSource || !raw.trim()) return null;
    return normalizeExpectationCheck({ statement: raw }, fallbackSource);
  }
  const rec = asRec(raw);
  if (!rec) return null;
  const statement =
    str(rec.statement) ?? str(rec.text) ?? str(rec.check) ?? str(rec.description) ?? str(rec.title);
  const source = normalizeExpectationSource(rec.source ?? rec.source_kind ?? rec.origin) ?? fallbackSource;
  if (!statement || !source) return null;
  const learnedFrom = asRec(rec.learned_from);
  const sourceLabel =
    str(rec.source_label) ??
    str(rec.source_name) ??
    str(learnedFrom?.label) ??
    str(learnedFrom?.title) ??
    null;
  return {
    id: idString(rec.id),
    scope: normalizeScope(rec.scope),
    scope_id: idString(rec.scope_id ?? rec.scopeId),
    statement: clip(statement.replace(/\s+/g, ' '), EXPECTATION_STATEMENT_MAX),
    verify: normalizeExpectationVerify(rec.verify ?? rec.verify_kind ?? rec.verification),
    // Rules are always required; anything else is required only when the app says so.
    required: bool(rec.required, source === 'rule'),
    source,
    source_ref: idString(rec.source_ref ?? rec.sourceRef ?? learnedFrom?.id ?? learnedFrom?.receipt_id),
    source_label: sourceLabel ? clip(sourceLabel, 120) : null,
    owner_agent: str(rec.owner_agent) ?? str(rec.ownerAgent) ?? str(rec.owner) ?? null,
    new_since_last: rec.new_since_last === true || rec.is_new === true || rec.new === true,
  };
}

/**
 * The app's expectation set, wherever it arrived: `{checks:[...]}`, a bare
 * array of checks, or `{expectations: ...}` one level down. Null when there is
 * no check to show, or a disabled one is all there is.
 */
export function normalizeExpectationSet(raw: unknown): ExpectationSet | null {
  if (raw == null) return null;
  const rec = Array.isArray(raw) ? { checks: raw } : asRec(raw);
  if (!rec) return null;
  const nested = asRec(rec.expectations) ?? asRec(rec.expectation_set);
  if (nested && !Array.isArray(rec.checks)) return normalizeExpectationSet(nested);
  if (Array.isArray(rec.expectations) && !Array.isArray(rec.checks)) {
    return normalizeExpectationSet({ ...rec, checks: rec.expectations, expectations: undefined });
  }
  const list = Array.isArray(rec.checks) ? rec.checks : [];
  const all = list
    .filter((c) => asRec(c)?.enabled !== false)
    .map((c) => normalizeExpectationCheck(c))
    .filter((c): c is ExpectationCheck => Boolean(c));
  if (!all.length) return null;
  const checks = all.slice(0, EXPECTATION_CHECK_LIMIT);
  return {
    id: idString(rec.id ?? rec.set_id),
    status: normalizeStatus(rec.status),
    version: idString(rec.version),
    initiative_id: str(rec.initiative_id),
    decision_id: str(rec.decision_id) ?? str(asRec(rec.decision)?.id),
    agreed_at: str(rec.agreed_at),
    agreed_by: str(rec.agreed_by),
    checks,
    omitted_count: all.length - checks.length,
    origin: 'app',
  };
}

/** The first readable set among candidate payload locations. */
export function findExpectationSet(...candidates: unknown[]): ExpectationSet | null {
  for (const candidate of candidates) {
    const rec = asRec(candidate);
    const options = rec
      ? [rec.expectations, rec.expectation_set, asRec(rec.data)?.expectations, asRec(rec.metadata)?.expectations]
      : [candidate];
    for (const option of options) {
      const set = normalizeExpectationSet(option);
      if (set) return set;
    }
  }
  return null;
}

/** A caller's suggested_checks on one node, normalized; strings and objects both work. */
export function normalizeSuggestedChecks(value: unknown): Array<{
  statement: string;
  verify: ExpectationVerify;
  required: boolean;
}> {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: Array<{ statement: string; verify: ExpectationVerify; required: boolean }> = [];
  const seen = new Set<string>();
  for (const item of list) {
    const check = normalizeExpectationCheck(item, 'suggested');
    if (!check) continue;
    const key = check.statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ statement: check.statement, verify: check.verify, required: asRec(item)?.required === true });
    if (out.length >= SUGGESTED_CHECKS_PER_NODE) break;
  }
  return out;
}

/**
 * The suggested checks a scaffold batch carries (on workstream and task
 * metadata), as a set the widget can show before OrgX answers with its own.
 * scope_id is the created entity's id when the ref map has it, else the ref.
 */
export function suggestedExpectationSet(
  batch: Array<Record<string, unknown>>,
  refMap: Record<string, string> | undefined = undefined
): ExpectationSet | null {
  const checks: ExpectationCheck[] = [];
  for (const entity of batch) {
    const type = entity.type;
    if (type !== 'workstream' && type !== 'task') continue;
    const meta = asRec(entity.metadata);
    const suggested = Array.isArray(meta?.suggested_checks) ? meta!.suggested_checks : [];
    if (!suggested.length) continue;
    const ref = str(entity.ref);
    const owner = Array.isArray(entity.assigned_agent_ids) ? str(entity.assigned_agent_ids[0]) : null;
    for (const raw of suggested) {
      const check = normalizeExpectationCheck(raw, 'suggested');
      if (!check) continue;
      checks.push({
        ...check,
        scope: type,
        scope_id: (ref && refMap?.[ref]) || ref,
        owner_agent: check.owner_agent ?? owner,
      });
    }
  }
  if (!checks.length) return null;
  const kept = checks.slice(0, EXPECTATION_CHECK_LIMIT);
  return {
    id: null,
    status: 'drafted',
    version: null,
    initiative_id: null,
    decision_id: null,
    agreed_at: null,
    agreed_by: null,
    checks: kept,
    omitted_count: checks.length - kept.length,
    origin: 'suggested',
  };
}

/** True when a pending decision is the "Agree on done" decision. */
export function isExpectationAgreement(record: Record<string, unknown>): boolean {
  const context = asRec(record.context) ?? {};
  const packet = asRec(record.review_packet) ?? {};
  const candidates = [
    record.decision_kind,
    record.decision_type,
    record.kind,
    record.type,
    record.category,
    context.decision_kind,
    context.kind,
    packet.kind,
  ];
  return candidates.some((v) => str(v)?.toLowerCase() === EXPECTATION_AGREEMENT_KIND);
}

/** The set an expectation_agreement decision carries, wherever the app put it. */
export function expectationSetOfDecision(record: Record<string, unknown>): ExpectationSet | null {
  if (!isExpectationAgreement(record)) return null;
  const set = findExpectationSet(
    record,
    asRec(record.context),
    asRec(record.review_packet),
    asRec(record.metadata)
  );
  if (!set) return null;
  return { ...set, decision_id: set.decision_id ?? str(record.id) };
}

/**
 * A launch the app held for agreement: its 409 body (lifted from the API
 * error) names the decision and, usually, the set. Null for any other failure.
 */
export function heldLaunchOf(body: unknown): { decision_id: string | null; expectations: ExpectationSet | null } | null {
  const outer = asRec(body);
  // { error: { code, ... } } and { code, ... } are both how the app answers.
  const rec = outer && !str(outer.code) && asRec(outer.error)?.code ? { ...asRec(outer.error)!, ...outer } : outer;
  if (!rec) return null;
  const error = asRec(rec.error);
  const code = (str(rec.code) ?? str(error?.code) ?? str(rec.error_kind) ?? '').toLowerCase();
  const decision = asRec(rec.decision);
  const kind = str(decision?.kind) ?? str(decision?.decision_type) ?? str(rec.decision_kind);
  const held =
    code.includes('expectation') ||
    code === 'agreement_required' ||
    kind === EXPECTATION_AGREEMENT_KIND;
  if (!held) return null;
  const expectations = findExpectationSet(rec, asRec(rec.data), decision);
  const decisionId = str(rec.decision_id) ?? str(decision?.id) ?? expectations?.decision_id ?? null;
  return {
    decision_id: decisionId,
    expectations: expectations ? { ...expectations, decision_id: expectations.decision_id ?? decisionId } : null,
  };
}

/**
 * A launch error that is really a hold for agreement. The API error keeps the
 * body as text, clipped at 2 KB: a large set may not parse, so a 409 that names
 * the agreement still counts, with the decision id read from the text.
 */
export function heldLaunchFromError(
  error: unknown
): { decision_id: string | null; expectations: ExpectationSet | null } | null {
  const e = error as { internalDetails?: unknown; statusCode?: unknown } | null;
  const details = typeof e?.internalDetails === 'string' ? e.internalDetails : '';
  const start = details.indexOf('{');
  if (start !== -1) {
    try {
      const held = heldLaunchOf(JSON.parse(details.slice(start)));
      if (held) return held;
    } catch {
      // clipped body: fall through to the text
    }
  }
  if (e?.statusCode !== 409 || !/expectation/i.test(details)) return null;
  const id = /"decision_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(details)?.[1] ?? null;
  return { decision_id: id, expectations: null };
}

/**
 * The bar a scaffold result shows: OrgX's own when the launch answer or the
 * created initiative carries one, else the caller's suggested checks. A held
 * launch names the decision the set waits on.
 */
export function scaffoldExpectationSet(params: {
  followupExpectations?: ExpectationSet | null;
  results?: Array<{ success?: boolean; data?: unknown }>;
  batch: Array<Record<string, unknown>>;
  refMap?: Record<string, string>;
  launch?: { held_for_agreement?: boolean; decision_id?: string | null } | null;
}): ExpectationSet | null {
  const initiativeData = (params.results ?? [])
    .map((entry) => asRec(entry?.data))
    .find((data) => data && (data.type === 'initiative' || data.entity_type === 'initiative'));
  const set =
    params.followupExpectations ??
    findExpectationSet(initiativeData) ??
    suggestedExpectationSet(params.batch, params.refMap);
  if (!set) return null;
  const heldBy = params.launch?.held_for_agreement ? params.launch.decision_id ?? null : null;
  return heldBy && !set.decision_id ? { ...set, decision_id: heldBy } : set;
}

const SOURCE_WORDS: Record<ExpectationSource, [string, string]> = {
  rule: ['from your rules', 'from your rules'],
  artifact_type: ['from the kind of work', 'from the kind of work'],
  learned: ['learned from your past calls', 'learned from your past calls'],
  suggested: ['suggested in chat', 'suggested in chat'],
  drafted: ['drafted to fill a gap', 'drafted to fill gaps'],
};

/** "7 checks across 3 owners: 4 from your rules, 2 learned from your past calls, 1 new." */
export function describeExpectationSet(set: ExpectationSet): string {
  const total = set.checks.length + set.omitted_count;
  const owners = new Set(set.checks.map((c) => c.owner_agent).filter(Boolean)).size;
  const counts = new Map<ExpectationSource, number>();
  for (const check of set.checks) counts.set(check.source, (counts.get(check.source) ?? 0) + 1);
  const parts = EXPECTATION_SOURCES.filter((s) => counts.get(s)).map((s) => {
    const n = counts.get(s)!;
    return `${n} ${SOURCE_WORDS[s][n === 1 ? 0 : 1]}`;
  });
  const fresh = set.checks.filter((c) => c.new_since_last).length;
  if (fresh) parts.push(`${fresh} new since last time`);
  return `${total} check${total === 1 ? '' : 's'}${owners > 1 ? ` across ${owners} owners` : ''}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

/** The scaffold's plain-text line about the bar, for hosts that read text. */
export function expectationSummaryText(
  set: ExpectationSet | null,
  launch?: { held_for_agreement?: boolean } | null
): string {
  if (!set && !launch?.held_for_agreement) return '';
  const head = set ? `Done means: ${describeExpectationSet(set)}` : 'Done means: OrgX drafted the checks for this initiative.';
  const tail =
    set?.status === 'agreed'
      ? ' Agreed; every receipt is judged against it.'
      : set?.status === 'sent_back'
        ? ' Sent back; OrgX is redrafting it.'
        : launch?.held_for_agreement || set?.decision_id
          ? ' Waiting for you to agree in Needs you; agents start when you do.'
          : set?.origin === 'suggested'
            ? ' These are suggestions; OrgX asks you to agree on the full bar before work starts.'
            : ' OrgX asks you to agree on it before work starts.';
  return `\n\n${head}${tail}`;
}
