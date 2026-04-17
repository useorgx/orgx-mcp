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

export type StreamTokenVerifyResult =
  | { ok: true; payload: StreamTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Verify a stream token. Returns a tagged result so callers can distinguish
 * "signature/format is wrong" from "signature is fine but token is past its
 * exp" — the latter is the only case that should trigger a refresh; the
 * former should surface as a plain auth failure.
 */
export async function verifyStreamTokenDetailed(
  token: string,
  secret: string
): Promise<StreamTokenVerifyResult> {
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
    ) as StreamTokenPayload;

    if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalid' };
    if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Backwards-compatible wrapper — returns the payload on success, null
 * otherwise. Prefer `verifyStreamTokenDetailed` in new code so 401
 * responses can emit `stream_token_expired` vs `stream_token_invalid`.
 */
export async function verifyStreamToken(
  token: string,
  secret: string
): Promise<StreamTokenPayload | null> {
  const result = await verifyStreamTokenDetailed(token, secret);
  return result.ok ? result.payload : null;
}

/**
 * Wrap an SSE Response so that the stream closes gracefully when the
 * underlying stream token is about to expire — emitting a well-known
 * `event: auth_expired` event first so the client can reconnect with a
 * fresh token instead of seeing an abrupt disconnect.
 *
 * Why this exists:
 *   Stream tokens live for 1 hour. A long-running scaffold or live-feed
 *   stream started at t=0 will keep pushing events past t=3600s even
 *   though the token is no longer valid — the DO has no reason to notice.
 *   Clients then see stale data with no way to know refresh is required.
 *
 * Shape:
 *   If the response is not `text/event-stream`, it's returned unchanged.
 *   If it is, we splice a Transform that, at `expMs - marginMs`, writes:
 *     event: auth_expired
 *     data: {"reason":"stream_token_expired","next":"refresh"}
 *   …then closes cleanly. Downstream data after that point is dropped so
 *   post-expiry messages can't leak through.
 */
export function withStreamTokenExpiry(
  response: Response,
  expMs: number,
  marginMs = 5_000
): Response {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    return response;
  }

  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  const fireAt = Math.max(0, expMs - marginMs - Date.now());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore — another path already closed it
        }
      };
      const emitExpired = () => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              'event: auth_expired\ndata: {"reason":"stream_token_expired","next":"refresh"}\n\n'
            )
          );
        } catch {
          // ignore
        }
        safeClose();
      };
      const timer = setTimeout(emitExpired, fireAt);

      const pump = async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } catch {
          // upstream disconnect — close cleanly
        } finally {
          clearTimeout(timer);
          safeClose();
        }
      };

      void pump();
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
