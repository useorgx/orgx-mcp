import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_ID, SCRIPT_NAME, WINDOW_MS, DEADLINE_MS, MAX_RESPONSE_BYTES } from './cloudflare-read-only-audit.mjs';

export const KEY_EXPIRES_AT = '2026-11-16T18:42:45.914943Z';
export const KEY_EXPIRES_AT_MS = Date.parse(KEY_EXPIRES_AT);
export const REVIEWED_KEY_SHA256 = 'e92e497679fae469d9113a93f844957652547c163b81dbd2ce52dc37f937c837';
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEApdPczJleGCuVhJXto7Wj
oGAHjZRny6GQbtVhPPtVNxn0soNpBHRyLsJrwwQyUNmchXj8zqokL/YE8xyUBdxV
O7D6Zu7VD+lZcnJiw8c4k11DLMxzgL1k2rxdBJfkkWQoSUelRHOrY2yOHhCqvznC
ZD7OO/i6wagJ+sOwrYrUVh/q6VnF2PUIpQ8D27njAnmIvz6Nmf5Pjqt/BagqUEnL
VfMGTJBbV2Sp6UxmztAl/lkUiavmQzF0YDK/NOEUfJALetSxWTciG9YudiyP/926
jLZu0os7vVTI19vuf8Yj6vZZ4lCPdK5LgVG7M3mXP3GNMPZc0hrNXiTXrvGES1/n
QAeSmxOIg9ub7KCcrUOP7prdVzImSl/BpXxH0wlNAjziyVOPz5axuM5EVQQKSEm1
hvoT7M09SP/Y5hS9fWuNg4ay2JMo59AIUpJoayzEb9HvqNzaW0RZ8vwrfXoVMrFT
2DGlqLKB0b+Q0wJ5z64gxrxdmsMLVF/F1Q/Sc6BTIkOnYePIx+liB5ejQ5Yb4OxF
jkse7wrnxs36w/HNvNePIc30iw3e0L9Odp9Hutvx1LkIkPIjBjM2qQcVywot8me1
x/d1k7Z4rC7yoJ2L9VL9u0jg5E8+tlyGQ2QWUgnNaSE7cuUImSBNxiv0Rf9dhf28
HKmcBNo38zn79kVGpnaoLOECAwEAAQ==
-----END PUBLIC KEY-----
`;
export const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`;
export const SAMPLE_LIMIT = 8;
export const SCHEMA = 'orgx.cloudflare.encrypted-warning-sample.v1';
export const OUTPUT_PATH = 'artifacts/qa/cloudflare-warning-sample/encrypted-sample.json';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function warningSampleRequest(now) {
  return {
    queryId: 'orgx-fixed-private-warn-sample-v1', timeframe: { from: now - WINDOW_MS, to: now },
    dry: true, view: 'events', chart: false, compare: false, limit: SAMPLE_LIMIT,
    parameters: { datasets: ['cloudflare-workers'], filterCombination: 'and', filters: [
      { key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT_NAME },
      { key: '$metadata.level', operation: 'eq', type: 'string', value: 'warn' },
    ] },
  };
}

export function publicKeyFingerprint(key = PUBLIC_KEY_PEM) {
  const parsed = createPublicKey(key);
  if (parsed.asymmetricKeyType !== 'rsa' || parsed.asymmetricKeyDetails.modulusLength < 2048) throw new Error('invalid_recipient');
  return createHash('sha256').update(parsed.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Pure encryption helper; tests use an unrelated ephemeral recipient key. */
export function encryptWarningEvents(events, window, publicKey = PUBLIC_KEY_PEM) {
  if (!Array.isArray(events) || events.length > SAMPLE_LIMIT) throw new Error('invalid_sample');
  const context = {
    schema: SCHEMA, accountId: ACCOUNT_ID, worker: SCRIPT_NAME, level: 'warn', window,
    limit: SAMPLE_LIMIT, eventCount: events.length, keyExpiresAt: KEY_EXPIRES_AT,
    publicKeySha256: publicKeyFingerprint(publicKey),
  };
  const key = randomBytes(32), iv = randomBytes(12);
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify({ events }), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(context), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    return { status: 'encrypted', reason: 'warning_sample_encrypted', context,
      algorithm: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256',
      ciphertext: ciphertext.toString('base64'), wrappedKey: wrappedKey.toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

function eventsFromResponse(payload, timeframe) {
  const raw = record(payload), result = record(raw.result), run = record(result.run);
  if (raw.success !== true || Array.isArray(raw.errors) && raw.errors.length) throw new Error('query_refused');
  if (run.status !== 'COMPLETED' || run.dry !== true) throw new Error('query_incomplete');
  const events = record(result.events).events;
  if (!Array.isArray(events) || events.length > SAMPLE_LIMIT) throw new Error('invalid_sample');
  for (const event of events) {
    const row = record(event), metadata = record(row.$metadata);
    if (metadata.service !== SCRIPT_NAME || metadata.level !== 'warn' || row.dataset !== 'cloudflare-workers') throw new Error('sample_scope_unverified');
    if (typeof metadata.id !== 'string' || typeof row.source !== 'string' && (row.source === null || typeof row.source !== 'object' || Array.isArray(row.source))) throw new Error('invalid_sample');
    if (typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp) || row.timestamp < timeframe.from || row.timestamp > timeframe.to) throw new Error('sample_scope_unverified');
  }
  return events;
}

const SAFE_REASONS = new Set(['query_refused', 'query_incomplete', 'invalid_sample', 'sample_scope_unverified', 'response_byte_limit', 'invalid_api_json', 'key_expired', 'audit_deadline']);

/** One fixed POST. Raw bytes/events remain in memory and never enter output. */
export async function auditEncryptedWarningSample({ token, fetchImpl = fetch, now = Date.now() } = {}) {
  const enteredAt = performance.now();
  const window = { start: new Date(now - WINDOW_MS).toISOString(), end: new Date(now).toISOString() };
  const safe = { schema: SCHEMA, status: 'unavailable', reason: 'not_observed', worker: SCRIPT_NAME,
    window, eventCount: null, keyExpiresAt: KEY_EXPIRES_AT, publicKeySha256: REVIEWED_KEY_SHA256 };
  if (now >= KEY_EXPIRES_AT_MS) return { ...safe, reason: 'key_expired' };
  if (typeof token !== 'string' || !token.trim()) return { ...safe, reason: 'credential_unavailable' };
  try {
    if (publicKeyFingerprint() !== REVIEWED_KEY_SHA256) return { ...safe, reason: 'invalid_recipient' };
  } catch { return { ...safe, reason: 'invalid_recipient' }; }
  const body = warningSampleRequest(now);
  const controller = new AbortController();
  const allowedMs = Math.min(DEADLINE_MS, KEY_EXPIRES_AT_MS - now);
  const expiresAt = enteredAt + allowedMs;
  let reader, ended = false, bytes, timer;
  const check = () => {
    if (controller.signal.aborted || performance.now() >= expiresAt) throw new Error(allowedMs < DEADLINE_MS ? 'key_expired' : 'audit_deadline');
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(allowedMs < DEADLINE_MS ? 'key_expired' : 'audit_deadline')); }, Math.max(0, expiresAt - performance.now()));
  });
  try {
    return await Promise.race([(async () => {
      check();
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        check();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return { ...safe, reason: [401, 403].includes(response.status) ? 'permission_denied' : 'query_refused' };
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('invalid_api_json');
      bytes = new Uint8Array(MAX_RESPONSE_BYTES);
      let length = 0;
      for (;;) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) { ended = true; break; }
        if (length + chunk.value.byteLength > MAX_RESPONSE_BYTES) throw new Error('response_byte_limit');
        bytes.set(chunk.value, length); length += chunk.value.byteLength;
      }
      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
      catch { throw new Error('invalid_api_json'); }
      const events = eventsFromResponse(payload, body.timeframe);
      check();
      let encrypted;
      try { encrypted = encryptWarningEvents(events, window); }
      catch { return { ...safe, reason: 'encryption_failed' }; }
      check();
      return encrypted;
    })(), deadline]);
  } catch (error) {
    const reason = error instanceof Error && SAFE_REASONS.has(error.message) ? error.message : 'network_unavailable';
    return { ...safe, reason };
  } finally {
    clearTimeout(timer); controller.abort(); bytes?.fill(0);
    if (reader) {
      if (!ended) void reader.cancel('Private warning sample finished').catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export function formatEncryptedSampleSummary(result) {
  const count = result.status === 'encrypted' ? result.context.eventCount : 'Unknown';
  return `## Encrypted Cloudflare warning sample\n\nStatus: **${result.status}** (${result.reason}).\n\n` +
    `Encrypted events: **${count}**. Recipient expires: ${KEY_EXPIRES_AT}.\n\n` +
    'The artifact contains ciphertext and safe metadata only. This bounded sample is incomplete and has no documented event-order guarantee.\n';
}

export async function runEncryptedWarningSample({ token, fetchImpl = fetch, now = Date.now() } = {}) {
  const result = await auditEncryptedWarningSample({ token, fetchImpl, now });
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, formatEncryptedSampleSummary(result));
  console.log(`Encrypted warning sample: ${result.status} (${result.reason}).`);
  if (result.status !== 'encrypted') process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEncryptedWarningSample({ token: process.env.CLOUDFLARE_API_TOKEN }).catch(() => { console.error('Encrypted warning sample could not save its ciphertext-only result.'); process.exitCode = 1; });
}
