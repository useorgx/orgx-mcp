/**
 * Short-lived signed identity proof for the OrgX web app -> MCP OAuth callback.
 *
 * The browser redirects through /oauth/callback, so raw query params are not a
 * trustworthy identity boundary. The web app signs the authenticated Clerk
 * identity server-side and the MCP worker verifies the HMAC before completing
 * OAuth.
 */

const MCP_IDENTITY_TOKEN_TTL_MS = 5 * 60 * 1000;
const MCP_IDENTITY_TOKEN_TYPE = 'orgx.mcp.identity.v1';
const MCP_IDENTITY_TOKEN_AUD = 'orgx-mcp-oauth-callback';

export interface McpIdentityTokenPayload {
  type: typeof MCP_IDENTITY_TOKEN_TYPE;
  aud: typeof MCP_IDENTITY_TOKEN_AUD;
  iss: 'orgx-web';
  sub: string;
  email: string;
  email_verified?: boolean;
  state_key?: string;
  mcp_state?: string;
  iat: number;
  exp: number;
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

export async function signMcpIdentityToken(opts: {
  userId: string;
  email: string;
  emailVerified?: boolean;
  stateKey?: string | null;
  mcpState?: string | null;
  secret: string;
}): Promise<string> {
  const now = Date.now();
  const payload: McpIdentityTokenPayload = {
    type: MCP_IDENTITY_TOKEN_TYPE,
    aud: MCP_IDENTITY_TOKEN_AUD,
    iss: 'orgx-web',
    sub: opts.userId,
    email: opts.email.trim().toLowerCase(),
    email_verified: opts.emailVerified ?? undefined,
    ...(opts.stateKey ? { state_key: opts.stateKey } : {}),
    ...(opts.mcpState ? { mcp_state: opts.mcpState } : {}),
    iat: now,
    exp: now + MCP_IDENTITY_TOKEN_TTL_MS,
  };
  const enc = new TextEncoder();
  const payloadB64 = b64url(
    enc.encode(JSON.stringify(payload)).buffer as ArrayBuffer
  );
  const key = await importKey(opts.secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

export type McpIdentityTokenVerifyResult =
  | { ok: true; payload: McpIdentityTokenPayload }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'expired'
        | 'state_mismatch'
        | 'missing_identity'
        | 'placeholder_identity';
    };

function isUsableIdentityPayload(
  value: unknown
): value is McpIdentityTokenPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<McpIdentityTokenPayload>;
  return (
    payload.type === MCP_IDENTITY_TOKEN_TYPE &&
    payload.aud === MCP_IDENTITY_TOKEN_AUD &&
    payload.iss === 'orgx-web' &&
    typeof payload.sub === 'string' &&
    payload.sub.trim().length > 0 &&
    typeof payload.email === 'string' &&
    payload.email.trim().length > 0 &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number'
  );
}

export async function verifyMcpIdentityTokenDetailed(
  token: string,
  secret: string,
  expectedStateKey?: string | null
): Promise<McpIdentityTokenVerifyResult> {
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
    ) as unknown;
    if (!isUsableIdentityPayload(payload)) {
      return { ok: false, reason: 'missing_identity' };
    }
    if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
    if (expectedStateKey && payload.state_key !== expectedStateKey) {
      return { ok: false, reason: 'state_mismatch' };
    }
    if (payload.email.toLowerCase().endsWith('@placeholder.local')) {
      return { ok: false, reason: 'placeholder_identity' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
