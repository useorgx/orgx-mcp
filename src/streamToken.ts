/**
 * streamToken.ts — short-lived HMAC-signed tokens for LiveFeed SSE streams.
 *
 * Tokens encode: feedType, feedId, userId (optional), expiry (1h).
 * Verified by authHandler before proxying requests to LiveFeedDO.
 *
 * Format: base64url( JSON payload ) + "." + base64url( HMAC-SHA256 signature )
 */

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface StreamTokenPayload {
  ft: string; // feedType
  fi: string; // feedId
  uid?: string; // userId (optional)
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
 * Sign a stream token for the given feed. Expires in 1 hour.
 */
export async function signStreamToken(opts: {
  feedType: string;
  feedId: string;
  userId?: string;
  secret: string;
}): Promise<string> {
  const payload: StreamTokenPayload = {
    ft: opts.feedType,
    fi: opts.feedId,
    exp: Date.now() + TOKEN_TTL_MS,
    ...(opts.userId ? { uid: opts.userId } : {}),
  };
  const enc = new TextEncoder();
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const key = await importKey(opts.secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

/**
 * Verify a stream token. Returns the payload if valid, null if invalid or expired.
 */
export async function verifyStreamToken(
  token: string,
  secret: string
): Promise<StreamTokenPayload | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
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
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadB64))
    ) as StreamTokenPayload;

    if (payload.exp < Date.now()) return null; // expired
    return payload;
  } catch {
    return null;
  }
}
