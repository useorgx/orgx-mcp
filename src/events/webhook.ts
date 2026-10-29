import { connect } from 'cloudflare:sockets';
import ipaddr from 'ipaddr.js';
import { EventError } from './contracts';

export function callbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new EventError(-32602, 'invalid_callback_url'); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !hostname.includes('.') || hostname.endsWith('.') ||
      /[\[\]:]/.test(hostname) || ipaddr.isValid(hostname) ||
      /\.(localhost|local|internal|test|invalid|example)$/.test(hostname)) {
    throw new EventError(-32602, 'invalid_callback_url');
  }
  return url;
}

export function publicAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(value);
    // Treat mapped/transition ranges as non-public too: no alternate private-IP encodings.
    return address.range() === 'unicast';
  } catch { return false; }
}

/** Fixed resolver, fresh for EVERY connection. No DNS check followed by a hostname fetch. */
export async function resolvePublicAddress(hostname: string, signal: AbortSignal): Promise<string> {
  const answers = await Promise.all(['A', 'AAAA'].map(async (type) => {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', type);
    const response = await fetch(endpoint, { headers: { accept: 'application/dns-json' }, redirect: 'error', cache: 'no-store', signal });
    if (!response.ok) throw new EventError(-32015, 'dns_failed');
    const text = await response.text();
    if (text.length > 32_768) throw new EventError(-32015, 'dns_failed');
    const value = JSON.parse(text) as { Status?: number; Answer?: { type: number; data: string }[] };
    if (value.Status !== 0) throw new EventError(-32015, 'dns_failed');
    return (value.Answer ?? []).filter((answer) => answer.type === 1 || answer.type === 28).map((answer) => answer.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some((address) => !publicAddress(address))) throw new EventError(-32015, 'non_public_destination');
  return addresses[0];
}

export function signingKey(secret: string): Uint8Array {
  try {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error();
    const encoded = secret.slice(6);
    const decoded = atob(encoded);
    if (decoded.length < 24 || decoded.length > 64 || btoa(decoded).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error();
    return Uint8Array.from(decoded, (byte) => byte.charCodeAt(0));
  } catch { throw new EventError(-32602, 'invalid_signing_secret'); }
}

export async function webhookSignature(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const bytes = signingKey(secret);
  const key = await crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

export type WebhookPost = (url: string, body: string, headers: Record<string, string>) => Promise<Response>;

/**
 * A small, bounded HTTP/1.1 POST over a pinned TCP connection. Workers fetch and
 * node:https do not expose destination pinning for an external callback. Start
 * TLS before writing ANY bytes, using the original hostname for SNI/cert checks.
 * See Socket.startTls({ expectedServerHostname }) in the Workers socket contract.
 */
export const pinnedWebhookPost: WebhookPost = async (value, body, headers) => {
  const url = callbackUrl(value);
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > 262_144) throw new EventError(-32015, 'payload_too_large');
  const signal = AbortSignal.timeout(10_000);
  let socket: Socket | undefined;
  try {
    const address = await resolvePublicAddress(url.hostname, signal);
    socket = connect({ hostname: address, port: 443 }, { secureTransport: 'starttls', allowHalfOpen: false });
    // Neither the TCP connection nor TLS upgrade performs a second DNS lookup.
    socket = socket.startTls({ expectedServerHostname: url.hostname });
    const active = socket;
    const onAbort = () => { void active.close().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await active.opened;
      if (signal.aborted) throw new Error();
      const requestHeaders = new Headers(headers);
      requestHeaders.set('Host', url.hostname);
      requestHeaders.set('Connection', 'close');
      requestHeaders.set('Content-Length', String(bytes.length));
      requestHeaders.set('Accept-Encoding', 'identity');
      let head = `POST ${url.pathname}${url.search} HTTP/1.1\r\n`;
      for (const [name, value] of requestHeaders) head += `${name}: ${value}\r\n`;
      const writer = active.writable.getWriter();
      await writer.write(new TextEncoder().encode(`${head}\r\n`));
      await writer.write(bytes);
      writer.releaseLock();
      const reader = active.readable.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      let total = 0;
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
          if (total > 32_768) throw new EventError(-32015, 'response_too_large');
          raw += decoder.decode(chunk, { stream: true });
          const parsed = parseHttpResponse(raw, false);
          if (parsed) return parsed;
        }
        raw += decoder.decode();
        const parsed = parseHttpResponse(raw, true);
        if (!parsed) throw new EventError(-32015, 'invalid_response');
        return parsed;
      } finally { reader.releaseLock(); }
    } finally { signal.removeEventListener('abort', onAbort); }
  } catch (error) {
    if (signal.aborted) throw new EventError(-32015, 'timeout');
    if (error instanceof EventError) throw error;
    throw new EventError(-32015, 'connection_failed');
  } finally { await socket?.close().catch(() => {}); }
};

/** Returns null until a complete framed response has arrived. Never follows redirects. */
export function parseHttpResponse(raw: string, ended: boolean): Response | null {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0) return null;
  const lines = raw.slice(0, separator).split('\r\n');
  const status = /^HTTP\/1\.[01] ([2-5]\d\d)(?: |$)/.exec(lines.shift() ?? '');
  if (!status) throw new EventError(-32015, 'invalid_response');
  const headers = new Headers();
  for (const line of lines) {
    const split = line.indexOf(':');
    if (split < 1) throw new EventError(-32015, 'invalid_response');
    headers.append(line.slice(0, split), line.slice(split + 1).trim());
  }
  const code = Number(status[1]);
  if (code >= 300 && code < 400) throw new EventError(-32015, 'redirect_forbidden');
  if (code === 204 || code === 205) return new Response(null, { status: code });
  let body = raw.slice(separator + 4);
  const encoding = headers.get('transfer-encoding');
  const length = headers.get('content-length');
  if (encoding && length) throw new EventError(-32015, 'invalid_response');
  if (encoding) {
    if (encoding.toLowerCase() !== 'chunked') throw new EventError(-32015, 'invalid_response');
    let offset = 0;
    let decoded = '';
    for (;;) {
      const end = body.indexOf('\r\n', offset);
      if (end < 0) return null;
      const sizeLine = body.slice(offset, end);
      if (!/^[0-9a-f]{1,8}(?:;[^\r\n]*)?$/i.test(sizeLine)) throw new EventError(-32015, 'invalid_response');
      const size = parseInt(sizeLine, 16);
      if (size > 32_768) throw new EventError(-32015, 'response_too_large');
      if (size === 0) {
        if (body.slice(end + 2, end + 4) !== '\r\n') return null;
        body = decoded;
        break;
      }
      if (body.length < end + 2 + size + 2) return null;
      if (body.slice(end + 2 + size, end + 4 + size) !== '\r\n') throw new EventError(-32015, 'invalid_response');
      decoded += body.slice(end + 2, end + 2 + size);
      offset = end + 4 + size;
    }
  } else if (length) {
    if (!/^\d+$/.test(length) || Number(length) > 32_768) throw new EventError(-32015, 'invalid_response');
    if (new TextEncoder().encode(body).length < Number(length)) return null;
    // Verification challenges are ASCII. Reject ambiguous excess bytes.
    if (new TextEncoder().encode(body).length !== Number(length)) throw new EventError(-32015, 'invalid_response');
  } else if (!ended) return null;
  return new Response(body, { status: code, headers });
}
