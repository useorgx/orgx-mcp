/**
 * The OrgX panel's Outputs and Goals views (orgx_panel_snapshot views
 * "outputs" and "goals").
 *
 * Outputs reuse the artifact read every snapshot already makes; Goals read
 * GET /api/v1/objectives/progress. Both say only what OrgX recorded: a stage
 * of an output's chain (made, accepted, landed, moved) is present only when
 * its timestamp or link is on the record, a goal's history is the values
 * OrgX logged for it, and a read that failed is "unavailable", never empty.
 */
import { buildEntityLink } from './deepLinks';
import { normalizeArtifactRecord } from './widgetArtifactProof';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function clip(value: unknown, max: number): string | null {
  const text = str(value);
  if (!text) return null;
  const chars = Array.from(text.replace(/[ \t]+/g, ' '));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}
function finite(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function iso(value: unknown): string | null {
  const text = str(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}
function https(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const PANEL_OUTPUT_LIMIT = 50;
export const PANEL_OUTPUT_PREVIEW_MAX = 900;
export const PANEL_OUTPUT_CHECK_LIMIT = 12;

/** The four families the panel filters by; "other" is everything it cannot place. */
export type PanelOutputFamily = 'code' | 'writing' | 'media' | 'routine' | 'other';

const FAMILY_PATTERNS: Array<[PanelOutputFamily, RegExp]> = [
  ['code', /(code|pull_?request|^pr$|diff|commit|patch|dataset|data|sql|query|notebook|pipeline|schema|migration|script|api|test)/i],
  ['media', /(image|video|design|mockup|figma|screenshot|illustration|logo|banner|thumbnail|audio|podcast)/i],
  ['routine', /(routine|playbook|runbook|workflow|automation|schedule|cron|sequence|cadence)/i],
  ['writing', /(doc|document|prd|rfc|brief|post|blog|email|copy|article|social|tweet|thread|newsletter|report|memo|summary|plan|spec|faq|markdown|landing|script)/i],
];

export function outputFamily(type: string | null): PanelOutputFamily {
  if (!type) return 'other';
  for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(type)) return family;
  return 'other';
}

export type PanelOutputAcceptance = 'accepted' | 'waiting' | 'sent_back' | 'not_reviewed' | 'unknown';

export interface PanelOutput {
  id: string;
  title: string;
  /** The artifact type as OrgX names it ("pull_request", "blog_post"). */
  type: string | null;
  family: PanelOutputFamily;
  status: string;
  /**
   * Whether OrgX recorded a summary or preview for it. The text itself never
   * enters the snapshot (the model reads it); it travels to the panel alone
   * in the result's _meta (PANEL_PREVIEW_META_KEY).
   */
  has_preview: boolean;
  /** The output itself outside OrgX (a PR, a doc), https only. */
  external_url: string | null;
  initiative_id: string | null;
  task_id: string | null;
  made_at: string | null;
  made_by: string | null;
  accepted: { state: PanelOutputAcceptance; at: string | null; by: 'you' | 'workspace_member' | null };
  /** Merged, deployed or published, only when the record carries the time. */
  landed: { label: string; at: string } | null;
  /** A goal it moved, only when the record names the goal and the change. */
  moved: { objective_id: string | null; label: string } | null;
  /** The output's own checks (verification.criteria_checklist), met or not. */
  checks: Array<{ label: string; met: boolean }>;
  /** Where the checks came from, when the record names it (a quality bar). */
  checks_source: string | null;
  eval_score: number | null;
  /** The pending decision about this output, so it can be reviewed here. */
  decision_id: string | null;
  url: string;
}

export interface PanelOutputs {
  status: 'ok' | 'unavailable';
  items: PanelOutput[];
  total: number;
}

/** Widget-only: what each output says, for the panel's preview. Never in structuredContent. */
export const PANEL_PREVIEW_META_KEY = 'orgx/panelPreviews';
export interface PanelOutputPreview {
  summary: string | null;
  preview: string | null;
  /** Authenticated detail read only, never artifact metadata. */
  frontDoor?: import('./outputFrontDoor').ArtifactOutputFrontDoor;
}

const LANDED_KEYS: Array<[string, string]> = [
  ['merged_at', 'Merged'],
  ['deployed_at', 'Deployed'],
  ['published_at', 'Published'],
  ['shipped_at', 'Shipped'],
  ['landed_at', 'Landed'],
];

function acceptanceOf(
  record: Record<string, unknown>,
  status: string,
  viewerIds: ReadonlySet<string>
): PanelOutput['accepted'] {
  const s = status.toLowerCase();
  if (s === 'approved' || s === 'accepted') {
    if (!Object.prototype.hasOwnProperty.call(record, 'approved_by_user_id')) return { state: 'unknown', at: null, by: null };
    const approver = str(record.approved_by_user_id);
    if (!approver || approver.toLowerCase().startsWith('system:')) return { state: 'unknown', at: null, by: null };
    return { state: 'accepted', at: iso(record.approved_at) ?? iso(record.updated_at), by: viewerIds.has(approver) ? 'you' : 'workspace_member' };
  }
  if (s === 'in_review' || s === 'eval_passed' || s === 'pending_review') return { state: 'waiting', at: null, by: null };
  if (s === 'rejected' || s === 'changes_requested' || s === 'declined') return { state: 'sent_back', at: iso(record.updated_at), by: null };
  return { state: 'not_reviewed', at: null, by: null };
}

function checksOf(verification: Record<string, unknown> | null): PanelOutput['checks'] {
  const checklist = asRecord(verification?.criteria_checklist);
  if (checklist) {
    return Object.entries(checklist)
      .filter(([label, met]) => label.trim() && typeof met === 'boolean')
      .slice(0, PANEL_OUTPUT_CHECK_LIMIT)
      .map(([label, met]) => ({ label: clip(label, 160) ?? label, met: met as boolean }));
  }
  const self = asRecord(verification?.self_check);
  const met = Array.isArray(self?.criteria_met) ? self!.criteria_met : [];
  const unmet = Array.isArray(self?.criteria_unmet) ? self!.criteria_unmet : [];
  return [
    ...met.map((label) => ({ label: clip(label, 160), met: true })),
    ...unmet.map((label) => ({ label: clip(label, 160), met: false })),
  ]
    .filter((c): c is { label: string; met: boolean } => Boolean(c.label))
    .slice(0, PANEL_OUTPUT_CHECK_LIMIT);
}

/**
 * The Outputs view from the snapshot's artifact read. `decisionByArtifact`
 * joins a pending decision to the output it is about, so the output can be
 * reviewed with the same decision (and the same single-use token).
 */
export function buildPanelOutputs(
  records: unknown[] | null,
  options: { viewerIds: ReadonlyArray<string | null | undefined>; decisionByArtifact?: ReadonlyMap<string, string> }
): { outputs: PanelOutputs; previews: Record<string, PanelOutputPreview> } {
  const previews: Record<string, PanelOutputPreview> = {};
  if (!records) return { outputs: { status: 'unavailable', items: [], total: 0 }, previews };
  const viewerIds = new Set(options.viewerIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
  const items: PanelOutput[] = [];
  for (const raw of records) {
    const record = asRecord(raw);
    const n = record ? normalizeArtifactRecord(record) : null;
    if (!record || !n?.id || !UUID_RE.test(n.id)) continue;
    if (typeof record.superseded_by === 'string' && record.superseded_by) continue;
    const metadata = asRecord(n.metadata) ?? {};
    const verification = asRecord(n.verification ?? null);
    const type = clip(n.artifact_type, 40);
    const landedKey = LANDED_KEYS.find(([key]) => iso(metadata[key]) || iso(record[key]));
    const moved = asRecord(metadata.goal_impact);
    const movedLabel = clip(moved?.label ?? moved?.summary, 120);
    const initiativeId = str(n.initiative_id) ?? (n.entity_type === 'initiative' ? str(n.entity_id) : null);
    const said = { summary: clip(n.summary, 280), preview: clip(n.preview_markdown, PANEL_OUTPUT_PREVIEW_MAX) };
    if (said.summary || said.preview) previews[n.id] = said;
    items.push({
      id: n.id,
      title: clip(n.title, 160) ?? 'Untitled output',
      type,
      family: outputFamily(type),
      status: n.status,
      has_preview: Boolean(said.summary || said.preview),
      external_url: https(n.primary_url) ?? https(n.artifact_url),
      initiative_id: initiativeId && UUID_RE.test(initiativeId) ? initiativeId : null,
      task_id: str(n.task_id),
      made_at: iso(n.created_at),
      made_by: clip(n.created_by_name, 60),
      accepted: acceptanceOf(record, n.status, viewerIds),
      landed: landedKey ? { label: landedKey[1], at: (iso(metadata[landedKey[0]]) ?? iso(record[landedKey[0]]))! } : null,
      moved: moved && movedLabel ? { objective_id: str(moved.objective_id), label: movedLabel } : null,
      checks: checksOf(verification),
      checks_source: clip(asRecord(verification?.quality_bar)?.name ?? verification?.quality_bar_name, 80),
      eval_score: finite(n.eval_score),
      decision_id: options.decisionByArtifact?.get(n.id) ?? null,
      url: buildEntityLink('artifact', n.id).url,
    });
  }
  items.sort((a, b) => Date.parse(b.made_at ?? '') - Date.parse(a.made_at ?? '') || 0);
  const shown = items.slice(0, PANEL_OUTPUT_LIMIT);
  const kept: Record<string, PanelOutputPreview> = {};
  for (const item of shown) if (previews[item.id]) kept[item.id] = previews[item.id]!;
  return { outputs: { status: 'ok', items: shown, total: items.length }, previews: kept };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export const PANEL_GOAL_LIMIT = 20;
export const PANEL_GOAL_HISTORY_LIMIT = 60;

export interface PanelGoalInitiative {
  id: string;
  title: string;
  status: string | null;
  risk: string | null;
  milestones_total: number;
  milestones_done: number;
  url: string;
}

export interface PanelGoalMove {
  at: string;
  from: number;
  to: number;
  delta: number;
  /** Whether OrgX recorded why it moved; the words travel in _meta only (PANEL_GOAL_REASONS_META_KEY). */
  has_reason: boolean;
  decision_id: string | null;
}

/**
 * Widget-only: why each recorded move happened, keyed by goal id, in the
 * order of that goal's moves (null where none was recorded). The reasons are
 * free text an agent or person wrote, so they never enter structuredContent.
 */
export const PANEL_GOAL_REASONS_META_KEY = 'orgx/panelGoalReasons';
export type PanelGoalReasons = Record<string, Array<string | null>>;

export interface PanelGoal {
  id: string;
  title: string;
  status: string | null;
  unit: string | null;
  /** The goal's timeframe as written ("2026-12-31", "Q4 2026"). */
  due: string | null;
  target: number | null;
  current: number | null;
  baseline: number | null;
  history: Array<{ at: string; value: number }>;
  moves: PanelGoalMove[];
  initiatives: PanelGoalInitiative[];
  initiative_total: number;
  /**
   * What the goal needs a week to land on its due date, as OrgX computed it
   * from the recorded baseline, target and due date; null when one is missing.
   */
  pace: PanelGoalPace | null;
  url: string;
}

export interface PanelGoalPace {
  per_week: number;
  direction: 'up' | 'down';
  remaining: number;
  weeks_left: number;
}

export interface PanelQualityBarSummary {
  id: string;
  name: string;
  domain: string;
  criteria: number;
}

export interface PanelGoals {
  status: 'ok' | 'unavailable';
  items: PanelGoal[];
  total: number;
  /** Active initiatives that count toward no goal. */
  unlinked: PanelGoalInitiative[];
  unlinked_total: number;
  /** The workspace's quality bars; null when they could not be read. */
  quality_bars: PanelQualityBarSummary[] | null;
  reason?: string | null;
}

function count(value: unknown): number {
  const n = finite(value);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
}

function goalPace(value: unknown): PanelGoalPace | null {
  const pace = asRecord(value);
  const perWeek = finite(pace?.per_week);
  const remaining = finite(pace?.remaining);
  const weeksLeft = finite(pace?.weeks_left);
  const direction = pace?.direction === 'up' || pace?.direction === 'down' ? pace.direction : null;
  if (perWeek === null || perWeek <= 0 || remaining === null || remaining <= 0 || weeksLeft === null || weeksLeft <= 0 || !direction) return null;
  return { per_week: perWeek, direction, remaining, weeks_left: weeksLeft };
}

function goalInitiative(raw: unknown): PanelGoalInitiative | null {
  const record = asRecord(raw);
  const id = str(record?.id);
  if (!record || !id || !UUID_RE.test(id)) return null;
  return {
    id,
    title: clip(record.title, 160) ?? 'Untitled initiative',
    status: clip(record.status, 24),
    risk: clip(record.risk_level, 24),
    milestones_total: count(record.milestones_total),
    milestones_done: Math.min(count(record.milestones_done), count(record.milestones_total)),
    url: buildEntityLink('initiative', id).url,
  };
}

/** The Goals view from GET /api/v1/objectives/progress (its `data`), or unavailable. */
export function buildPanelGoals(payload: unknown, reason: string | null = null): PanelGoals {
  return buildPanelGoalsWithReasons(payload, reason).goals;
}

/** The Goals view plus the widget-only reasons behind each move. */
export function buildPanelGoalsWithReasons(payload: unknown, reason: string | null = null): { goals: PanelGoals; reasons: PanelGoalReasons } {
  const reasons: PanelGoalReasons = {};
  const data = asRecord(asRecord(payload)?.data) ?? asRecord(payload);
  if (!data || !Array.isArray(data.objectives)) {
    return { goals: { status: 'unavailable', items: [], total: 0, unlinked: [], unlinked_total: 0, quality_bars: null, reason: reason ?? 'OrgX did not return goals.' }, reasons };
  }
  const items: PanelGoal[] = [];
  for (const raw of data.objectives) {
    const o = asRecord(raw);
    const id = str(o?.id);
    if (!o || !id || !UUID_RE.test(id)) continue;
    const history = (Array.isArray(o.history) ? o.history : [])
      .map(asRecord)
      .flatMap((p) => {
        const at = iso(p?.at);
        const value = finite(p?.value);
        return at && value !== null ? [{ at, value }] : [];
      })
      .slice(-PANEL_GOAL_HISTORY_LIMIT);
    const said: Array<string | null> = [];
    const moves = (Array.isArray(o.moves) ? o.moves : [])
      .map(asRecord)
      .flatMap((m): PanelGoalMove[] => {
        const at = iso(m?.at);
        const from = finite(m?.from);
        const to = finite(m?.to);
        if (!m || !at || from === null || to === null) return [];
        const why = clip(m.rationale ?? m.reason, 200);
        said.push(why);
        return [{ at, from, to, delta: Math.round((to - from) * 1000) / 1000, has_reason: Boolean(why), decision_id: str(m.decision_id) }];
      })
      .slice(0, 5);
    if (said.slice(0, 5).some(Boolean)) reasons[id] = said.slice(0, 5);
    const initiatives = (Array.isArray(o.initiatives) ? o.initiatives : [])
      .map(goalInitiative)
      .filter((i): i is PanelGoalInitiative => Boolean(i));
    items.push({
      id,
      title: clip(o.title, 160) ?? 'Untitled goal',
      status: clip(o.status, 24),
      unit: clip(o.unit, 24),
      due: clip(o.timeframe, 40),
      target: finite(o.target_value),
      current: finite(o.current_value),
      baseline: finite(o.baseline_value),
      history,
      moves,
      initiatives,
      initiative_total: Math.max(initiatives.length, count(o.initiative_total)),
      pace: goalPace(o.pace),
      url: buildEntityLink('objective', id).url,
    });
    if (items.length >= PANEL_GOAL_LIMIT) break;
  }
  const unlinked = (Array.isArray(data.unlinked_initiatives) ? data.unlinked_initiatives : [])
    .map(goalInitiative)
    .filter((i): i is PanelGoalInitiative => Boolean(i));
  const bars = Array.isArray(data.quality_bars)
    ? data.quality_bars
        .map(asRecord)
        .flatMap((b): PanelQualityBarSummary[] => {
          const id = str(b?.id);
          const name = clip(b?.name, 80);
          return b && id && name ? [{ id, name, domain: clip(b.domain, 40) ?? '', criteria: count(b.criteria) }] : [];
        })
        .slice(0, 12)
    : null;
  return {
    goals: {
      status: 'ok',
      items,
      total: Math.max(items.length, count(data.objective_total)),
      unlinked,
      unlinked_total: Math.max(unlinked.length, count(data.unlinked_total)),
      quality_bars: bars,
    },
    reasons,
  };
}

/** Why the goals read failed, in the panel's words. */
export function goalsFailure(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404) return 'This OrgX workspace cannot report goal progress yet.';
  if (status === 401 || status === 403) return 'This account cannot read goals in this workspace.';
  return 'Goals could not be read right now.';
}
