import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authHandler } from '../src/authHandler';
import { signMcpIdentityToken } from '../src/mcpIdentityToken';
import { captureWorkerPosthogEvent } from '../src/posthogTelemetry';

vi.mock('../src/posthogTelemetry', () => ({ captureWorkerPosthogEvent: vi.fn(), resolveAnonymousDistinctId: () => 'mcp:test' }));
const account = '11111111-1111-4111-8111-111111111111';
const attempt = '22222222-2222-4222-8222-222222222222';
const state = 'oauth-state-capability';
const auth = { clientId: 'client', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  scope: ['memory:read'], state: 'client-oauth-secret', pairingAttemptId: attempt, pairingStartedAt: Date.now() - 2000 };
const identity = { userId: 'user_clerk', userEmail: 'user@example.com', orgxUserId: account,
  pairingAttemptId: attempt, pairingStartedAt: auth.pairingStartedAt };

function setup(options: { legacy?: boolean; stateMissing?: boolean; providerFailure?: boolean; optOut?: boolean } = {}) {
  const store = new Map<string, string>();
  const storedAuth = options.legacy ? { clientId: auth.clientId, redirectUri: auth.redirectUri, scope: auth.scope } : auth;
  if (!options.stateMissing) store.set(`auth_state:${state}`, JSON.stringify(storedAuth));
  store.set(`auth_identity:${state}`, JSON.stringify({ ...identity, ...(options.optOut ? { telemetryOptOut: true } : {}) }));
  const completeAuthorization = vi.fn(async () => {
    if (options.providerFailure) throw new Error('provider-private-message');
    return { redirectTo: `${auth.redirectUri}?code=authorization-code-secret` };
  });
  const env = {
    MCP_SERVER_URL: 'https://mcp.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test', ORGX_INTERNAL_SECRET: 'test-signing-secret',
    OAUTH_KV: { get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }), delete: vi.fn(async (key: string) => { store.delete(key); }) },
    OAUTH_PROVIDER: { completeAuthorization, parseAuthRequest: vi.fn(async () => ({ ...auth })), lookupClient: vi.fn(async () => ({ clientName: 'ChatGPT' })) },
  };
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  return { env, ctx, store, completeAuthorization };
}
function consent(action = 'approve') {
  const body = new FormData(); body.set('state_key', state); body.set('action', action); body.set('final_scope', 'memory:read');
  return new Request('https://mcp.useorgx.test/oauth/consent-callback', { method: 'POST', body, headers: { accept: 'application/json' } });
}
function stages() { return vi.mocked(captureWorkerPosthogEvent).mock.calls.map(([value]) => value.properties?.stage); }
beforeEach(() => vi.clearAllMocks());

describe('OAuth pairing correlation through the actual flow', () => {
  it('creates analytics correlation separately from OAuth state and carries it to web sign-in', async () => {
    const { env, ctx } = setup();
    const response = await authHandler.fetch(new Request('https://mcp.useorgx.test/authorize?scope=memory%3Aread'), env, ctx);
    const signIn = new URL(response.headers.get('location')!);
    const callback = new URL(signIn.searchParams.get('redirect_url')!);
    const stateId = callback.searchParams.get('state_key');
    const attemptId = callback.searchParams.get('pairing_attempt_id');
    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attemptId).not.toBe(stateId);
    expect(JSON.parse(env.OAUTH_KV.put.mock.calls[0][1])).toMatchObject({ pairingAttemptId: attemptId });
    expect(stages()).toEqual(['sign_in_redirect']);
    expect(JSON.stringify(vi.mocked(captureWorkerPosthogEvent).mock.calls)).not.toContain(stateId!);
  });
  it('stores verified canonical identity and signed optout before handing off to consent', async () => {
    const { env, ctx, store } = setup();
    const token = await signMcpIdentityToken({ userId: identity.userId, email: identity.userEmail,
      orgxUserId: account, pairingAttemptId: attempt, telemetryOptOut: true, stateKey: state, secret: env.ORGX_INTERNAL_SECRET });
    const response = await authHandler.fetch(new Request(`https://mcp.useorgx.test/oauth/callback?state_key=${state}&identity_token=${token}`), env, ctx);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/consent.html');
    expect(JSON.parse(store.get(`auth_identity:${state}`)!)).toMatchObject({ orgxUserId: account, pairingAttemptId: attempt, telemetryOptOut: true });
    expect(stages()).toEqual(['identity_verified', 'consent_redirect']);
    expect(vi.mocked(captureWorkerPosthogEvent).mock.calls.every(([value]) => value.optOut)).toBe(true);
  });
  it('records approval only after grant creation and carries optout/attempt to trusted grant props', async () => {
    const { env, ctx, completeAuthorization, store } = setup({ optOut: true });
    const response = await authHandler.fetch(consent(), env, ctx);
    expect(response.status).toBe(200);
    expect(completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
      orgxUserId: account, pairingAttemptId: attempt, telemetryOptOut: true }) }));
    expect(stages()).toEqual(['consent_approved', 'client_return_issued']);
    expect(store.has(`auth_state:${state}`)).toBe(false);
    expect(JSON.stringify(vi.mocked(captureWorkerPosthogEvent).mock.calls)).not.toMatch(/authorization-code-secret|client-oauth-secret|user@example/);
  });
  it('keeps transient provider failures retryable and emits no connection success', async () => {
    const { env, ctx, store } = setup({ providerFailure: true });
    expect((await authHandler.fetch(consent(), env, ctx)).status).toBe(500);
    expect(store.has(`auth_state:${state}`)).toBe(true);
    expect(stages()).toEqual(['consent_failed']);
    expect(vi.mocked(captureWorkerPosthogEvent).mock.calls[0][0].properties).toMatchObject({ reason: 'provider_error', event_outcome: 'failure' });
  });
  it('records denial without creating a grant', async () => {
    const { env, ctx, completeAuthorization } = setup();
    expect((await authHandler.fetch(consent('deny'), env, ctx)).status).toBe(200);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(stages()).toEqual(['consent_denied', 'client_return_issued']);
  });
  it('records expired state using remaining verified identity and blocks grant creation', async () => {
    const { env, ctx, completeAuthorization } = setup({ stateMissing: true });
    expect((await authHandler.fetch(consent(), env, ctx)).status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(stages()).toEqual(['consent_expired']);
    expect(vi.mocked(captureWorkerPosthogEvent).mock.calls[0][0].distinctId).toBe(account);
  });
  it('completes consent for attempts started before rollout', async () => {
    const { env, ctx } = setup({ legacy: true });
    expect((await authHandler.fetch(consent(), env, ctx)).status).toBe(200);
    expect(stages()).toEqual(['consent_approved', 'client_return_issued']);
  });
});
