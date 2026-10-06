/**
 * Verification for per-run, user-scoped OrgX MCP bearer tokens.
 *
 * The main OrgX app mints these (see orgx `lib/server/auth/runMcpToken.ts`) and
 * attaches them as the bearer on the OrgX connector for detached agent runtimes
 * (e2b/CLI), which must authenticate to this worker over HTTP but must NOT be
 * handed the god `ORGX_SERVICE_KEY`. The token is self-describing: we resolve
 * the user from its claims, so no `X-Orgx-User-Id` header is required.
 *
 * Format: `oxrun1.<base64url(payloadJson)>.<base64url(hmacSha256)>`, signed with
 * HMAC-SHA256 over `oxrun1.<payload>` using a secret shared with the main app.
 */

export const RUN_MCP_TOKEN_PREFIX = 'oxrun1';
/**
 * v2 binds the token to one run: audience `orgx-mcp`, required workspace and
 * run, granted tool scopes and a jti. The worker forwards rid/wid/scp in its
 * actor token so the API can refuse calls once the run has ended.
 */
export const RUN_MCP_TOKEN_V2_PREFIX = 'oxrun2';
export const RUN_MCP_TOKEN_ISSUER = 'orgx-run-mcp';
export const RUN_MCP_TOKEN_AUDIENCE = 'orgx-mcp';
const MIN_SECRET_LENGTH = 32;

export interface RunMcpTokenPayload {
  iss: string;
  uid: string;
  wid: string | null;
  rid: string | null;
  exp: number;
  /** v2 only */
  v?: 2;
  aud?: string;
  scp?: string[];
  jti?: string;
  iat?: number;
}

type RunMcpTokenSecretEnv = {
  ORGX_RUN_MCP_TOKEN_SECRET?: string;
  ORGX_SERVICE_KEY?: string;
};

function usableSecret(value: string | undefined): string | null {
  const secret = value?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/**
 * The secret new tokens are signed with: the dedicated key if configured, else
 * the service key. (The worker only verifies today; the app mints.)
 */
export function runMcpTokenSecret(env: RunMcpTokenSecretEnv): string | null {
  return usableSecret(env.ORGX_RUN_MCP_TOKEN_SECRET) ?? usableSecret(env.ORGX_SERVICE_KEY);
}

/**
 * Every secret an OrgX MCP run token may be signed with, in the order to try:
 * the dedicated ORGX_RUN_MCP_TOKEN_SECRET first, then ORGX_SERVICE_KEY.
 *
 * TEMPORARY: the service-key entry exists only so the switch to the dedicated
 * secret has no downtime. Apps deployed before ORGX_RUN_MCP_TOKEN_SECRET
 * reached them still sign with ORGX_SERVICE_KEY, and their tokens (1h for OrgX
 * MCP run tokens) must keep verifying while the app redeploys. Remove the
 * service-key fallback here (and in runMcpTokenSecret) once the app signs only
 * with the dedicated secret (orgx PR #3328 drops its fallback) and tokens
 * minted before that have expired.
 *
 * Broker tokens never use this list: they verify with the dedicated secret
 * alone (broker/brokerToken.ts, brokerTokenSecret).
 */
export function runMcpTokenVerificationSecrets(env: RunMcpTokenSecretEnv): string[] {
  const secrets: string[] = [];
  for (const candidate of [env.ORGX_RUN_MCP_TOKEN_SECRET, env.ORGX_SERVICE_KEY]) {
    const secret = usableSecret(candidate);
    if (secret && !secrets.includes(secret)) secrets.push(secret);
  }
  return secrets;
}

export function isRunMcpToken(token: string | null | undefined): boolean {
  return (
    typeof token === 'string' &&
    (token.startsWith(`${RUN_MCP_TOKEN_PREFIX}.`) ||
      token.startsWith(`${RUN_MCP_TOKEN_V2_PREFIX}.`))
  );
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 =
    s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(body: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function signedByAny(
  body: string,
  signature: string,
  secrets: readonly string[]
): Promise<boolean> {
  for (const secret of secrets) {
    let expected: string;
    try {
      expected = bytesToB64url(await hmacSha256(body, secret));
    } catch {
      return false;
    }
    if (timingSafeEqual(expected, signature)) return true;
  }
  return false;
}

/**
 * Verify a run-scoped MCP token. Returns the payload when the signature is
 * valid under one of `secrets` (tried in order; see
 * runMcpTokenVerificationSecrets), issuer matches, and it has not expired;
 * otherwise null. Never throws.
 */
export async function verifyRunMcpToken(
  token: string | null | undefined,
  secrets: string | readonly string[] | null | undefined,
  nowMs: number
): Promise<RunMcpTokenPayload | null> {
  const candidates = (typeof secrets === 'string' ? [secrets] : secrets ?? []).filter(
    (secret) => secret.length > 0
  );
  if (!isRunMcpToken(token) || candidates.length === 0) return null;
  const parts = (token as string).split('.');
  if (parts.length !== 3) return null;

  if (!(await signedByAny(`${parts[0]}.${parts[1]}`, parts[2], candidates))) return null;

  let payload: RunMcpTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(parts[1]))
    ) as RunMcpTokenPayload;
  } catch {
    return null;
  }

  if (payload.iss !== RUN_MCP_TOKEN_ISSUER || !payload.uid) return null;
  if (parts[0] === RUN_MCP_TOKEN_V2_PREFIX) {
    if (
      payload.v !== 2 ||
      payload.aud !== RUN_MCP_TOKEN_AUDIENCE ||
      !payload.wid ||
      !payload.rid ||
      !Array.isArray(payload.scp) ||
      !payload.scp.every((scope) => typeof scope === 'string')
    ) {
      return null;
    }
  } else if (payload.v !== undefined) {
    // A v1 prefix may not carry a v2 body.
    return null;
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;

  return payload;
}
