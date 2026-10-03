import { recordOAuthJourney } from "./oauthJourneyTelemetry";
import type { PosthogTelemetryEnv } from "./posthogTelemetry";

const EVENTS = new Set([
  "mcp_consent_viewed",
  "mcp_consent_stage_viewed",
  "mcp_consent_selection_changed",
  "mcp_consent_submit_failed",
]);
type Env = PosthogTelemetryEnv & {
  OAUTH_KV: { get: (key: string) => Promise<string | null> };
};

/** An opaque live consent session is required; browser data cannot select an account. */
export async function handleConsentJourneyEvent(
  request: Request,
  env: Env,
  ctx: { waitUntil: (task: Promise<unknown>) => unknown },
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response(null, { status: 415 });
  const text = await request.text();
  if (text.length > 4096) return new Response(null, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    !body ||
    typeof body.state_key !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(body.state_key) ||
    typeof body.event !== "string" ||
    !EVENTS.has(body.event)
  )
    return new Response(null, { status: 400 });
  const [state, identity] = await Promise.all([
    env.OAUTH_KV.get(`auth_state:${body.state_key}`),
    env.OAUTH_KV.get(`auth_identity:${body.state_key}`),
  ]);
  if (!state || !identity) return new Response(null, { status: 410 });
  await recordOAuthJourney({
    env,
    ctx,
    state: JSON.parse(state),
    identity: JSON.parse(identity),
    event: body.event,
    properties: {
      consent_stage: body.consent_stage,
      consent_preset: body.consent_preset,
      consent_resource: body.consent_resource,
      consent_level: body.consent_level,
      offline_access: body.offline_access,
      failure_category:
        body.event === "mcp_consent_submit_failed"
          ? "consent_submission"
          : undefined,
    },
  });
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
