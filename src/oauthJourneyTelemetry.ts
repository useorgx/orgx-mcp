import {
  captureWorkerPosthogEvent,
  type PosthogTelemetryEnv,
} from "./posthogTelemetry";

type Client = { icon?: string; identityTrust?: string };
type Identity = {
  userId: string;
  orgxUserId?: string;
  analyticsJourney?: { session_id?: string; signup_attempt_id?: string };
};
type State = {
  journeyId?: string;
  clientPresentation?: Client;
  scopeSource?: string;
};

/** State and verified identities stay in the caller; export only coarse evidence. */
export async function recordOAuthJourney(params: {
  env: PosthogTelemetryEnv;
  ctx: { waitUntil: (task: Promise<unknown>) => unknown };
  state: State;
  identity?: Identity;
  event: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const { state, identity } = params;
  if (!state.journeyId) return;
  if (identity?.orgxUserId && params.event === 'mcp_oauth_callback_completed') {
    captureWorkerPosthogEvent({ env: params.env, ctx: params.ctx, event: '$identify', distinctId: identity.orgxUserId, properties: { $anon_distinct_id: `mcp-journey:${state.journeyId}` } });
  }
  captureWorkerPosthogEvent({
    env: params.env,
    ctx: params.ctx,
    event: params.event,
    distinctId:
      identity?.orgxUserId ??
      identity?.userId ??
      `mcp-journey:${state.journeyId}`,
    properties: {
      oauth_journey_id: state.journeyId,
      oauth_client:
        state.clientPresentation?.identityTrust === "verified_redirect"
          ? state.clientPresentation.icon
          : "unknown",
      client_identity_trust:
        state.clientPresentation?.identityTrust ?? "unverified",
      client_label_kind: state.clientPresentation?.icon ?? "unverified",
      scope_source: state.scopeSource,
      signup_attempt_id: identity?.analyticsJourney?.signup_attempt_id,
      $session_id: identity?.analyticsJourney?.session_id,
      ...params.properties,
    },
  });
}

export function consentSelectionProperties(scopes: readonly string[]) {
  return {
    selected_scopes: [...scopes],
    selected_scope_count: scopes.length,
    offline_access: scopes.includes("offline_access"),
  };
}
