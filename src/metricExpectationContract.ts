/**
 * Request builder for the first exact delayed-outcome observer.
 *
 * The app route deliberately accepts one registry-backed metric only. Keep
 * the MCP surface equally narrow: callers can pre-register receipt coverage,
 * but cannot send SQL, natural-language matching rules, or causal claims.
 */

export const METRIC_EXPECTATIONS_V1_PATH = '/api/v1/expectations';
export const RUN_RECEIPT_COVERAGE_REGISTRY_ID =
  'orgx.run_receipt_coverage.v1' as const;
export const RUN_RECEIPT_COVERAGE_QUERY_VERSION = '1' as const;
export const AUTOMATIC_SESSION_CAPTURE_PATH =
  'automatic_session_summary' as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

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
  body: {
    workspace_id: string;
    subject_ref: {
      type: 'workspace';
      id: string;
    };
    metric_ref: {
      registry_id: typeof RUN_RECEIPT_COVERAGE_REGISTRY_ID;
      query_version: typeof RUN_RECEIPT_COVERAGE_QUERY_VERSION;
      parameters: {
        workspace_id: string;
        capture_path: typeof AUTOMATIC_SESSION_CAPTURE_PATH;
        exclude_benchmark: true;
        receipt_deadline_seconds: number;
      };
    };
    predicate: {
      operator: 'gte';
      threshold: number;
    };
    window: {
      starts_at: string;
      ends_at: string;
    };
    minimum_sample_size: number;
    evaluation_interval_seconds: number;
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

  const threshold = args.threshold ?? 0.95;
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
    { value: 20, min: 1, max: 100_000 }
  );
  if ('ok' in minimumSampleSize) return minimumSampleSize;
  const receiptDeadlineSeconds = boundedInteger(
    args.receipt_deadline_seconds,
    'receipt_deadline_seconds',
    { value: 60, min: 1, max: 3600 }
  );
  if ('ok' in receiptDeadlineSeconds) return receiptDeadlineSeconds;
  const evaluationIntervalSeconds = boundedInteger(
    args.evaluation_interval_seconds,
    'evaluation_interval_seconds',
    { value: 300, min: 60, max: 86_400 }
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
