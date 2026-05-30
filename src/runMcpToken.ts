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
export const RUN_MCP_TOKEN_ISSUER = 'orgx-run-mcp';
const MIN_SECRET_LENGTH = 32;

export interface RunMcpTokenPayload {
  iss: string;
  uid: string;
  wid: string | null;
  rid: string | null;
  exp: number;
}

/** Shared signing secret: a dedicated key if configured, else the service key. */
export function runMcpTokenSecret(env: {
  ORGX_RUN_MCP_TOKEN_SECRET?: string;
  ORGX_SERVICE_KEY?: string;
}): string | null {
  const dedicated = env.ORGX_RUN_MCP_TOKEN_SECRET?.trim();
  if (dedicated && dedicated.length >= MIN_SECRET_LENGTH) return dedicated;
  const serviceKey = env.ORGX_SERVICE_KEY?.trim();
  if (serviceKey && serviceKey.length >= MIN_SECRET_LENGTH) return serviceKey;
  return null;
}

export function isRunMcpToken(token: string | null | undefined): boolean {
  return (
    typeof token === 'string' && token.startsWith(`${RUN_MCP_TOKEN_PREFIX}.`)
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

/**
 * Verify a run-scoped MCP token. Returns the payload when the signature is
 * valid, issuer matches, and it has not expired; otherwise null. Never throws.
 */
export async function verifyRunMcpToken(
  token: string | null | undefined,
  secret: string | null | undefined,
  nowMs: number
): Promise<RunMcpTokenPayload | null> {
  if (!isRunMcpToken(token) || !secret) return null;
  const parts = (token as string).split('.');
  if (parts.length !== 3) return null;

  const body = `${parts[0]}.${parts[1]}`;
  let expected: string;
  try {
    expected = bytesToB64url(await hmacSha256(body, secret));
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, parts[2])) return null;

  let payload: RunMcpTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(parts[1]))
    ) as RunMcpTokenPayload;
  } catch {
    return null;
  }

  if (payload.iss !== RUN_MCP_TOKEN_ISSUER || !payload.uid) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;

  return payload;
}
