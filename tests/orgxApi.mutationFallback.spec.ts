import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiJson } from '../src/orgxApi';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-test-service-key',
  ORGX_API_TIMEOUT_MS: '200',
  ORGX_API_PRIMARY_TIMEOUT_MS: '20',
};

const hosts = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([url]) => new URL(String(url)).host);

describe('OrgX API fallback for writes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never re-sends a POST that got a 5xx from the primary', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: false, error: 'Run r1 was created but not claimed', message: 'Run r1 was created but not claimed' }, { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callOrgxApiJson(env, '/api/tools/execute', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'Run r1 was created but not claimed',
    });
    expect(hosts(fetchMock)).toEqual(['primary.example.test']);
  });

  it('gives a POST the full timeout instead of the short primary one', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return Response.json({ ok: true, data: { run_id: 'r1' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await callOrgxApiJson(env, '/api/tools/execute', { method: 'POST', body: '{}' });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(hosts(fetchMock)).toEqual(['primary.example.test']);
  });

  it('still falls back for reads and keyed writes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await callOrgxApiJson(env, '/api/entities');
    await callOrgxApiJson(env, '/api/decisions', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'k1' } });
    expect(hosts(fetchMock)).toEqual(['primary.example.test', 'fallback.example.test', 'primary.example.test', 'fallback.example.test']);
  });
});
