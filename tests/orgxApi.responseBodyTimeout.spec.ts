import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiJson, OrgXApiError } from '../src/orgxApi';

const env = {
  ORGX_API_URL: 'https://api.example.test',
  ORGX_SERVICE_KEY: 'oxk-test-service-key',
  ORGX_API_TIMEOUT_MS: '25',
};

describe('OrgX API response body deadline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buffers a complete JSON body for downstream callers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, data: { id: 'initiative-1' } })
      )
    );

    const response = await callOrgxApiJson(env, '/api/test');

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { id: 'initiative-1' },
    });
  });

  it('fails with a structured error when headers arrive but the body stalls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const startedAt = Date.now();
    await expect(callOrgxApiJson(env, '/api/stalled')).rejects.toMatchObject({
      name: 'OrgXApiError',
      message: 'The request took too long. Please try again.',
    } satisfies Partial<OrgXApiError>);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('does not let a successful HTML fallback mask a structured primary failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'upstream_unavailable', message: 'try later' } },
          { status: 503 }
        )
      )
      .mockResolvedValueOnce(
        new Response('<!doctype html><title>Application</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callOrgxApiJson(
        {
          ...env,
          ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
        },
        '/api/v1/events/stream'
      )
    ).rejects.toMatchObject({
      name: 'OrgXApiError',
      message: 'OrgX is temporarily unavailable. Please try again later.',
      statusCode: 503,
      internalDetails: expect.stringContaining(
        'returned text/html; charset=utf-8 instead of application/json'
      ),
    } satisfies Partial<OrgXApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
