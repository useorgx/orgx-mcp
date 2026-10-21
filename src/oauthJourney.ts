import { captureWorkerPosthogEvent, type PosthogTelemetryEnv } from './posthogTelemetry';
import { canonicalAccountId } from './telemetryContract';

/** Analytics correlation is deliberately separate from OAuth's state capability. */
export type OAuthJourney = {
  pairingAttemptId?: string;
  pairingStartedAt?: number;
  telemetryOptOut?: boolean;
};

export type OAuthJourneyIdentity = OAuthJourney & { orgxUserId?: string };
type Lifecycle = { waitUntil?: (promise: Promise<unknown>) => unknown };

import { CONSENT_BROWSER_STAGES, CONSENT_FAILURE_REASONS, safeOAuthDestination, type OAuthJourneyStage, type OAuthJourneyReason } from './oauthJourneyContract';

export function captureOAuthJourney(params: {
  env: PosthogTelemetryEnv;
  ctx?: Lifecycle;
  request: Request;
  stage: OAuthJourneyStage;
  journey?: OAuthJourney;
  identity?: OAuthJourneyIdentity;
  reason?: OAuthJourneyReason;
  destination?: string;
}): void {
  const { journey, identity } = params;
  const accountId = canonicalAccountId(identity?.orgxUserId);
  const attempt = canonicalAccountId(journey?.pairingAttemptId ?? identity?.pairingAttemptId);
  const started = journey?.pairingStartedAt ?? identity?.pairingStartedAt;
  captureWorkerPosthogEvent({
    env: params.env,
    ctx: params.ctx,
    event: 'mcp_pairing_step',
    distinctId: accountId ?? `mcp:${attempt ?? crypto.randomUUID()}`,
    optOut: params.request.headers.get('dnt') === '1' || journey?.telemetryOptOut === true || identity?.telemetryOptOut === true,
    properties: {
      stage: params.stage,
      ...(attempt ? { pairing_attempt_id: attempt } : {}),
      ...(typeof started === 'number' && Number.isFinite(started) && started <= Date.now()
        ? { elapsed_ms: Date.now() - started } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      event_outcome: ['sign_in_redirect', 'consent_redirect', 'client_return_issued'].includes(params.stage)
        ? 'attempt' : ['failed', 'consent_failed', 'consent_expired', 'consent_denied'].includes(params.stage) ? 'failure' : 'success',
      ...safeOAuthDestination(params.destination),
    },
  });
}

/** Invalid proofs cannot supply an account; only the stored opaque attempt is retained. */
export async function captureOAuthIdentityFailure(
  request: Request,
  env: PosthogTelemetryEnv & { OAUTH_KV: KVNamespace },
  stateKey: string,
  ctx?: Lifecycle
): Promise<void> {
  try {
    const stored = await env.OAUTH_KV.get(`auth_state:${stateKey}`);
    if (stored) captureOAuthJourney({ env, ctx, request, journey: JSON.parse(stored) as OAuthJourney,
      stage: 'failed', reason: 'identity_verification_failed' });
  } catch { /* Optional capture never changes an authentication response. */ }
}

/** A same-origin UI breadcrumb never supplies identity, destination, or correlation authority. */
export async function handleConsentTrace(
  request: Request,
  env: PosthogTelemetryEnv & { OAUTH_KV: KVNamespace },
  ctx?: Lifecycle
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return new Response(null, { status: 403, headers });
  }
  let body: Record<string, unknown>;
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  try {
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) return new Response(null, { status: 413, headers });
      text += decoder.decode(chunk.value, { stream: true });
    }
    body = JSON.parse(text + decoder.decode()) as Record<string, unknown>;
    if (!body || Array.isArray(body)) return new Response(null, { status: 400, headers });
  } catch { return new Response(null, { status: 400, headers }); }
  finally { await reader.cancel().catch(() => undefined); }

  const stateKey = typeof body.state_key === 'string' && body.state_key.length <= 256 ? body.state_key : undefined;
  const stage = CONSENT_BROWSER_STAGES.find((candidate) => candidate === body.stage);
  const reason = CONSENT_FAILURE_REASONS.find((candidate) => candidate === body.reason);
  if (!stateKey || !stage) return new Response(null, { status: 400, headers });
  try {
    const [storedState, storedIdentity] = await Promise.all([
      env.OAUTH_KV.get(`auth_state:${stateKey}`), env.OAUTH_KV.get(`auth_identity:${stateKey}`),
    ]);
    const journey = storedState ? JSON.parse(storedState) as OAuthJourney : undefined;
    const identity = storedIdentity ? JSON.parse(storedIdentity) as OAuthJourneyIdentity : undefined;
    if (!storedState || !storedIdentity) {
      captureOAuthJourney({ env, ctx, request, journey, identity, stage: 'consent_expired', reason: 'session_expired' });
      return new Response(null, { status: 410, headers });
    }
    captureOAuthJourney({ env, ctx, request, journey, identity, stage, reason });
    return new Response(null, { status: 204, headers });
  } catch { return new Response(null, { status: 503, headers }); }
}
