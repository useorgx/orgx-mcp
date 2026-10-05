/**
 * Verification of broker run tokens (`oxrun2`, audience `orgx-broker`).
 *
 * The OrgX app mints them per run (orgx `lib/server/auth/runMcpToken.ts`,
 * `mintBrokerRunToken`) and hands them to the harness instead of vendor
 * tokens. A broker token names exactly the connections the run may reach
 * (`conns`), so `/c/<connectionId>` refuses any other id before anything
 * else happens.
 *
 * Format: `oxrun2.<base64url(payloadJson)>.<base64url(hmacSha256)>`, signed
 * over `oxrun2.<payload>` with ORGX_RUN_MCP_TOKEN_SECRET. Broker tokens never
 * fall back to the service key: without the dedicated secret the broker is
 * off.
 */

export const BROKER_TOKEN_PREFIX = 'oxrun2';
export const BROKER_TOKEN_ISSUER = 'orgx-run-mcp';
export const BROKER_TOKEN_AUDIENCE = 'orgx-broker';
const MIN_SECRET_LENGTH = 32;

export interface BrokerConnectionGrant {
  tools?: string[];
  ro?: true;
}

export interface BrokerTokenPayload {
  v: 2;
  iss: string;
  aud: string;
  uid: string;
  wid: string;
  rid: string;
  jti: string;
  exp: number;
  iat?: number;
  conns: Record<string, BrokerConnectionGrant>;
}

export type BrokerTokenResult =
  | { ok: true; payload: BrokerTokenPayload }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'bad_signature' | 'wrong_audience' | 'expired' | 'invalid_claims';
    };

/** The dedicated secret, or null (the broker refuses everything then). */
export function brokerTokenSecret(env: { ORGX_RUN_MCP_TOKEN_SECRET?: string }): string | null {
  const secret = env.ORGX_RUN_MCP_TOKEN_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function isGrant(value: unknown): value is BrokerConnectionGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { tools, ro } = value as Record<string, unknown>;
  return (
    (tools === undefined || (Array.isArray(tools) && tools.every((t) => typeof t === 'string'))) &&
    (ro === undefined || ro === true)
  );
}

export async function verifyBrokerToken(
  token: string | null | undefined,
  secret: string,
  nowMs: number
): Promise<BrokerTokenResult> {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== BROKER_TOKEN_PREFIX) {
    return { ok: false, reason: 'malformed' };
  }
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let payload: Partial<BrokerTokenPayload>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.aud !== BROKER_TOKEN_AUDIENCE) return { ok: false, reason: 'wrong_audience' };
  if (
    payload.v !== 2 ||
    payload.iss !== BROKER_TOKEN_ISSUER ||
    typeof payload.uid !== 'string' ||
    !payload.uid ||
    typeof payload.wid !== 'string' ||
    !payload.wid ||
    typeof payload.rid !== 'string' ||
    !payload.rid ||
    typeof payload.jti !== 'string' ||
    !payload.jti ||
    !payload.conns ||
    typeof payload.conns !== 'object' ||
    Array.isArray(payload.conns) ||
    !Object.values(payload.conns).every(isGrant)
  ) {
    return { ok: false, reason: 'invalid_claims' };
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload: payload as BrokerTokenPayload };
}
