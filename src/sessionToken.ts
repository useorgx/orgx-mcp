/**
 * sessionToken.ts — HMAC-signed tokens for MCP agent session authentication.
 *
 * Follows the same pattern as streamToken.ts: base64url(payload) + "." + base64url(HMAC-SHA256).
 * Tokens encode: sessionId, orgId, userId, scopes, expiry.
 * Verified by toolAccessGating before allowing tool calls.
 *
 * Format: base64url( JSON payload ) + "." + base64url( HMAC-SHA256 signature )
 */

const SESSION_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface SessionTokenPayload {
  type: 'session';
  sid: string; // sessionId
  oid: string; // orgId
  uid: string; // userId
  scopes: string[];
  exp: number; // expiry timestamp (ms)
}

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): ArrayBuffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

/**
 * Sign a session token. Expires in 1 hour.
 */
export async function signSessionToken(opts: {
  sessionId: string;
  orgId: string;
  userId: string;
  scopes: string[];
  secret: string;
}): Promise<string> {
  const payload: SessionTokenPayload = {
    type: 'session',
    sid: opts.sessionId,
    oid: opts.orgId,
    uid: opts.userId,
    scopes: opts.scopes,
    exp: Date.now() + SESSION_TOKEN_TTL_MS,
  };
  const enc = new TextEncoder();
  const payloadB64 = b64url(
    enc.encode(JSON.stringify(payload)).buffer as ArrayBuffer
  );
  const key = await importKey(opts.secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

export type SessionTokenVerifyResult =
  | { ok: true; payload: SessionTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Verify a session token with reason tagging. Callers that emit HTTP 401s
 * should prefer this over the legacy wrapper — an expired session token
 * means the caller should re-request via POST /session-tokens, while an
 * invalid one means the caller mis-wired the header.
 */
export async function verifySessionTokenDetailed(
  token: string,
  secret: string
): Promise<SessionTokenVerifyResult> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return { ok: false, reason: 'invalid' };
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    const key = await importKey(secret);
    const enc = new TextEncoder();
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigB64),
      enc.encode(payloadB64)
    );
    if (!valid) return { ok: false, reason: 'invalid' };

    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadB64))
    ) as SessionTokenPayload;

    if (payload.type !== 'session') return { ok: false, reason: 'invalid' };
    if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalid' };
    if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Backwards-compatible wrapper — returns the payload on success, null
 * otherwise. Prefer `verifySessionTokenDetailed` when building 401 responses.
 */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionTokenPayload | null> {
  const result = await verifySessionTokenDetailed(token, secret);
  return result.ok ? result.payload : null;
}
