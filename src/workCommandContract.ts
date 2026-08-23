/**
 * Request builders for the /api/v1 proof-runtime command and event routes.
 *
 * These mirror the monorepo route contracts exactly:
 *  - POST /api/v1/commands/create-work   (body zod schema is strict; the
 *    Idempotency-Key header is REQUIRED; expected_aggregate_version is the
 *    literal 0 because create targets a brand-new aggregate)
 *  - POST /api/v1/commands/complete-work (strict body; Idempotency-Key header
 *    REQUIRED; optimistic concurrency via expected_updated_at +
 *    expected_aggregate_version)
 *  - GET  /api/v1/events/stream          (JSON cursor-page mode; workspace_id
 *    in the query; limit 1-100; cursor/event_type/aggregate_type filters)
 *
 * Builders validate up front and fail with a precise message instead of a
 * vague downstream 400, following the validateSpawnContract pattern.
 */

export const CREATE_WORK_V1_PATH = '/api/v1/commands/create-work';
export const COMPLETE_WORK_V1_PATH = '/api/v1/commands/complete-work';
export const EVENTS_STREAM_V1_PATH = '/api/v1/events/stream';

export const CONTEXT_TAIL_MATERIAL_EVENT_TYPES = [
  'decision.approved',
  'decision.superseded',
  'autonomy.lease_changed',
  'blocker.opened',
  'blocker.resolved',
  'blocker.dismissed',
] as const;

export const CONTEXT_TAIL_SUPPORTED_CHANGE_CLASSES = [
  'decision.accepted',
  'decision.superseded',
  'authority.changed',
  'blocker.opened',
  'blocker.resolved',
] as const;

export const CONTEXT_TAIL_UNAVAILABLE_CHANGE_CLASSES = [
  'constraint.added_or_revoked',
  'expectation.resolved',
  'learning.applied',
  'incident.opened',
] as const;

export const WORK_COMMAND_PRIORITIES = [
  'low',
  'medium',
  'high',
  'urgent',
] as const;
export type WorkCommandPriority = (typeof WORK_COMMAND_PRIORITIES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches @orgx/contracts DateSchema-style YYYY-MM-DD due dates. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO datetime WITH offset, per z.string().datetime({ offset: true }). */
const DATETIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Route validates aggregate_type as /^[a-z][a-z0-9_.-]{0,99}$/. */
const AGGREGATE_TYPE_RE = /^[a-z][a-z0-9_.-]{0,99}$/;
const CONTEXT_CAPSULE_ID_RE = /^capsule_[0-9a-f]{24}$/;

const MAX_TITLE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_COST_CENTS = 100_000_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_EVENT_LIMIT = 100;

type JsonRecord = Record<string, unknown>;

export type WorkCommandBuildError = {
  ok: false;
  field: string;
  message: string;
};

export type CreateWorkRequest = {
  ok: true;
  path: typeof CREATE_WORK_V1_PATH;
  /** Value for the required Idempotency-Key header. */
  idempotencyKey: string;
  /** True when the worker generated the key because none was supplied. */
  idempotencyKeyGenerated: boolean;
  body: {
    workspace_id: string;
    command_id: string;
    expected_aggregate_version: 0;
    title: string;
    description?: string | null;
    initiative_id: string;
    workstream_id: string;
    milestone_id: string;
    priority: WorkCommandPriority;
    due_date?: string | null;
    metadata: JsonRecord;
    estimated_cost_cents: number;
    causation_id?: string | null;
    correlation_id?: string | null;
  };
};

export type CompleteWorkRequest = {
  ok: true;
  path: typeof COMPLETE_WORK_V1_PATH;
  idempotencyKey: string;
  idempotencyKeyGenerated: boolean;
  body: {
    workspace_id: string;
    task_id: string;
    expected_updated_at: string;
    expected_aggregate_version: number;
    summary?: string | null;
    evidence: JsonRecord;
    cost_cents: number;
    causation_id?: string | null;
    correlation_id?: string | null;
  };
};

export type EventsTailRequest = {
  ok: true;
  /** Fully query-encoded GET path. */
  path: string;
};

export type ContextTailRequest = {
  ok: true;
  /** Fully query-encoded GET path. */
  path: string;
  capsuleId: string;
  afterSequence: number;
};

function fail(field: string, message: string): WorkCommandBuildError {
  return { ok: false, field, message };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requireUuid(
  value: unknown,
  field: string
): { value: string } | WorkCommandBuildError {
  const trimmed = nonEmptyString(value);
  if (!trimmed) return fail(field, `${field} is required (UUID)`);
  if (!UUID_RE.test(trimmed)) return fail(field, `${field} must be a UUID`);
  return { value: trimmed };
}

function optionalUuid(
  value: unknown,
  field: string
): { value: string | null } | WorkCommandBuildError {
  if (value === undefined || value === null) return { value: null };
  const trimmed = nonEmptyString(value);
  if (!trimmed) return { value: null };
  if (!UUID_RE.test(trimmed)) return fail(field, `${field} must be a UUID`);
  return { value: trimmed };
}

function resolveIdempotencyKey(
  value: unknown
): { key: string; generated: boolean } | WorkCommandBuildError {
  const provided = nonEmptyString(value);
  if (provided) {
    if (provided.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return fail(
        'idempotency_key',
        `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
      );
    }
    return { key: provided, generated: false };
  }
  return { key: crypto.randomUUID(), generated: true };
}

function resolveCostCents(
  value: unknown,
  field: string
): { value: number } | WorkCommandBuildError {
  if (value === undefined || value === null) return { value: 0 };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_COST_CENTS
  ) {
    return fail(
      field,
      `${field} must be a non-negative integer number of cents (max ${MAX_COST_CENTS})`
    );
  }
  return { value };
}

/**
 * Build the POST /api/v1/commands/create-work request.
 * `workspaceId` is the already-resolved workspace scope (explicit arg or the
 * MCP session workspace).
 */
export function buildCreateWorkCommandRequest(
  args: JsonRecord,
  options: { workspaceId: string }
): CreateWorkRequest | WorkCommandBuildError {
  const title = nonEmptyString(args.title) ?? nonEmptyString(args.name);
  if (!title) return fail('title', 'title is required');
  if (title.length > MAX_TITLE_LENGTH) {
    return fail('title', `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }

  const workspaceId = requireUuid(options.workspaceId, 'workspace_id');
  if ('ok' in workspaceId) return workspaceId;
  const initiativeId = requireUuid(args.initiative_id, 'initiative_id');
  if ('ok' in initiativeId) return initiativeId;
  const workstreamId = requireUuid(args.workstream_id, 'workstream_id');
  if ('ok' in workstreamId) return workstreamId;
  const milestoneId = requireUuid(args.milestone_id, 'milestone_id');
  if ('ok' in milestoneId) return milestoneId;

  const commandId = optionalUuid(args.command_id, 'command_id');
  if ('ok' in commandId) return commandId;

  if (
    args.expected_aggregate_version !== undefined &&
    args.expected_aggregate_version !== 0
  ) {
    return fail(
      'expected_aggregate_version',
      'expected_aggregate_version must be 0 for create-work: the command creates a brand-new aggregate'
    );
  }

  const description = nonEmptyString(args.description);
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    return fail(
      'description',
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }

  const priorityRaw = nonEmptyString(args.priority);
  if (
    priorityRaw &&
    !WORK_COMMAND_PRIORITIES.includes(priorityRaw as WorkCommandPriority)
  ) {
    return fail(
      'priority',
      `priority must be one of ${WORK_COMMAND_PRIORITIES.join('|')}`
    );
  }

  const dueDate = nonEmptyString(args.due_date);
  if (dueDate && !DATE_RE.test(dueDate)) {
    return fail('due_date', 'due_date must be a YYYY-MM-DD date');
  }

  const estimatedCost = resolveCostCents(
    args.estimated_cost_cents,
    'estimated_cost_cents'
  );
  if ('ok' in estimatedCost) return estimatedCost;

  const causationId = optionalUuid(args.causation_id, 'causation_id');
  if ('ok' in causationId) return causationId;
  const correlationId = optionalUuid(args.correlation_id, 'correlation_id');
  if ('ok' in correlationId) return correlationId;

  const idempotency = resolveIdempotencyKey(args.idempotency_key);
  if ('ok' in idempotency) return idempotency;

  return {
    ok: true,
    path: CREATE_WORK_V1_PATH,
    idempotencyKey: idempotency.key,
    idempotencyKeyGenerated: idempotency.generated,
    body: {
      workspace_id: workspaceId.value,
      command_id: commandId.value ?? crypto.randomUUID(),
      expected_aggregate_version: 0,
      title,
      ...(description ? { description } : {}),
      initiative_id: initiativeId.value,
      workstream_id: workstreamId.value,
      milestone_id: milestoneId.value,
      priority: (priorityRaw as WorkCommandPriority | null) ?? 'medium',
      ...(dueDate ? { due_date: dueDate } : {}),
      metadata: readRecord(args.metadata) ?? {},
      estimated_cost_cents: estimatedCost.value,
      ...(causationId.value ? { causation_id: causationId.value } : {}),
      ...(correlationId.value ? { correlation_id: correlationId.value } : {}),
    },
  };
}

/**
 * Build the POST /api/v1/commands/complete-work request. The optimistic
 * concurrency tokens (expected_updated_at + expected_aggregate_version) are
 * required from the caller — the route rejects a mismatch with a conflict, so
 * they must come from a fresh read, never a guess.
 */
export function buildCompleteWorkCommandRequest(
  args: JsonRecord,
  options: { workspaceId: string }
): CompleteWorkRequest | WorkCommandBuildError {
  const workspaceId = requireUuid(options.workspaceId, 'workspace_id');
  if ('ok' in workspaceId) return workspaceId;
  const taskId = requireUuid(args.task_id, 'task_id');
  if ('ok' in taskId) return taskId;

  const expectedUpdatedAt = nonEmptyString(args.expected_updated_at);
  if (!expectedUpdatedAt || !DATETIME_WITH_OFFSET_RE.test(expectedUpdatedAt)) {
    return fail(
      'expected_updated_at',
      'expected_updated_at is required and must be the ISO datetime (with timezone offset) read from the current task record'
    );
  }

  const expectedVersion = args.expected_aggregate_version;
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return fail(
      'expected_aggregate_version',
      'expected_aggregate_version is required and must be the non-negative integer version read from the current task record'
    );
  }

  const summary = nonEmptyString(args.summary);
  if (summary && summary.length > MAX_SUMMARY_LENGTH) {
    return fail(
      'summary',
      `summary must be at most ${MAX_SUMMARY_LENGTH} characters`
    );
  }

  const costCents = resolveCostCents(args.cost_cents, 'cost_cents');
  if ('ok' in costCents) return costCents;

  const causationId = optionalUuid(args.causation_id, 'causation_id');
  if ('ok' in causationId) return causationId;
  const correlationId = optionalUuid(args.correlation_id, 'correlation_id');
  if ('ok' in correlationId) return correlationId;

  const idempotency = resolveIdempotencyKey(args.idempotency_key);
  if ('ok' in idempotency) return idempotency;

  return {
    ok: true,
    path: COMPLETE_WORK_V1_PATH,
    idempotencyKey: idempotency.key,
    idempotencyKeyGenerated: idempotency.generated,
    body: {
      workspace_id: workspaceId.value,
      task_id: taskId.value,
      expected_updated_at: expectedUpdatedAt,
      expected_aggregate_version: expectedVersion,
      ...(summary ? { summary } : {}),
      evidence: readRecord(args.evidence) ?? {},
      cost_cents: costCents.value,
      ...(causationId.value ? { causation_id: causationId.value } : {}),
      ...(correlationId.value ? { correlation_id: correlationId.value } : {}),
    },
  };
}

/**
 * Build the GET /api/v1/events/stream request in JSON cursor-page mode.
 * The worker always sends Accept: application/json, so the route serves a
 * cursor page instead of SSE.
 */
export function buildEventsTailRequest(
  args: JsonRecord,
  options: { workspaceId: string }
): EventsTailRequest | WorkCommandBuildError {
  const workspaceId = requireUuid(options.workspaceId, 'workspace_id');
  if ('ok' in workspaceId) return workspaceId;

  const params = new URLSearchParams();
  params.set('workspace_id', workspaceId.value);

  const limit = args.limit;
  if (limit !== undefined && limit !== null) {
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_EVENT_LIMIT
    ) {
      return fail(
        'limit',
        `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`
      );
    }
    params.set('limit', String(limit));
  }

  // `cursor` is the canonical route parameter; `after` is accepted as an
  // agent-friendly alias for "give me the page after this cursor".
  const cursor = nonEmptyString(args.cursor) ?? nonEmptyString(args.after);
  if (cursor) params.set('cursor', cursor);

  const eventType = nonEmptyString(args.event_type);
  if (eventType) params.set('event_type', eventType);

  const aggregateType = nonEmptyString(args.aggregate_type);
  if (aggregateType) {
    if (!AGGREGATE_TYPE_RE.test(aggregateType)) {
      return fail(
        'aggregate_type',
        'aggregate_type must match ^[a-z][a-z0-9_.-]{0,99}$'
      );
    }
    params.set('aggregate_type', aggregateType);
  }

  return {
    ok: true,
    path: `${EVENTS_STREAM_V1_PATH}?${params.toString()}`,
  };
}

/** Build the bounded material-change read used by orgx_tail. */
export function buildContextTailRequest(
  args: JsonRecord,
  options: { workspaceId: string }
): ContextTailRequest | WorkCommandBuildError {
  const workspaceId = requireUuid(options.workspaceId, 'workspace_id');
  if ('ok' in workspaceId) return workspaceId;

  const capsuleId = nonEmptyString(args.capsule_id);
  if (!capsuleId || !CONTEXT_CAPSULE_ID_RE.test(capsuleId)) {
    return fail(
      'capsule_id',
      'capsule_id must be the capsule_<24 lowercase hex> value returned by orgx_bootstrap'
    );
  }

  const afterSequence = args.after_sequence;
  if (
    typeof afterSequence !== 'number' ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0
  ) {
    return fail(
      'after_sequence',
      'after_sequence must be the non-negative safe integer returned by orgx_bootstrap'
    );
  }

  const limit = args.limit;
  if (
    limit !== undefined &&
    limit !== null &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_EVENT_LIMIT)
  ) {
    return fail(
      'limit',
      `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`
    );
  }

  const params = new URLSearchParams();
  params.set('workspace_id', workspaceId.value);
  params.set('after_sequence', String(afterSequence));
  params.set('event_type', CONTEXT_TAIL_MATERIAL_EVENT_TYPES.join(','));
  if (typeof limit === 'number') params.set('limit', String(limit));

  return {
    ok: true,
    path: `${EVENTS_STREAM_V1_PATH}?${params.toString()}`,
    capsuleId,
    afterSequence,
  };
}
