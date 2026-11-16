import assert from 'node:assert/strict';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ appendFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }));
vi.mock('node:fs/promises', () => fs);
import {
  ENDPOINT, KEY_EXPIRES_AT, KEY_EXPIRES_AT_MS, OUTPUT_PATH, PUBLIC_KEY_PEM, REVIEWED_KEY_SHA256, SAMPLE_LIMIT,
  auditEncryptedWarningSample, encryptWarningEvents, formatEncryptedSampleSummary, publicKeyFingerprint,
  runEncryptedWarningSample, warningSampleRequest,
} from '../scripts/cloudflare-encrypted-warning-sample.mjs';

const NOW = Date.parse('2026-11-16T17:00:00Z');
const TOKEN = 'SYNTHETIC_TOKEN_FIXTURE';
const PRIVATE_MESSAGE = 'SYNTHETIC_PRIVATE_WARNING_FIXTURE';
const PRIVATE_HEADER = 'SYNTHETIC_PRIVATE_HEADER_FIXTURE';
const PRIVATE_ID = 'SYNTHETIC_PRIVATE_ID_FIXTURE';
const PRIVATE_API_ERROR = 'SYNTHETIC_PRIVATE_API_ERROR_FIXTURE';
const window = { start: new Date(NOW - 3_600_000).toISOString(), end: new Date(NOW).toISOString() };
const fixtureRecipient = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fixturePublicKey = fixtureRecipient.publicKey.export({ type: 'spki', format: 'pem' });

const event = () => ({ dataset: 'cloudflare-workers', timestamp: NOW - 100,
  $metadata: { id: PRIVATE_ID, service: 'orgx-mcp-production', level: 'warn', message: PRIVATE_MESSAGE },
  source: { message: PRIVATE_MESSAGE, authorization: PRIVATE_HEADER, requestId: PRIVATE_ID },
});
const response = (events: unknown[] = [event()]) => ({ success: true, result: {
  run: { status: 'COMPLETED', dry: true, userId: PRIVATE_ID, query: { name: PRIVATE_MESSAGE } },
  events: { events, count: 90, fields: [{ key: PRIVATE_MESSAGE }], series: [] },
} });
const forbidden = [TOKEN, PRIVATE_MESSAGE, PRIVATE_HEADER, PRIVATE_ID, PRIVATE_API_ERROR];
function assertCiphertextOnly(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of forbidden) expect(text).not.toContain(secret);
}
function decrypt(envelope: any) {
  const key = privateDecrypt({ key: fixtureRecipient.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.context)));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } finally { key.fill(0); }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.clearAllMocks(); process.exitCode = undefined; });

describe('hybrid encryption to the reviewed short-lived public recipient', () => {
  it('roundtrips with an unrelated ephemeral fixture key and authenticates context', () => {
    const envelope = encryptWarningEvents([event()], window, fixturePublicKey);
    expect(decrypt(envelope)).toEqual({ events: [event()] });
    expect(envelope.context).toMatchObject({ schema: 'orgx.cloudflare.encrypted-warning-sample.v1', worker: 'orgx-mcp-production', window, eventCount: 1 });
    expect(envelope).toMatchObject({ algorithm: 'AES-256-GCM', keyWrap: 'RSA-OAEP-SHA256' });
    expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16);
    assertCiphertextOnly(envelope);
    const tampered = structuredClone(envelope);
    tampered.context.window.end = new Date(NOW + 1).toISOString();
    expect(() => decrypt(tampered)).toThrow();
    const tagTampered = structuredClone(envelope);
    const tag = Buffer.from(tagTampered.tag, 'base64'); tag[0] ^= 1; tagTampered.tag = tag.toString('base64');
    expect(() => decrypt(tagTampered)).toThrow();
  });

  it('uses fresh encryption material and the fixed reviewed public-key fingerprint', () => {
    const a = encryptWarningEvents([event()], window, fixturePublicKey);
    const b = encryptWarningEvents([event()], window, fixturePublicKey);
    expect(a.iv).not.toBe(b.iv); expect(a.wrappedKey).not.toBe(b.wrappedKey); expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(publicKeyFingerprint(PUBLIC_KEY_PEM)).toBe(REVIEWED_KEY_SHA256);
    expect(KEY_EXPIRES_AT).toBe('2026-11-16T18:42:45.914943Z');
    expect(() => encryptWarningEvents(Array.from({ length: SAMPLE_LIMIT + 1 }, event), window, fixturePublicKey)).toThrow('invalid_sample');
  });
});

describe('fixed bounded private warning read', () => {
  it('makes one fixed scoped event POST and returns only encrypted output', async () => {
    const fetchImpl = vi.fn(async () => Response.json(response()));
    const result = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl });
    expect(result.status).toBe('encrypted'); expect(fetchImpl).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual(warningSampleRequest(NOW));
    expect(warningSampleRequest(NOW)).toMatchObject({ view: 'events', dry: true, limit: 8,
      timeframe: { from: NOW - 3_600_000, to: NOW }, parameters: { datasets: ['cloudflare-workers'], filterCombination: 'and', filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: 'orgx-mcp-production' },
        { key: '$metadata.level', operation: 'eq', type: 'string', value: 'warn' },
      ] } });
    expect((result as any).context.eventCount).toBe(1);
    expect(Object.keys(result).sort()).toEqual(['status', 'reason', 'context', 'algorithm', 'keyWrap', 'ciphertext', 'wrappedKey', 'iv', 'tag'].sort());
    assertCiphertextOnly(result); assertCiphertextOnly(formatEncryptedSampleSummary(result));
  });

  it('writes and logs only ciphertext and safe metadata in the actual CLI runner', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => Response.json(response())) });
    expect(result.status).toBe('encrypted');
    expect(fs.writeFile).toHaveBeenCalledOnce();
    const [path, bytes, options] = fs.writeFile.mock.calls[0] as unknown as [string, string, unknown];
    expect(path).toBe(OUTPUT_PATH); expect(options).toEqual({ mode: 0o600 });
    expect(JSON.parse(bytes).status).toBe('encrypted');
    assertCiphertextOnly(bytes); assertCiphertextOnly(log.mock.calls); assertCiphertextOnly(error.mock.calls); assertCiphertextOnly(fs.appendFile.mock.calls);
  });

  it.each([KEY_EXPIRES_AT_MS, KEY_EXPIRES_AT_MS + 1])('rejects expiry before any fetch at %s', async (now) => {
    const fetchImpl = vi.fn();
    const result = await auditEncryptedWarningSample({ token: TOKEN, now, fetchImpl });
    expect(result.reason).toBe('key_expired'); expect(fetchImpl).not.toHaveBeenCalled(); assertCiphertextOnly(result);
  });

  it('makes no request without the existing credential', async () => {
    const fetchImpl = vi.fn();
    expect((await auditEncryptedWarningSample({ now: NOW, fetchImpl })).reason).toBe('credential_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('charges setup time to recipient expiry and rejects before fetching', async () => {
    let clock = 0;
    const original = Date.prototype.toISOString;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) {
      clock = 2;
      return original.call(this);
    });
    const fetchImpl = vi.fn();
    const result = await auditEncryptedWarningSample({ token: TOKEN, now: KEY_EXPIRES_AT_MS - 1, fetchImpl });
    expect(result.reason).toBe('key_expired');
    expect(fetchImpl).not.toHaveBeenCalled();
    assertCiphertextOnly(result);
  });

  it.each([
    (payload: any) => { payload.result.run.status = 'STARTED'; },
    (payload: any) => { payload.result.run.dry = false; },
    (payload: any) => { delete payload.result.events.events; },
    (payload: any) => { payload.result.events.events = Array.from({ length: 9 }, event); },
    (payload: any) => { payload.result.events.events[0].$metadata.service = PRIVATE_MESSAGE; },
    (payload: any) => { delete payload.result.events.events[0].$metadata.level; },
    (payload: any) => { payload.result.events.events[0].$metadata.level = 'info'; },
    (payload: any) => { payload.result.events.events[0].timestamp = NOW - 3_600_001; },
    (payload: any) => { payload.result.events.events[0].dataset = PRIVATE_MESSAGE; },
    (payload: any) => { delete payload.result.events.events[0].source; },
  ])('rejects incomplete, oversized or unverified event scope without retaining plaintext %#', async (mutate) => {
    const payload = response(); mutate(payload);
    const fetchImpl = vi.fn(async () => Response.json(payload));
    const result = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl });
    expect(result.status).toBe('unavailable'); expect((result as any).ciphertext).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce(); assertCiphertextOnly(result);
  });

  it('sanitizes provider/API/network exceptions and never returns their contents', async () => {
    const api = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => Response.json({ success: false, errors: [{ message: PRIVATE_API_ERROR }] })) });
    expect(api.reason).toBe('query_refused'); assertCiphertextOnly(api);
    const network = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => { throw new Error(PRIVATE_API_ERROR); }) });
    expect(network.reason).toBe('network_unavailable'); assertCiphertextOnly(network);
    const cancel = vi.fn();
    const denied = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 403 })) });
    expect(denied.reason).toBe('permission_denied'); expect(cancel).toHaveBeenCalledOnce(); assertCiphertextOnly(denied);
  });

  it('caps actual body bytes before EOF and cancels without persisting content', async () => {
    const cancel = vi.fn();
    const result = await auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel,
    }))) });
    expect(result.reason).toBe('response_byte_limit'); expect(cancel).toHaveBeenCalledOnce(); assertCiphertextOnly(result);
  });

  it('ends stalled body reads at the deadline without waiting for cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = auditEncryptedWarningSample({ token: TOKEN, now: NOW, fetchImpl: vi.fn(async () => new Response(new ReadableStream({ cancel }))) });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.reason).toBe('audit_deadline'); expect(cancel).toHaveBeenCalledOnce(); assertCiphertextOnly(result);
  });

  it('shortens the deadline at recipient expiry and cancels a late response', async () => {
    let deliver!: (response: Response) => void;
    const cancel = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = auditEncryptedWarningSample({ token: TOKEN, now: KEY_EXPIRES_AT_MS - 1000,
      fetchImpl: vi.fn(() => new Promise<Response>((resolve) => { deliver = resolve; })) });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.reason).toBe('key_expired');
    deliver(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); assertCiphertextOnly(result);
  });
});

const workflow = load(readFileSync(new URL('../.github/workflows/cloudflare-encrypted-warning-sample.yml', import.meta.url), 'utf8')) as any;
function assertWorkflow(value: any) {
  assert.deepEqual(value.on, { workflow_dispatch: null });
  assert.deepEqual(value.permissions, { contents: 'read' }); assert.equal(value.env, undefined);
  assert.deepEqual(Object.keys(value.jobs), ['sample']);
  const job = value.jobs.sample;
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' && github.repository == 'useorgx/orgx-mcp' && github.ref == 'refs/heads/main' }}");
  assert.equal(job.environment, 'production'); assert.equal(job.env, undefined); assert.equal(job['timeout-minutes'], 3);
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].run.trim(), "set -euo pipefail\ntest \"$GITHUB_REF\" = 'refs/heads/main'\ntest \"$GITHUB_REPOSITORY\" = 'useorgx/orgx-mcp'");
  assert.equal(job.steps[1].uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.deepEqual(job.steps[1].with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(job.steps[2].uses, 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
  assert.deepEqual(job.steps[2].with, { 'node-version': '22', 'package-manager-cache': false });
  assert.equal(job.steps[3].run, 'node scripts/cloudflare-encrypted-warning-sample.mjs');
  assert.deepEqual(job.steps[3].env, { CLOUDFLARE_API_TOKEN: '${{ secrets.CF_API_TOKEN }}' });
  assert.equal(job.steps[3]['timeout-minutes'], 1);
  assert.equal(job.steps[4].uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.equal(job.steps[4].if, 'always()');
  assert.deepEqual(job.steps[4].with, { name: 'cloudflare-warning-sample-encrypted', path: OUTPUT_PATH, 'if-no-files-found': 'ignore', 'retention-days': 1 });
  const withoutToken = structuredClone(value); delete withoutToken.jobs.sample.steps[3].env;
  assert.doesNotMatch(JSON.stringify(withoutToken), /secrets\./);
  assert.doesNotMatch(JSON.stringify(value), /inputs\.|workflow_call|pull_request_target|wrangler|pnpm|private.key|PRIVATE KEY/);
}
describe('dedicated encrypted sample workflow', () => {
  it('admits only trusted manual main and uploads only the encrypted result path', () => assertWorkflow(workflow));
  it.each([
    (value: any) => { value.on.workflow_dispatch = { inputs: { recipient: { type: 'string' } } }; },
    (value: any) => { value.jobs.sample.if = '${{ github.ref != null }}'; },
    (value: any) => { value.jobs.sample.steps[1].with.ref = '${{ github.ref }}'; },
    (value: any) => { value.jobs.sample.steps[1].with['persist-credentials'] = true; },
    (value: any) => { value.jobs.sample.env = { CLOUDFLARE_API_TOKEN: '${{ secrets.CF_API_TOKEN }}' }; },
    (value: any) => { value.jobs.sample.steps[4].with.path = 'artifacts/**'; },
    (value: any) => { value.jobs.sample.steps[4].with['retention-days'] = 7; },
    (value: any) => { value.permissions.contents = 'write'; },
  ])('rejects broader admission, credentials or artifact policy %#', (mutate) => {
    const changed = structuredClone(workflow); mutate(changed); expect(() => assertWorkflow(changed)).toThrow();
  });
});
