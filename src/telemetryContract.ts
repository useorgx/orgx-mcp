/** Mirrored cross-repo contract. Keep this file identical in orgx and orgx-mcp. */
export const TELEMETRY_SCHEMA_VERSION = '2026-10-12';
export const TELEMETRY_LIMITS = {
  maxProperties: 128, maxEventBytes: 16_384, maxBatchEvents: 50,
  maxQueueEvents: 100, timeoutMs: 2000, retries: 0,
} as const;
export type TelemetryAudience = 'external' | 'internal' | 'test' | 'unknown';
export type TelemetryOutcome = 'attempt' | 'success' | 'failure' | 'unknown';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canonicalAccountId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}
/** Only a trusted, explicit classification; never infer from email/domain/name. */
export function telemetryAudience(value: unknown): TelemetryAudience {
  return value === 'external' || value === 'internal' || value === 'test' ? value : 'unknown';
}
export function safeCorrelation(value: unknown, kind: 'uuid' | 'trace' | 'span'): string | undefined {
  if (kind === 'uuid') return canonicalAccountId(value);
  const length = kind === 'trace' ? 32 : 16;
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value) && !/^0+$/.test(value)
    ? value.toLowerCase() : undefined;
}
/** PII is allowed only at this dedicated PostHog person boundary. */
export function posthogProfile(properties: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['email', 'name', 'plan', 'subscription_status']) {
    const value = properties[key];
    if (value === null || (typeof value === 'string' && value.length <= 320)) result[key] = value;
  }
  const clerkId = properties.clerk_user_id;
  if (typeof clerkId === 'string' && /^user_[a-zA-Z0-9]{1,100}$/.test(clerkId)) result.clerk_user_id = clerkId;
  for (const key of ['demo_mode', 'has_subscription', 'github_connected', 'linear_connected']) {
    if (typeof properties[key] === 'boolean') result[key] = properties[key];
  }
  result.telemetry_audience = telemetryAudience(properties.telemetry_audience);
  result.identity_namespace = 'orgx_account';
  return result;
}
/** A transport success is not a verified MCP business result. */
export function invocationOutcome(status: unknown, observed: unknown): TelemetryOutcome {
  if (status === 'error') return 'failure';
  return status === 'success' && observed === true ? 'success' : 'unknown';
}

export type CanonicalTelemetryFacts = {
  mcp_tool_invocation: { status: 'success' | 'error'; mcp_response_observed: boolean;
    mcp_logical_error: boolean; journey_phase: 'complete'; tool_id: string; request_uuid: string };
  mcp_pairing_identity_token: { outcome: 'minted' | 'failed'; ok: boolean;
    reason: 'missing_signing_secret' | 'missing_state' | 'no_session' | 'placeholder_email' | 'email_unverified' | null };
  onboarding_completed: { completion_kind: 'navigation_graduation'; verified_first_result: false };
  onboarding_completion_viewed: { phase: 'complete' };
};
export const CANONICAL_FACT_SEMANTICS = {
  mcp_tool_invocation: 'One observed response per tools/call; semantic outcome may be unknown.',
  mcp_pairing_identity_token: 'Pairing handoff mint result; never proof of a connected MCP client.',
  onboarding_completed: 'First persisted navigation graduation; server-owned, not accepted-work activation.',
  onboarding_completion_viewed: 'Browser complete-phase view; repeat views are engagement only.',
} as const satisfies Record<keyof CanonicalTelemetryFacts, string>;
