/**
 * OrgX panel — the ChatGPT sidebar (global) and thread entrypoint.
 *
 * One app-only tool, `orgx_panel_snapshot`, returns `orgx.panel.v1`: what
 * needs the owner's decision (at most three, most urgent first), the review
 * packet for one of them, and one line of accepted proof. The panel resource
 * (`ui://widget/orgx-panel.html`) renders it.
 *
 * Rules this module keeps (docs/design/devday-plugin-extensions.md §4.1 and
 * the coordinator decisions that override it):
 *
 * - Scope comes from the MCP session only. The tool has no workspace_id
 *   argument, and any injected one is ignored.
 * - It reads; it never changes session context, never mints a live grant and
 *   never writes model context. A ruling goes through `orgx_widget_decide`
 *   with a single-use approval token that travels in the result `_meta`
 *   (never in structuredContent), exactly like the decisions widget.
 * - Assume the model can see structuredContent: no tokens, evidence bodies,
 *   notes, emails or costs, and every title is clipped.
 * - "Accepted" comes from the app's acceptance ledger when the decisions read
 *   carries `proof` (a human accepted ruling on a work artifact). Older apps
 *   without it fall back to the artifact read: status `approved` AND a human
 *   `approved_by_user_id`. Either way, a proof that can't be read says
 *   `proof_unavailable` instead of guessing.
 *
 * Registration lives here; index.ts wires it with one call.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildEntityLink } from './deepLinks';
import { SECURITY_SCHEMES, WIDGET_URIS } from './toolDefinitions';
import {
  WIDGET_APPROVAL_META_KEY,
  splitWidgetApprovalMeta,
} from './widgetApprovalMeta';
import { normalizeArtifactRecord } from './widgetArtifactProof';

export const PANEL_SNAPSHOT_SCHEMA = 'orgx.panel.v1' as const;
export const PANEL_TOOL_ID = 'orgx_panel_snapshot' as const;

export const PANEL_QUEUE_LIMIT = 3;
export const PANEL_EVIDENCE_LIMIT = 5;
export const PANEL_TITLE_MAX = 160;
export const PANEL_QUESTION_MAX = 500;
export const PANEL_EVIDENCE_TITLE_MAX = 80;
export const PANEL_TEXT_MAX = 280;
/** Options the panel can render as buttons for one decision. */
export const PANEL_OPTION_LIMIT = 12;
export const PANEL_OPTION_LABEL_MAX = 80;
/** Pending decisions read per snapshot: enough to find a selected item. */
export const PANEL_DECISION_READ_LIMIT = 25;
export const PANEL_ARTIFACT_READ_LIMIT = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PANEL_FOCUS_SCHEMA = z
  .object({
    type: z.literal('decision').describe('Only decisions can be selected'),
    id: z.string().uuid().describe('Decision UUID'),
  })
  .strict();

/**
 * The tool contract. App-only (`ui.visibility: ["app"]`): hosts that honor
 * visibility never show it to the model; ChatGPT opens it from the sidebar
 * (global) and beside a conversation (thread).
 */
export const PANEL_SNAPSHOT_TOOL_CONTRACT = {
  id: PANEL_TOOL_ID,
  title: 'OrgX panel',
  description:
    'App-only: the OrgX panel in the ChatGPT sidebar and beside a conversation. Returns what needs your decision (at most three, most urgent first), the review packet for one of them, and the last output a person accepted. USE WHEN: the OrgX panel opens or refreshes. NEXT: the panel shows Approve and Send back when the decision can be settled there, otherwise it links to the decision in OrgX. DO NOT USE: from a model; models read decisions with orgx_search. Read-only.',
  inputSchema: {
    focus: PANEL_FOCUS_SCHEMA.optional().describe(
      'Optional decision to show as the review packet. Defaults to the most urgent pending decision.'
    ),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
} as const;

export const PANEL_TOOL_META = {
  ui: { resourceUri: WIDGET_URIS.orgxPanel, visibility: ['app'] as string[] },
  // Legacy alias for hosts that predate ui.visibility.
  'openai/visibility': 'private',
  'openai/widgetAccessible': true,
  'openai/ui': {
    entrypoints: [{ type: 'global' }, { type: 'thread' }],
  },
  'openai/toolInvocation/invoking': 'Opening OrgX...',
  'openai/toolInvocation/invoked': 'OrgX is open',
  'mcp/securitySchemes': SECURITY_SCHEMES.entityReadRequiresAuth,
} as const;

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export type PanelUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface PanelQueueItem {
  id: string;
  version: string;
  title: string;
  urgency: PanelUrgency;
  waiting_since: string | null;
  initiative_title: string | null;
  blocked: boolean;
  /** Present only when OrgX says this one has to be decided in the app. */
  decide_in_orgx_reason: string | null;
  /** How many options the server offers; a row with options opens the packet to choose. */
  option_count: number;
  url: string;
}

/** One option the person can pick, as the server sent it. */
export interface PanelOption {
  id: string;
  label: string;
}

/**
 * One action the pending list says the person can take here. The panel
 * renders these instead of deciding from the decision's type.
 */
export interface PanelWidgetAction {
  kind: 'approve' | 'reject' | 'option';
  label: string;
  option_id: string | null;
}

export interface PanelFocus {
  type: 'decision';
  id: string;
  version: string;
  question: string;
  urgency: PanelUrgency;
  waiting_since: string | null;
  initiative_title: string | null;
  recommendation: {
    status: 'ready' | 'unverified' | 'unavailable';
    action: string | null;
  } | null;
  evidence: Array<{ title: string; source_url: string | null }>;
  evidence_total: number;
  consequence_if_approved: string | null;
  consequence_if_rejected: string | null;
  blocked: boolean;
  decide_in_orgx_reason: string | null;
  /** The decision's options (buttons when there are two or more). */
  options: PanelOption[];
  /** True when the person may choose several options and confirm them together. */
  multiselect: boolean;
  /** The actions the server lists for this decision, when it lists them; preferred over options. */
  widget_actions: PanelWidgetAction[] | null;
  url: string;
}

export interface PanelSnapshot {
  schema: typeof PANEL_SNAPSHOT_SCHEMA;
  generated_at: string;
  state: 'ok' | 'no_workspace' | 'degraded';
  workspace: { id: string; name: string | null } | null;
  attention: { pending: number; oldest_at: string | null; blocking: boolean };
  queue: PanelQueueItem[];
  focus: PanelFocus | null;
  selection: {
    requested_id: string | null;
    status: 'default' | 'selected' | 'unavailable';
  };
  proof: {
    last_accepted: {
      artifact_id: string;
      title: string;
      accepted_at: string | null;
      accepted_by: 'you' | 'workspace_member';
      url: string;
    } | null;
    completed_unaccepted: number;
  };
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Clip on a code-point boundary and mark the cut with an ellipsis. */
export function clipText(value: unknown, max: number): string | null {
  const text = str(value);
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ');
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

function httpsUrlOrNull(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const URGENCY_RANK: Record<PanelUrgency, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function normalizeUrgency(value: unknown): PanelUrgency {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return slug === 'critical' || slug === 'high' || slug === 'low'
    ? slug
    : 'medium';
}

function timeOf(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

interface NormalizedDecision {
  id: string;
  version: string;
  title: string;
  question: string;
  urgency: PanelUrgency;
  createdAt: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  blocked: boolean;
  decideInOrgxReason: string | null;
  options: PanelOption[];
  multiselect: boolean;
  widgetActions: PanelWidgetAction[] | null;
  packet: Record<string, unknown> | null;
}

/** Options as the pending list carries them (strings or {id,label}). */
export function normalizePanelOptions(value: unknown): PanelOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: PanelOption[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const id =
      (record && (str(record.id) ?? str(record.option_id) ?? str(record.action_id))) ??
      `option-${index + 1}`;
    const label = clipText(
      record
        ? record.label ?? record.title ?? record.name ?? record.action
        : item,
      PANEL_OPTION_LABEL_MAX
    );
    if (!label || seen.has(id)) return;
    seen.add(id);
    options.push({ id, label });
  });
  return options.slice(0, PANEL_OPTION_LIMIT);
}

/** True when the payload marks the decision as choose-several. */
export function isPanelMultiselect(record: Record<string, unknown>): boolean {
  const mode = [record.selection, record.selection_mode, record.selectionMode, record.shape]
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .find(Boolean);
  return (
    record.multiselect === true ||
    record.multi_select === true ||
    record.allow_multiple === true ||
    mode === 'multi' ||
    mode === 'multiple' ||
    mode === 'multiselect' ||
    mode === 'option_multiselect'
  );
}

/** The server's list of actions for a decision, or null when it sends none. */
export function normalizePanelWidgetActions(value: unknown): PanelWidgetAction[] | null {
  const list = Array.isArray(value) ? value : asRecord(value)?.actions;
  if (!Array.isArray(list)) return null;
  const actions: PanelWidgetAction[] = [];
  for (const raw of list) {
    const record = asRecord(raw);
    if (!record) continue;
    const verb = (str(record.action) ?? str(record.kind) ?? str(record.type) ?? '').toLowerCase();
    const optionId = str(record.option_id) ?? str(record.optionId);
    const kind: PanelWidgetAction['kind'] | null = /reject|decline|send_back|sendback|request_changes/.test(verb)
      ? 'reject'
      : optionId || verb === 'option' || verb === 'choose' || verb === 'select'
        ? 'option'
        : /approve|accept|confirm/.test(verb)
          ? 'approve'
          : null;
    if (!kind) continue;
    const resolvedOption = kind === 'option' ? optionId ?? str(record.id) : null;
    if (kind === 'option' && !resolvedOption) continue;
    const label =
      clipText(record.label ?? record.title ?? record.name, PANEL_OPTION_LABEL_MAX) ??
      (kind === 'reject' ? 'Send back' : kind === 'approve' ? 'Approve' : null);
    if (!label) continue;
    actions.push({ kind, label, option_id: resolvedOption });
    if (actions.length >= PANEL_OPTION_LIMIT + 2) break;
  }
  return actions.length ? actions : null;
}

function normalizeDecision(input: unknown): NormalizedDecision | null {
  const record = asRecord(input);
  if (!record) return null;
  const id = str(record.id);
  if (!id || !UUID_RE.test(id)) return null;
  const packet = asRecord(record.review_packet);
  const context = asRecord(record.context) ?? {};
  const current = asRecord(packet?.current) ?? {};
  const references = Array.isArray(packet?.references) ? packet!.references : [];
  const initiativeRef = references
    .map(asRecord)
    .find((ref) => ref && ref.type === 'initiative');
  const initiativeId =
    str(context.initiative_id) ?? str(initiativeRef?.id) ?? null;
  const summary = str(record.summary) ?? str(record.title) ?? 'Decision';
  const createdAt = str(record.created_at);
  return {
    id,
    version: str(packet?.updatedAt) ?? str(record.updated_at) ?? createdAt ?? id,
    title: summary,
    question: str(packet?.question) ?? summary,
    urgency: normalizeUrgency(record.urgency),
    createdAt,
    initiativeId: initiativeId && UUID_RE.test(initiativeId) ? initiativeId : null,
    initiativeTitle: clipText(initiativeRef?.label, PANEL_TITLE_MAX),
    blocked: current.blocked === true,
    decideInOrgxReason: str(record.decide_in_orgx_reason),
    options: normalizePanelOptions(
      Array.isArray(record.options) && record.options.length ? record.options : packet?.options
    ),
    multiselect: isPanelMultiselect(record),
    widgetActions: normalizePanelWidgetActions(record.widget_actions),
    packet,
  };
}

function decisionUrl(decision: NormalizedDecision): string {
  return buildEntityLink('decision', decision.id, {
    initiativeId: decision.initiativeId ?? undefined,
  }).url;
}

function toQueueItem(decision: NormalizedDecision): PanelQueueItem {
  return {
    id: decision.id,
    version: decision.version,
    title: clipText(decision.title, PANEL_TITLE_MAX) ?? 'Decision',
    urgency: decision.urgency,
    waiting_since: decision.createdAt,
    initiative_title: decision.initiativeTitle,
    blocked: decision.blocked,
    decide_in_orgx_reason: decision.decideInOrgxReason,
    option_count: decision.widgetActions
      ? decision.widgetActions.filter((action) => action.kind === 'option').length
      : decision.options.length,
    url: decisionUrl(decision),
  };
}

function toFocus(decision: NormalizedDecision): PanelFocus {
  const packet = decision.packet ?? {};
  const rec = asRecord(packet.recommendation);
  const recStatus = str(rec?.status);
  const evidence = (Array.isArray(packet.evidence) ? packet.evidence : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const consequences = asRecord(packet.consequences) ?? {};
  return {
    type: 'decision',
    id: decision.id,
    version: decision.version,
    question: clipText(decision.question, PANEL_QUESTION_MAX) ?? 'Decision',
    urgency: decision.urgency,
    waiting_since: decision.createdAt,
    initiative_title: decision.initiativeTitle,
    recommendation: rec
      ? {
          status:
            recStatus === 'ready' || recStatus === 'unverified'
              ? recStatus
              : 'unavailable',
          action: clipText(rec.action, PANEL_TITLE_MAX),
        }
      : null,
    evidence: evidence.slice(0, PANEL_EVIDENCE_LIMIT).map((item) => ({
      title: clipText(item.title, PANEL_EVIDENCE_TITLE_MAX) ?? 'Evidence',
      source_url: httpsUrlOrNull(item.sourceUrl ?? item.source_url),
    })),
    evidence_total: evidence.length,
    consequence_if_approved: clipText(consequences.approve, PANEL_TEXT_MAX),
    consequence_if_rejected: clipText(consequences.reject, PANEL_TEXT_MAX),
    blocked: decision.blocked,
    decide_in_orgx_reason: decision.decideInOrgxReason,
    options: decision.options,
    multiselect: decision.multiselect,
    widget_actions: decision.widgetActions,
    url: decisionUrl(decision),
  };
}

function isHumanApprover(value: unknown): value is string {
  const approver = str(value);
  return Boolean(approver && !approver.toLowerCase().startsWith('system:'));
}

export interface PanelProofSummary {
  last_accepted: PanelSnapshot['proof']['last_accepted'];
  completed_unaccepted: number;
  /** False when an approved record lacks approved_by_user_id, so acceptance is unknown. */
  approver_known: boolean;
}

/**
 * Accepted = status approved AND a human approved_by_user_id. Everything
 * else that is finished (in_review, eval_passed, approved by system:* or by
 * nobody) is "completed, not yet accepted". `summarizeArtifacts().delivered`
 * is deliberately not reused: it counts in_review as delivered.
 */
export function summarizePanelProof(
  records: unknown[],
  viewer: { userIds: ReadonlyArray<string | null | undefined> }
): PanelProofSummary {
  const viewerIds = new Set(
    viewer.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  let approverMissing = false;
  let completedUnaccepted = 0;
  let best: { record: Record<string, unknown>; at: number; acceptedAt: string | null } | null = null;

  for (const raw of records) {
    const record = asRecord(raw);
    if (!record) continue;
    const normalized = normalizeArtifactRecord(record);
    if (!normalized?.id) continue;
    const status = normalized.status.toLowerCase();
    const hasApproverField = Object.prototype.hasOwnProperty.call(
      record,
      'approved_by_user_id'
    );
    // Acceptance is unknowable for an approved record without the field.
    if (status === 'approved' && !hasApproverField) approverMissing = true;

    if (status === 'in_review' || status === 'eval_passed') {
      completedUnaccepted += 1;
      continue;
    }
    if (status !== 'approved') continue;
    if (!hasApproverField) continue;
    if (!isHumanApprover(record.approved_by_user_id)) {
      completedUnaccepted += 1;
      continue;
    }
    const acceptedAt = str(record.approved_at) ?? str(record.updated_at) ?? null;
    const at = acceptedAt ? Date.parse(acceptedAt) : 0;
    const score = Number.isFinite(at) ? at : 0;
    if (!best || score > best.at) best = { record, at: score, acceptedAt };
  }

  if (approverMissing) {
    return { last_accepted: null, completed_unaccepted: completedUnaccepted, approver_known: false };
  }

  const lastAccepted = best
    ? (() => {
        const normalized = normalizeArtifactRecord(best!.record)!;
        const approver = str(best!.record.approved_by_user_id)!;
        return {
          artifact_id: normalized.id!,
          title: clipText(normalized.title, PANEL_TITLE_MAX) ?? 'Untitled artifact',
          accepted_at: best!.acceptedAt,
          accepted_by: viewerIds.has(approver) ? ('you' as const) : ('workspace_member' as const),
          url: buildEntityLink('artifact', normalized.id!).url,
        };
      })()
    : null;

  return {
    last_accepted: lastAccepted,
    completed_unaccepted: completedUnaccepted,
    approver_known: true,
  };
}

const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The app's ledger-backed proof (`acceptance_records`: accepted by a human
 * on a work artifact). Null means the app could not read it; a malformed
 * value is treated the same, never shown as accepted. The link is rebuilt
 * from the id so the panel only opens canonical OrgX routes.
 */
export function normalizeAppProof(value: unknown): PanelSnapshot['proof'] | null {
  const proof = asRecord(value);
  if (!proof) return null;
  const count = proof.completed_unaccepted;
  const completedUnaccepted =
    typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const last = asRecord(proof.last_accepted);
  if (proof.last_accepted !== null && proof.last_accepted !== undefined && !last) return null;
  if (!last) return { last_accepted: null, completed_unaccepted: completedUnaccepted };
  const id = str(last.artifact_id);
  if (!id || !UUID_ANY_RE.test(id)) return null;
  const acceptedBy = last.accepted_by === 'you' ? 'you' : 'workspace_member';
  return {
    last_accepted: {
      artifact_id: id,
      title: clipText(last.title, PANEL_TITLE_MAX) ?? 'Untitled artifact',
      accepted_at: str(last.accepted_at),
      accepted_by: acceptedBy,
      url: buildEntityLink('artifact', id).url,
    },
    completed_unaccepted: completedUnaccepted,
  };
}

export interface BuildPanelSnapshotInput {
  now?: Date;
  workspace: { id: string; name: string | null } | null;
  /** The `decisions` array from the pending-decisions read, or null if it failed. */
  decisions: unknown[] | null;
  /** Artifact records, or null if the read failed or was skipped. */
  artifacts: unknown[] | null;
  /**
   * The app's `proof` from the pending-decisions read (acceptance ledger).
   * Undefined when the app did not send one (older app): fall back to the
   * artifact read. Null when the app could not read it: proof_unavailable.
   */
  appProof?: unknown;
  focus?: { type: 'decision'; id: string } | null;
  viewerUserIds?: ReadonlyArray<string | null | undefined>;
}

/** Pure: builds `orgx.panel.v1` from the two reads. */
export function buildPanelSnapshot(input: BuildPanelSnapshotInput): PanelSnapshot {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const degraded: string[] = [];
  const requestedId =
    input.focus && input.focus.type === 'decision' && UUID_RE.test(input.focus.id)
      ? input.focus.id.toLowerCase()
      : null;

  if (!input.workspace) {
    return {
      schema: PANEL_SNAPSHOT_SCHEMA,
      generated_at: generatedAt,
      state: 'no_workspace',
      workspace: null,
      attention: { pending: 0, oldest_at: null, blocking: false },
      queue: [],
      focus: null,
      selection: {
        requested_id: requestedId,
        status: requestedId ? 'unavailable' : 'default',
      },
      proof: { last_accepted: null, completed_unaccepted: 0 },
      degraded: [],
    };
  }

  const decisions = (input.decisions ?? [])
    .map(normalizeDecision)
    .filter((d): d is NormalizedDecision => Boolean(d))
    .sort(
      (a, b) =>
        URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
        Number(b.blocked) - Number(a.blocked) ||
        timeOf(a.createdAt) - timeOf(b.createdAt)
    );
  if (input.decisions === null) degraded.push('decisions_unavailable');

  let selectionStatus: PanelSnapshot['selection']['status'] = 'default';
  let focusDecision: NormalizedDecision | null = decisions[0] ?? null;
  if (requestedId) {
    const selected = decisions.find((d) => d.id.toLowerCase() === requestedId);
    if (selected) {
      focusDecision = selected;
      selectionStatus = 'selected';
    } else {
      // Unknown or other-workspace selection: never show a different item as
      // if it were the selected one.
      focusDecision = null;
      selectionStatus = 'unavailable';
    }
  }

  const oldest = decisions
    .map((d) => d.createdAt)
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => timeOf(a) - timeOf(b))[0] ?? null;

  let proof: PanelSnapshot['proof'] = { last_accepted: null, completed_unaccepted: 0 };
  const ledgerProof = input.appProof === undefined ? undefined : normalizeAppProof(input.appProof);
  if (ledgerProof !== undefined) {
    if (ledgerProof === null) degraded.push('proof_unavailable');
    else proof = ledgerProof;
  } else if (input.artifacts === null) {
    degraded.push('proof_unavailable');
  } else {
    const summary = summarizePanelProof(input.artifacts, {
      userIds: input.viewerUserIds ?? [],
    });
    proof = {
      last_accepted: summary.last_accepted,
      completed_unaccepted: summary.completed_unaccepted,
    };
    if (!summary.approver_known) degraded.push('proof_unavailable');
  }

  return {
    schema: PANEL_SNAPSHOT_SCHEMA,
    generated_at: generatedAt,
    state: input.decisions === null ? 'degraded' : 'ok',
    workspace: {
      id: input.workspace.id,
      name: clipText(input.workspace.name, 80),
    },
    attention: {
      pending: decisions.length,
      oldest_at: oldest,
      blocking: decisions.some((d) => d.blocked),
    },
    queue: decisions.slice(0, PANEL_QUEUE_LIMIT).map(toQueueItem),
    focus: focusDecision ? toFocus(focusDecision) : null,
    selection: { requested_id: requestedId, status: selectionStatus },
    proof,
    degraded,
  };
}

/**
 * Keep only approval tokens for decisions the panel can show, so the widget
 * meta never carries tokens for items it cannot act on.
 */
export function selectPanelApprovalMeta(
  meta: Record<string, unknown> | null,
  snapshot: PanelSnapshot
): Record<string, unknown> | null {
  const tokens = asRecord(meta?.approval_tokens);
  if (!tokens) return null;
  const visible = new Set<string>(snapshot.queue.map((item) => item.id));
  if (snapshot.focus) visible.add(snapshot.focus.id);
  const kept: Record<string, string> = {};
  for (const [id, token] of Object.entries(tokens)) {
    if (visible.has(id) && typeof token === 'string' && token) kept[id] = token;
  }
  return {
    approval_tokens: kept,
    ...(typeof meta?.token_ttl_seconds === 'number'
      ? { token_ttl_seconds: meta.token_ttl_seconds }
      : {}),
  };
}

export function summarizePanelSnapshot(snapshot: PanelSnapshot): string {
  if (snapshot.state === 'no_workspace') {
    return 'OrgX panel: no workspace is selected for this session.';
  }
  if (snapshot.state === 'degraded') {
    return 'OrgX panel: the decision queue could not be read right now.';
  }
  const pending = snapshot.attention.pending;
  return pending === 0
    ? 'OrgX panel: nothing needs your decision.'
    : `OrgX panel: ${pending} need${pending === 1 ? 's' : ''} your decision.`;
}

// ---------------------------------------------------------------------------
// Handler and registration
// ---------------------------------------------------------------------------

export interface PanelSurfaceHost {
  /** The existing auth-required response, or null when the caller may read. */
  authRequired(): CallToolResult | null;
  /** IDs that identify the viewer as an approver (session id and OrgX UUID). */
  viewerUserIds(): Array<string | null | undefined>;
  /** The MCP session's workspace, if it carries one. */
  sessionWorkspace(): { id: string; name: string | null } | null;
  /** Read-only inference of the caller's active workspace. Never persisted. */
  inferWorkspace(): Promise<{ id: string; name: string | null } | null>;
  /**
   * The pending-decisions read `get_pending_decisions` uses, with the widget
   * meta channel requested. Returns the app payload (`{ok, data, error}`).
   */
  fetchPendingDecisions(params: {
    workspaceId: string;
    limit: number;
  }): Promise<{ ok?: boolean; data?: Record<string, unknown>; error?: unknown }>;
  /** The artifact read behind fetchEntityCollection({type:'artifact'}). */
  fetchArtifacts(params: {
    workspaceId: string;
    limit: number;
  }): Promise<Array<Record<string, unknown>>>;
  /** The worker's tool wrapper (error mapping, session bookkeeping). */
  run(runner: () => Promise<CallToolResult>): Promise<CallToolResult>;
  now?(): Date;
}

export async function handlePanelSnapshot(
  host: PanelSurfaceHost,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const auth = host.authRequired();
  if (auth) return auth;

  return host.run(async () => {
    const parsedFocus = PANEL_FOCUS_SCHEMA.safeParse(args?.focus);
    const focus = parsedFocus.success ? parsedFocus.data : null;

    let workspace = host.sessionWorkspace();
    if (!workspace) {
      try {
        workspace = await host.inferWorkspace();
      } catch {
        workspace = null;
      }
    }

    let decisions: unknown[] | null = null;
    let artifacts: unknown[] | null = null;
    let approvalMeta: Record<string, unknown> | null = null;
    let appProof: unknown = undefined;

    if (workspace) {
      const workspaceId = workspace.id;
      const [decisionRead, artifactRead] = await Promise.allSettled([
        host.fetchPendingDecisions({ workspaceId, limit: PANEL_DECISION_READ_LIMIT }),
        host.fetchArtifacts({ workspaceId, limit: PANEL_ARTIFACT_READ_LIMIT }),
      ]);
      if (decisionRead.status === 'fulfilled' && decisionRead.value?.ok !== false) {
        const split = splitWidgetApprovalMeta(asRecord(decisionRead.value?.data) ?? {});
        decisions = Array.isArray(split.data.decisions) ? split.data.decisions : [];
        approvalMeta = split.meta;
        if ('proof' in split.data) appProof = split.data.proof;
      }
      if (artifactRead.status === 'fulfilled' && Array.isArray(artifactRead.value)) {
        artifacts = artifactRead.value;
      }
    }

    const snapshot = buildPanelSnapshot({
      now: host.now?.(),
      workspace,
      decisions,
      artifacts,
      appProof,
      focus,
      viewerUserIds: host.viewerUserIds(),
    });
    const widgetMeta = selectPanelApprovalMeta(approvalMeta, snapshot);

    return {
      content: [{ type: 'text', text: summarizePanelSnapshot(snapshot) }],
      structuredContent: snapshot as unknown as Record<string, unknown>,
      ...(widgetMeta ? { _meta: { [WIDGET_APPROVAL_META_KEY]: widgetMeta } } : {}),
    } as CallToolResult;
  });
}

export function registerPanelSurface(
  server: McpServer,
  allowedTools: ReadonlySet<string> | null,
  host: PanelSurfaceHost,
  withClientContext: <T extends Record<string, unknown>>(shape: T) => T = (shape) => shape
): void {
  if (allowedTools && !allowedTools.has(PANEL_TOOL_ID)) return;
  registerAppTool(
    server,
    PANEL_TOOL_ID,
    {
      title: PANEL_SNAPSHOT_TOOL_CONTRACT.title,
      description: PANEL_SNAPSHOT_TOOL_CONTRACT.description,
      inputSchema: withClientContext({ ...PANEL_SNAPSHOT_TOOL_CONTRACT.inputSchema }),
      annotations: { ...PANEL_SNAPSHOT_TOOL_CONTRACT.annotations },
      _meta: PANEL_TOOL_META as unknown as Record<string, unknown>,
    } as Parameters<typeof registerAppTool>[2],
    async (args: Record<string, unknown>) => handlePanelSnapshot(host, args)
  );
}
