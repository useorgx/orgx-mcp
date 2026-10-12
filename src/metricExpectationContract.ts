import { RUN_RECEIPT_COVERAGE_REGISTRY_ID, AGENT_RUN_SUCCESS_REGISTRY_ID, SIGNUP_FIRST_SUCCESS_REGISTRY_ID, RUN_RECEIPT_COVERAGE_QUERY_VERSION, AUTOMATIC_SESSION_CAPTURE_PATH, METRIC_OBSERVER_AGENT_IDS, METRIC_REGISTRATION_LIMITS, METRIC_REGISTRATION_DEFAULTS, METRIC_DEFAULT_RECEIPT_DEADLINE_SECONDS, METRIC_DEFAULT_EVALUATION_INTERVAL_SECONDS, METRIC_SIGNUP_SUCCESS_DEADLINE_HOURS } from './generated/metricObserverRegistrationPolicy';
import type { RegisterMetricExpectation } from './generated/metricExpectationInput';

/**
 * Request builder for the first exact delayed-outcome observer.
 *
 * The app route accepts a closed registry of versioned observers.
 * Callers can pre-register a supported metric,
 * but cannot send SQL, natural-language matching rules, or causal claims.
 */

export const METRIC_EXPECTATIONS_V1_PATH = '/api/v1/expectations';
export { RUN_RECEIPT_COVERAGE_REGISTRY_ID, RUN_RECEIPT_COVERAGE_QUERY_VERSION, AUTOMATIC_SESSION_CAPTURE_PATH } from './generated/metricObserverRegistrationPolicy';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_WINDOW_MS = METRIC_REGISTRATION_LIMITS.maximumWindowMs;

type JsonRecord = Record<string, unknown>;

export type MetricExpectationBuildError = {
  ok: false;
  field: string;
  message: string;
};

export type RegisterMetricExpectationRequest = {
  ok: true;
  path: typeof METRIC_EXPECTATIONS_V1_PATH;
  idempotencyKey: string;
  idempotencyKeyGenerated: boolean;
  body: Omit<RegisterMetricExpectation, 'metric_ref' | 'predicate'> & {
    metric_ref: Pick<RegisterMetricExpectation['metric_ref'], 'registry_id' | 'query_version'> & {
      parameters: Pick<RegisterMetricExpectation['metric_ref']['parameters'], 'workspace_id'> & Record<string, unknown>;
    };
    predicate: { operator: 'gte'; threshold: RegisterMetricExpectation['predicate']['threshold'] };
  };
};

function fail(field: string, message: string): MetricExpectationBuildError {
  return { ok: false, field, message };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedInteger(
  value: unknown,
  field: string,
  defaults: { value: number; min: number; max: number }
): { value: number } | MetricExpectationBuildError {
  const resolved = value ?? defaults.value;
  if (
    typeof resolved !== 'number' ||
    !Number.isInteger(resolved) ||
    resolved < defaults.min ||
    resolved > defaults.max
  ) {
    return fail(
      field,
      `${field} must be an integer between ${defaults.min} and ${defaults.max}`
    );
  }
  return { value: resolved };
}

/**
 * Build the strict POST /api/v1/expectations body. `workspaceId` is the
 * already-resolved explicit or session workspace.
 */
export function buildMetricExpectationRequest(
  args: JsonRecord,
  options: { workspaceId: string }
): RegisterMetricExpectationRequest | MetricExpectationBuildError {
  const workspaceId = nonEmptyString(options.workspaceId);
  if (!workspaceId || !UUID_RE.test(workspaceId)) {
    return fail('workspace_id', 'workspace_id must be a UUID');
  }

  if (args.metric === AGENT_RUN_SUCCESS_REGISTRY_ID || args.metric === SIGNUP_FIRST_SUCCESS_REGISTRY_ID) {
    return buildAutonomyMetric(args, options);
  }
  if (args.metric !== RUN_RECEIPT_COVERAGE_REGISTRY_ID) {
    return fail(
      'metric',
      `metric must be ${RUN_RECEIPT_COVERAGE_REGISTRY_ID}; no other observer is registered`
    );
  }

  const startsAt = nonEmptyString(args.window_starts_at);
  const endsAt = nonEmptyString(args.window_ends_at);
  if (!startsAt || !DATETIME_WITH_OFFSET_RE.test(startsAt)) {
    return fail(
      'window_starts_at',
      'window_starts_at is required and must be an ISO datetime with a timezone offset'
    );
  }
  if (!endsAt || !DATETIME_WITH_OFFSET_RE.test(endsAt)) {
    return fail(
      'window_ends_at',
      'window_ends_at is required and must be an ISO datetime with a timezone offset'
    );
  }
  const startsAtMs = Date.parse(startsAt);
  const endsAtMs = Date.parse(endsAt);
  if (endsAtMs <= startsAtMs) {
    return fail(
      'window_ends_at',
      'window_ends_at must be after window_starts_at'
    );
  }
  if (endsAtMs - startsAtMs > MAX_WINDOW_MS) {
    return fail(
      'window_ends_at',
      'the observation window must not exceed 31 days'
    );
  }

  const threshold = args.threshold ?? METRIC_REGISTRATION_DEFAULTS[RUN_RECEIPT_COVERAGE_REGISTRY_ID].threshold;
  if (
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    return fail(
      'threshold',
      'threshold must be a finite ratio between 0 and 1'
    );
  }

  const minimumSampleSize = boundedInteger(
    args.minimum_sample_size,
    'minimum_sample_size',
    { value: METRIC_REGISTRATION_DEFAULTS[RUN_RECEIPT_COVERAGE_REGISTRY_ID].minimumSampleSize, min: METRIC_REGISTRATION_DEFAULTS[RUN_RECEIPT_COVERAGE_REGISTRY_ID].requiredMinimumSampleSize, max: METRIC_REGISTRATION_LIMITS.maximumSampleSize }
  );
  if ('ok' in minimumSampleSize) return minimumSampleSize;
  const receiptDeadlineSeconds = boundedInteger(
    args.receipt_deadline_seconds,
    'receipt_deadline_seconds',
    { value: METRIC_DEFAULT_RECEIPT_DEADLINE_SECONDS, min: METRIC_REGISTRATION_LIMITS.minimumReceiptDeadlineSeconds, max: METRIC_REGISTRATION_LIMITS.maximumReceiptDeadlineSeconds }
  );
  if ('ok' in receiptDeadlineSeconds) return receiptDeadlineSeconds;
  const evaluationIntervalSeconds = boundedInteger(
    args.evaluation_interval_seconds,
    'evaluation_interval_seconds',
    { value: METRIC_DEFAULT_EVALUATION_INTERVAL_SECONDS, min: METRIC_REGISTRATION_LIMITS.minimumEvaluationIntervalSeconds, max: METRIC_REGISTRATION_LIMITS.maximumEvaluationIntervalSeconds }
  );
  if ('ok' in evaluationIntervalSeconds) return evaluationIntervalSeconds;

  const providedKey = nonEmptyString(args.idempotency_key);
  if (providedKey && providedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return fail(
      'idempotency_key',
      `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    );
  }
  const idempotencyKey = providedKey ?? crypto.randomUUID();

  return {
    ok: true,
    path: METRIC_EXPECTATIONS_V1_PATH,
    idempotencyKey,
    idempotencyKeyGenerated: providedKey === null,
    body: {
      workspace_id: workspaceId,
      subject_ref: { type: 'workspace', id: workspaceId },
      metric_ref: {
        registry_id: RUN_RECEIPT_COVERAGE_REGISTRY_ID,
        query_version: RUN_RECEIPT_COVERAGE_QUERY_VERSION,
        parameters: {
          workspace_id: workspaceId,
          capture_path: AUTOMATIC_SESSION_CAPTURE_PATH,
          exclude_benchmark: true,
          receipt_deadline_seconds: receiptDeadlineSeconds.value,
        },
      },
      predicate: { operator: 'gte', threshold },
      window: { starts_at: startsAt, ends_at: endsAt },
      minimum_sample_size: minimumSampleSize.value,
      evaluation_interval_seconds: evaluationIntervalSeconds.value,
    },
  };
}

function buildAutonomyMetric(args: JsonRecord, options: {workspaceId: string}): RegisterMetricExpectationRequest | MetricExpectationBuildError {
  const base = buildMetricExpectationRequest({...args, metric: RUN_RECEIPT_COVERAGE_REGISTRY_ID,
    threshold: args.threshold ?? METRIC_REGISTRATION_DEFAULTS[args.metric as typeof AGENT_RUN_SUCCESS_REGISTRY_ID | typeof SIGNUP_FIRST_SUCCESS_REGISTRY_ID].threshold,
    minimum_sample_size: args.minimum_sample_size ?? METRIC_REGISTRATION_DEFAULTS[args.metric as typeof AGENT_RUN_SUCCESS_REGISTRY_ID | typeof SIGNUP_FIRST_SUCCESS_REGISTRY_ID].minimumSampleSize}, options);
  if (!base.ok) return base;
  const minimum = METRIC_REGISTRATION_DEFAULTS[args.metric as typeof AGENT_RUN_SUCCESS_REGISTRY_ID | typeof SIGNUP_FIRST_SUCCESS_REGISTRY_ID].requiredMinimumSampleSize;
  if (base.body.minimum_sample_size < minimum) return fail('minimum_sample_size',`This observer requires at least ${minimum} samples`);
  const type = args.subject_type ?? 'workspace';
  const id = args.subject_id ?? options.workspaceId;
  if (!['workspace','initiative','goal'].includes(String(type)) || typeof id !== 'string' || !UUID_RE.test(id) ||
      (type === 'workspace' && id !== options.workspaceId)) return fail('subject_id','Subject must match the admitted workspace or name a scoped initiative or goal');
  let parameters: RegisterMetricExpectationRequest['body']['metric_ref']['parameters'];
  if (args.metric === AGENT_RUN_SUCCESS_REGISTRY_ID) {
    if (!METRIC_OBSERVER_AGENT_IDS.some(agentId=>args.agent_id === agentId)) return fail('agent_id','A named domain agent is required');
    if (args.include_canaries !== undefined && typeof args.include_canaries !== 'boolean') return fail('include_canaries','include_canaries must be a boolean');
    parameters = {workspace_id: options.workspaceId, agent_id: args.agent_id, exclude_qa:true, include_canaries:args.include_canaries ?? true};
  } else {
    if (!Number.isSafeInteger(args.project_id) || Number(args.project_id) <= 0) return fail('project_id','A positive PostHog project ID is required');
    parameters = {workspace_id: options.workspaceId, project_id:args.project_id, exclude_qa:true, success_deadline_hours:METRIC_SIGNUP_SUCCESS_DEADLINE_HOURS};
  }
  return {...base, body:{...base.body, subject_ref:{type:type as 'workspace'|'initiative'|'goal',id},
    metric_ref:{registry_id:args.metric as typeof AGENT_RUN_SUCCESS_REGISTRY_ID | typeof SIGNUP_FIRST_SUCCESS_REGISTRY_ID,query_version:RUN_RECEIPT_COVERAGE_QUERY_VERSION,parameters}}};
}
