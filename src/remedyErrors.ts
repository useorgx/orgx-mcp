/**
 * Typed remedy errors for agent-facing tool failures.
 *
 * A failed write must tell the calling agent what happened and what to do
 * next in a form it can act on without parsing prose. The classification
 * order is deliberate:
 *
 *   1. A `RemedyError` thrown where the failure originated.
 *   2. A structured backend error code (`error.code` in the OrgX API body,
 *      surfaced on `OrgXApiError.backendCode`) or an upstream tool error code.
 *   3. The HTTP status, plus whether the request may already have been
 *      applied (a timed-out or failed write).
 *   4. Only then, as a last resort, a conservative match over the message.
 *
 * Every `suggested_next_calls` entry names a tool on the default v2 profile
 * and carries arguments that satisfy that tool's advertised schema
 * (tests/remedyErrors.spec.ts enumerates them). A `forbidden` failure never
 * suggests an alternative route: a different tool is not a way around a
 * missing permission, and an effect-scope refusal is answered only by
 * re-dispatching with an explicit, valid `effects` scope — never by routing
 * the effect through a different tool.
 */

import { DISPATCH_EFFECT_NAMES } from './dispatchContract';

export const REMEDY_CODES = [
  'approval_required',
  'stale_version',
  'stale_lease',
  'budget_exhausted',
  'rate_limited',
  'outcome_unknown',
  'forbidden',
  'idempotency_key_required',
  'idempotency_key_conflict',
  'effect_scope_missing',
  'effect_scope_invalid',
] as const;

export type RemedyCode = (typeof REMEDY_CODES)[number];

const REMEDY_CODE_SET: ReadonlySet<string> = new Set(REMEDY_CODES);

export function isRemedyCode(value: unknown): value is RemedyCode {
  return typeof value === 'string' && REMEDY_CODE_SET.has(value);
}

export type SuggestedCall = { tool: string; args: Record<string, unknown> };

export type RemedyApprover = {
  id?: string;
  name?: string;
  role?: string;
};

/** Facts the backend (or the originating code) supplied about a failure. */
export type RemedyFacts = {
  approver?: RemedyApprover;
  requested_scope?: string | string[];
  decision_id?: string;
  limit?: number | string | Record<string, number | string>;
  retry_after_seconds?: number;
  current_version?: number | string;
  lease_holder?: string;
  lease_expires_at?: string;
  operation_id?: string;
};

export type FailureDiagnostic = {
  code: string;
  reason: string;
  safe_to_retry: boolean;
  /** Plain-language instructions for the next step. */
  remedy?: string;
  corrected_payload?: Record<string, unknown>;
  valid_values?: readonly string[];
  suggested_next_calls?: SuggestedCall[];
  security_note?: string;
  approver?: RemedyApprover;
  requested_scope?: string | string[];
  limit?: number | string | Record<string, number | string>;
  retry_after_seconds?: number;
  current_version?: number | string;
  lease_holder?: string;
  lease_expires_at?: string;
  required_field?: string;
  example_idempotency_key?: string;
};

/**
 * Throw this where a failure originates when its remedy class is known.
 * `diagnoseToolFailure` prefers it over every other signal.
 */
export class RemedyError extends Error {
  readonly code: RemedyCode;
  readonly facts: RemedyFacts;
  readonly status?: number;

  constructor(code: RemedyCode, message: string, facts: RemedyFacts = {}, status?: number) {
    super(message);
    this.name = 'RemedyError';
    this.code = code;
    this.facts = facts;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Transport failure marking (set by the API client where the failure occurs)
// ---------------------------------------------------------------------------

export type TransportFailureKind = 'timeout' | 'network';
const transportFailures = new WeakMap<object, TransportFailureKind>();

/** Record that a request failed in transit, so its outcome is unknown for writes. */
export function markTransportFailure<T>(error: T, kind: TransportFailureKind): T {
  if (error && typeof error === 'object') transportFailures.set(error as object, kind);
  return error;
}

export function transportFailureKind(error: unknown): TransportFailureKind | undefined {
  return error && typeof error === 'object' ? transportFailures.get(error as object) : undefined;
}

// ---------------------------------------------------------------------------
// Structured backend code mapping
// ---------------------------------------------------------------------------

const BACKEND_CODE_MAP: Readonly<Record<string, RemedyCode>> = {
  approval_required: 'approval_required',
  requires_approval: 'approval_required',
  approval_pending: 'approval_required',
  approval_needed: 'approval_required',
  awaiting_approval: 'approval_required',
  human_approval_required: 'approval_required',
  pending_approval: 'approval_required',

  stale_version: 'stale_version',
  version_conflict: 'stale_version',
  plan_version_conflict: 'stale_version',
  revision_conflict: 'stale_version',
  stale_revision: 'stale_version',
  expected_version_mismatch: 'stale_version',
  precondition_failed: 'stale_version',

  stale_lease: 'stale_lease',
  lease_expired: 'stale_lease',
  lease_conflict: 'stale_lease',
  lease_lost: 'stale_lease',
  lease_held: 'stale_lease',
  lease_not_held: 'stale_lease',

  budget_exhausted: 'budget_exhausted',
  budget_exceeded: 'budget_exhausted',
  budget_cap_exceeded: 'budget_exhausted',
  workspace_budget_blocked: 'budget_exhausted',
  spend_cap_exceeded: 'budget_exhausted',
  quota_exceeded: 'budget_exhausted',
  allowance_exhausted: 'budget_exhausted',
  insufficient_credits: 'budget_exhausted',

  rate_limited: 'rate_limited',
  rate_limit_exceeded: 'rate_limited',
  too_many_requests: 'rate_limited',

  outcome_unknown: 'outcome_unknown',
  upstream_timeout: 'outcome_unknown',

  forbidden: 'forbidden',
  permission_denied: 'forbidden',
  access_denied: 'forbidden',
  not_authorized: 'forbidden',

  idempotency_key_required: 'idempotency_key_required',
  missing_idempotency_key: 'idempotency_key_required',
  idempotency_key_conflict: 'idempotency_key_conflict',
  idempotency_conflict: 'idempotency_key_conflict',
  idempotency_key_reused: 'idempotency_key_conflict',

  // The effect gate fails closed: a dispatch without an `effects` scope gets
  // no external effects, and a scope naming an unknown effect (or widening a
  // parent's scope) is refused.
  effect_scope_missing: 'effect_scope_missing',
  missing_effect_scope: 'effect_scope_missing',
  effects_not_declared: 'effect_scope_missing',
  effect_scope_invalid: 'effect_scope_invalid',
  invalid_effect_scope: 'effect_scope_invalid',
  unknown_effect: 'effect_scope_invalid',
};

export function remedyCodeFromBackendCode(code: unknown): RemedyCode | null {
  if (typeof code !== 'string') return null;
  return BACKEND_CODE_MAP[code.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function boundedString(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function pick(records: readonly JsonRecord[], keys: readonly string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function extractApprover(records: readonly JsonRecord[]): RemedyApprover | undefined {
  const nested = asRecord(pick(records, ['approver', 'required_approver', 'approval_owner']));
  const flat = nested ? [nested] : [];
  const id = boundedString(pick([...flat, ...records], flat.length ? ['id', 'user_id', 'approver_id'] : ['approver_id', 'approver_user_id']));
  const name = boundedString(pick([...flat, ...records], flat.length ? ['name', 'display_name', 'email', 'approver_name'] : ['approver_name', 'approver_email']));
  const role = boundedString(pick([...flat, ...records], flat.length ? ['role', 'approver_role'] : ['approver_role', 'required_role']));
  const approverString = boundedString(pick(records, ['approver', 'required_approver']));
  if (!id && !name && !role && !approverString) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(name ?? approverString ? { name: name ?? approverString } : {}),
    ...(role ? { role } : {}),
  };
}

function extractScope(records: readonly JsonRecord[]): string | string[] | undefined {
  const value = pick(records, ['requested_scope', 'required_scope', 'required_scopes', 'scope', 'scopes']);
  if (Array.isArray(value)) {
    const scopes = value.map((item) => boundedString(item, 120)).filter((item): item is string => Boolean(item)).slice(0, 10);
    return scopes.length ? scopes : undefined;
  }
  return boundedString(value, 120);
}

function extractLimit(records: readonly JsonRecord[]): RemedyFacts['limit'] {
  const value = pick(records, ['limit', 'cap', 'budget_limit', 'max_cost_usd', 'quota', 'limit_usd']);
  const number = finiteNumber(value);
  if (number !== undefined) return number;
  const text = boundedString(value, 120);
  if (text) return text;
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .slice(0, 8)
    .map(([key, item]) => [key.slice(0, 60), finiteNumber(item) ?? boundedString(item, 120)] as const)
    .filter((entry): entry is readonly [string, number | string] => entry[1] !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Pull known, bounded facts out of structured error details. Never copies free text. */
export function extractRemedyFacts(...sources: unknown[]): RemedyFacts {
  const records = sources.map(asRecord).filter((record): record is JsonRecord => Boolean(record));
  // Nested `error` objects carry the same fields in several API shapes.
  for (const record of [...records]) {
    const nested = asRecord(record.error);
    if (nested) records.push(nested);
    const details = asRecord(record.details);
    if (details) records.push(details);
  }
  const facts: RemedyFacts = {};
  const approver = extractApprover(records);
  if (approver) facts.approver = approver;
  const scope = extractScope(records);
  if (scope) facts.requested_scope = scope;
  const decisionId = boundedString(pick(records, ['decision_id', 'approval_decision_id']), 120);
  if (decisionId) facts.decision_id = decisionId;
  const limit = extractLimit(records);
  if (limit !== undefined) facts.limit = limit;
  const retryAfter = finiteNumber(pick(records, ['retry_after_seconds', 'retryAfterSeconds', 'retry_after']));
  if (retryAfter !== undefined) facts.retry_after_seconds = Math.max(0, Math.ceil(retryAfter));
  const version = pick(records, ['current_version', 'latest_version', 'actual_version']);
  const versionValue = finiteNumber(version) ?? boundedString(version, 60);
  if (versionValue !== undefined) facts.current_version = versionValue;
  const leaseHolder = boundedString(pick(records, ['lease_holder', 'lease_owner', 'held_by']), 120);
  if (leaseHolder) facts.lease_holder = leaseHolder;
  const leaseExpiresAt = boundedString(pick(records, ['lease_expires_at', 'expires_at']), 60);
  if (leaseExpiresAt) facts.lease_expires_at = leaseExpiresAt;
  const operationId = boundedString(pick(records, ['operation_id']), 160)
    ?? (() => {
      const command = boundedString(pick(records, ['command_id']), 120);
      if (command) return `command:${command}`;
      const run = boundedString(pick(records, ['run_id']), 120);
      return run ? `run:${run}` : undefined;
    })();
  if (operationId) facts.operation_id = operationId;
  return facts;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type FailureSignal = {
  error?: unknown;
  /** Upstream tool error code, when the failure arrived as a tool result. */
  code?: string;
  status?: number;
  details?: unknown;
  message?: string;
  /** True when the failing tool writes. Unknown outcomes only exist for writes. */
  mutating?: boolean;
  args?: Record<string, unknown>;
};

export type Classification = { code: RemedyCode; facts: RemedyFacts; source: 'origin' | 'backend_code' | 'status' | 'transport' | 'message' };

function errorField(error: unknown, key: string): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined;
}

/**
 * Classify a failure from structured signals only (origin, backend code,
 * status, transport). Returns null when nothing structured identifies it.
 */
export function classifyStructuredFailure(signal: FailureSignal): Classification | null {
  const { error } = signal;
  if (error instanceof RemedyError) return { code: error.code, facts: error.facts, source: 'origin' };

  const backendDetails = errorField(error, 'backendDetails');
  const facts = extractRemedyFacts(backendDetails, signal.details);
  const headerRetryAfter = finiteNumber(errorField(error, 'retryAfterSeconds'));
  if (headerRetryAfter !== undefined && facts.retry_after_seconds === undefined) {
    facts.retry_after_seconds = Math.max(0, Math.ceil(headerRetryAfter));
  }

  const backendCode = remedyCodeFromBackendCode(errorField(error, 'backendCode')) ?? remedyCodeFromBackendCode(signal.code);
  if (backendCode) return { code: backendCode, facts, source: 'backend_code' };

  const status = finiteNumber(errorField(error, 'statusCode')) ?? signal.status;
  if (status === 402) return { code: 'budget_exhausted', facts, source: 'status' };
  if (status === 429) return { code: 'rate_limited', facts, source: 'status' };
  if (status === 403) return { code: 'forbidden', facts, source: 'status' };
  if (status === 412) return { code: 'stale_version', facts, source: 'status' };
  if (status === 423) return { code: 'stale_lease', facts, source: 'status' };
  if (status === 409 && signal.args && signal.args.expected_version !== undefined) {
    return { code: 'stale_version', facts, source: 'status' };
  }
  if (signal.mutating) {
    if (transportFailureKind(error)) return { code: 'outcome_unknown', facts, source: 'transport' };
    if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || (status !== undefined && status >= 520 && status <= 524)) {
      return { code: 'outcome_unknown', facts, source: 'status' };
    }
  }
  return null;
}

/**
 * Last resort: conservative message patterns. Only used when no structured
 * signal identified the failure.
 */
export function classifyFailureMessage(message: string, mutating = false): RemedyCode | null {
  const lower = message.toLowerCase();
  if (/idempotency[_ ]key (?:was )?(?:already used|reused|conflict)|idempotency conflict/.test(lower)) return 'idempotency_key_conflict';
  if (/effect[_ ]scope[_ ]missing|no effects? scope (?:was )?declared/.test(lower)) return 'effect_scope_missing';
  if (/effect[_ ]scope[_ ]invalid|invalid effects? scope/.test(lower)) return 'effect_scope_invalid';
  if (/approval (?:is )?required|requires? (?:human )?approval|awaiting (?:human )?approval|no approval received|pending approval/.test(lower)) return 'approval_required';
  if (/lease (?:has )?(?:expired|lost|is held|conflict)|stale lease/.test(lower)) return 'stale_lease';
  if (/stale (?:version|revision|plan)|version conflict|revision conflict|expected[_ ]version (?:is )?(?:stale|outdated|mismatch)/.test(lower)) return 'stale_version';
  if (/budget (?:cap )?(?:exceeded|exhausted)|spend cap|quota exceeded|allowance (?:is )?exhausted/.test(lower)) return 'budget_exhausted';
  if (/rate limit(?:ed| exceeded)?|too many requests/.test(lower)) return 'rate_limited';
  if (/\bforbidden\b|not permitted to/.test(lower)) return 'forbidden';
  if (mutating && /timed out|took too long|timeout/.test(lower)) return 'outcome_unknown';
  return null;
}

// ---------------------------------------------------------------------------
// Remedy construction
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const WORK_TYPES = new Set(['initiative', 'workstream', 'milestone', 'task']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The work record a call targeted, when its arguments name one. */
function workTarget(args: Record<string, unknown> | undefined): { type: string; id: string } | null {
  if (!args) return null;
  const type = stringArg(args, 'type') ?? stringArg(args, 'level');
  const id = stringArg(args, 'id');
  if (type && id && WORK_TYPES.has(type)) return { type, id };
  const taskId = stringArg(args, 'task_id');
  if (taskId) return { type: 'task', id: taskId };
  const initiativeId = stringArg(args, 'initiative_id');
  if (initiativeId) return { type: 'initiative', id: initiativeId };
  return null;
}

function scopeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const workspaceId = stringArg(args, 'workspace_id');
  if (workspaceId && UUID_RE.test(workspaceId)) result.workspace_id = workspaceId;
  return result;
}

function inspectCall(args: Record<string, unknown> | undefined): SuggestedCall[] {
  const target = workTarget(args);
  return target ? [{ tool: 'orgx_inspect', args: { type: target.type, id: target.id } }] : [];
}

function operationStatusCall(operationId: string | undefined): SuggestedCall[] {
  return operationId ? [{ tool: 'orgx_get_operation_status', args: { operation_id: operationId } }] : [];
}

/** Calls that read back the state a write may have produced. */
function reconciliationCalls(toolId: string, args: Record<string, unknown> | undefined, facts: RemedyFacts): SuggestedCall[] {
  const calls: SuggestedCall[] = [...operationStatusCall(facts.operation_id)];
  const sessionId = stringArg(args, 'session_id');
  if (sessionId && /plan/.test(toolId)) {
    calls.push({ tool: 'orgx_read_plan', args: { session_id: sessionId } });
  } else if (toolId === 'orgx_submit_work_receipt') {
    const receipt = asRecord(args?.receipt);
    const receiptId = boundedString(receipt?.receipt_id, 512);
    if (receiptId) calls.push({ tool: 'orgx_get_work_receipt', args: { receipt_id: receiptId, ...scopeArgs(args) } });
  } else {
    calls.push(...inspectCall(args));
  }
  return calls;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function buildRemedy(
  code: RemedyCode,
  context: { toolId: string; args?: Record<string, unknown>; facts?: RemedyFacts; message?: string }
): FailureDiagnostic {
  const { toolId, args } = context;
  const facts = context.facts ?? {};
  const idempotencyKey = stringArg(args, 'idempotency_key');

  switch (code) {
    case 'approval_required': {
      const calls: SuggestedCall[] = [];
      if (facts.decision_id) calls.push({ tool: 'orgx_open_decision_review', args: { decision_id: facts.decision_id, ...scopeArgs(args) } });
      const initiativeId = stringArg(args, 'initiative_id');
      calls.push({ tool: 'orgx_list_pending_decisions', args: { ...scopeArgs(args), ...(initiativeId ? { initiative_id: initiativeId } : {}) } });
      const approver = facts.approver
        ? [facts.approver.name, facts.approver.role ? `(${facts.approver.role})` : undefined].filter(Boolean).join(' ')
        : null;
      return withoutUndefined({
        code,
        reason: 'This write requires a recorded human approval before OrgX applies it. Agents cannot approve their own work.',
        remedy: `Ask ${approver || 'an authorized approver'} to review the pending decision${facts.requested_scope ? ` for ${[facts.requested_scope].flat().join(', ')}` : ''}: list pending decisions, open the matching review, and retry this call with the same idempotency_key only after the approval is recorded.`,
        safe_to_retry: false,
        approver: facts.approver,
        requested_scope: facts.requested_scope,
        suggested_next_calls: calls,
      });
    }
    case 'stale_version': {
      const sessionId = stringArg(args, 'session_id');
      const calls = sessionId && /plan/.test(toolId)
        ? [{ tool: 'orgx_read_plan', args: { session_id: sessionId } }]
        : inspectCall(args);
      return withoutUndefined({
        code,
        reason: 'The record changed after you read it, so the expected version you sent is stale. Nothing was written.',
        remedy: 'Read the latest version, reapply your change to that content, and retry with the returned version as expected_version and a new idempotency_key, because the input changed.',
        safe_to_retry: false,
        current_version: facts.current_version,
        suggested_next_calls: calls,
      });
    }
    case 'stale_lease':
      return withoutUndefined({
        code,
        reason: 'The execution lease on this work expired or is held by another agent, so this write was refused.',
        remedy: 'Inspect the work to see its current owner and state. If another agent holds it, do not overwrite its work; coordinate through a handoff. If your own lease expired and the work is paused, resume it to reclaim the lease, then retry with a new idempotency_key.',
        safe_to_retry: false,
        lease_holder: facts.lease_holder,
        lease_expires_at: facts.lease_expires_at,
        suggested_next_calls: [...inspectCall(args), ...operationStatusCall(facts.operation_id)],
      });
    case 'budget_exhausted': {
      const taskId = stringArg(args, 'task_id');
      return withoutUndefined({
        code,
        reason: 'The workspace or per-task budget does not cover this operation, so OrgX did not start it.',
        remedy: `Do not retry until the budget resets or a person raises the cap${facts.retry_after_seconds !== undefined ? ` (earliest retry in ${facts.retry_after_seconds}s)` : ''}. Estimate a cheaper route or lower max_cost_usd if the work allows it.`,
        safe_to_retry: false,
        limit: facts.limit,
        retry_after_seconds: facts.retry_after_seconds,
        suggested_next_calls: [
          ...(taskId ? [{ tool: 'orgx_estimate_agent_task', args: { task: { task_id: taskId } } }] : []),
          { tool: 'orgx_check_execution_readiness', args: scopeArgs(args) },
        ],
      });
    }
    case 'rate_limited': {
      const retryAfter = facts.retry_after_seconds ?? 60;
      return withoutUndefined({
        code,
        reason: 'OrgX rate-limited this request. It was not applied.',
        remedy: `Wait ${retryAfter} seconds, then retry the identical call with the same idempotency_key.`,
        safe_to_retry: true,
        limit: facts.limit,
        retry_after_seconds: retryAfter,
      });
    }
    case 'outcome_unknown':
      return withoutUndefined({
        code,
        reason: 'The write was sent but OrgX did not confirm the result (timeout or upstream failure). It may or may not have been applied.',
        remedy: idempotencyKey
          ? `Do not issue a new write with a new key. Read back the state with the suggested calls; if the change is absent, retry the identical call with idempotency_key "${idempotencyKey}" and OrgX will apply it at most once.`
          : 'Do not repeat the write blindly. Read back the state with the suggested calls before deciding whether to retry with a stable idempotency_key.',
        safe_to_retry: Boolean(idempotencyKey),
        suggested_next_calls: reconciliationCalls(toolId, args, facts),
      });
    case 'forbidden':
      return withoutUndefined({
        code,
        reason: 'The authenticated identity is not permitted to perform this operation.',
        remedy: 'Ask a workspace administrator to grant the required role or scope, then reconnect. Do not retry through another tool to work around the permission.',
        safe_to_retry: false,
        requested_scope: facts.requested_scope,
        suggested_next_calls: [],
      });
    case 'idempotency_key_required': {
      const example = exampleIdempotencyKey(toolId);
      const { _context, ...rest } = args ?? {};
      return {
        code,
        reason: `${toolId} writes durable state and requires idempotency_key. Nothing was written.`,
        remedy: 'Generate one stable key per intended change (for example a UUID prefixed with your client and operation), send it as idempotency_key, and reuse the same key with identical input when retrying after a timeout or an unknown outcome. OrgX applies a keyed write at most once and replays the original result. Use a new key for a different change.',
        safe_to_retry: true,
        required_field: 'idempotency_key',
        example_idempotency_key: example,
        suggested_next_calls: [{ tool: toolId, args: { ...rest, idempotency_key: example } }],
      };
    }
    case 'effect_scope_missing':
      return withoutUndefined({
        code,
        reason: 'This dispatch declared no effects scope, so OrgX gives the run no external effects (connected-service writes such as sending email, pushing code, or deploying). Internal work such as editing files and running tests is unaffected.',
        remedy: 'If the work needs an external effect, re-dispatch it with an explicit effects scope that names only the effects it needs (use approval_required for any that a person must approve), and a new idempotency_key because the input changed. Send effects: { "allowed": [] } to declare that it needs none. Do not route the effect through another tool to avoid the gate.',
        safe_to_retry: false,
        required_field: 'effects',
        valid_values: DISPATCH_EFFECT_NAMES,
        requested_scope: facts.requested_scope,
        suggested_next_calls: inspectCall(args),
      });
    case 'effect_scope_invalid':
      return withoutUndefined({
        code,
        reason: 'The effects scope was refused: it names an unknown effect or asks for more than the parent run or caller authority allows. Nothing was dispatched under it.',
        remedy: 'Re-dispatch with an explicit effects scope that uses only the listed effect names and stays within the parent run\'s scope (a child can only narrow it; effects that require approval stay approval-required), with a new idempotency_key because the input changed. Do not route the effect through another tool to avoid the gate.',
        safe_to_retry: false,
        required_field: 'effects',
        valid_values: DISPATCH_EFFECT_NAMES,
        requested_scope: facts.requested_scope,
        suggested_next_calls: inspectCall(args),
      });
    case 'idempotency_key_conflict':
      return {
        code,
        reason: 'This idempotency_key was already used with different input, so OrgX refused to apply a second, different write under it.',
        remedy: 'If you meant to retry the earlier write, resend its exact input with this key. If this is a different change, generate a new idempotency_key.',
        safe_to_retry: false,
        suggested_next_calls: reconciliationCalls(toolId, args, {}),
      };
  }
}

/** The detail fields every typed remedy error carries. */
export function typedRemedyDetails(diagnostic: FailureDiagnostic): Record<string, unknown> {
  return {
    diagnostic,
    retryable: diagnostic.safe_to_retry,
    suggested_next_calls: diagnostic.suggested_next_calls ?? [],
    ...(diagnostic.retry_after_seconds !== undefined ? { retry_after_seconds: diagnostic.retry_after_seconds } : {}),
  };
}

function randomToken(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A fresh key that satisfies every advertised idempotency_key pattern. */
export function exampleIdempotencyKey(toolId: string): string {
  const operation = toolId.replace(/^orgx_/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
  return `mcp:${operation}:${randomToken()}`;
}
