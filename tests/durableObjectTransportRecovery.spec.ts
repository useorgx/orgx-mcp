import { describe, expect, it, vi } from 'vitest';

import {
  EXPECTED_DURABLE_OBJECT_DEPLOY_RESET,
  recoverDurableObjectTransportRequest,
  shouldRetryDurableObjectTransportRequest,
} from '../src/durableObjectTransportRecovery';

function durableObjectError(
  message: string,
  properties: Record<string, unknown> = {},
) {
  return Object.assign(new Error(message), properties);
}

describe('Durable Object transport recovery', () => {
  it.each(['GET', 'HEAD', 'DELETE'])(
    'retries retryable %s requests once with a fresh request',
    async (method) => {
      const request = new Request('https://mcp.useorgx.com/mcp', { method });
      const fetcher = vi.fn(async () => new Response('recovered'));

      const result = await recoverDurableObjectTransportRequest(
        request,
        durableObjectError('transient internal error', { retryable: true }),
        fetcher,
        { delayMs: 0 },
      );

      expect(result.retried).toBe(true);
      expect(await result.response?.text()).toBe('recovered');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).not.toBe(request);
    },
  );

  it.each([
    EXPECTED_DURABLE_OBJECT_DEPLOY_RESET,
    'Durable Object storage operation exceeded timeout which caused object to be reset.',
    'internal error; reference = 8nh1jobu9hnkcgi2v22uqe58',
    'Internal error in Durable Object storage caused object to be reset; reference = daa1kaheu5iq2ojl2fgquadg',
    'Internal error while starting up Durable Object storage caused object to be reset; reference = 5ldq0rva4k7tmh2oaat71a31',
  ])('retries the exact Cloudflare transient message: %s', (message) => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'GET',
    });

    expect(
      shouldRetryDurableObjectTransportRequest(request, new Error(message)),
    ).toBe(true);
  });

  it.each([
    'internal error',
    'internal error; reference =',
    'internal error; reference = abc with trailing context',
    'Internal error in Durable Object storage caused object to be reset.',
    'Internal error while starting up Durable Object storage caused object to be reset.',
    'Internal error while starting up Durable Object storage caused object to be reset; reference = abc with trailing context',
    'application internal error; reference = abc123',
  ])('does not retry a non-matching application error: %s', (message) => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'GET',
    });

    expect(
      shouldRetryDurableObjectTransportRequest(request, new Error(message)),
    ).toBe(false);
  });

  it('does not retry overloaded Durable Objects', () => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'GET',
    });
    const error = durableObjectError('overloaded', {
      overloaded: true,
      retryable: true,
    });

    expect(shouldRetryDurableObjectTransportRequest(request, error)).toBe(
      false,
    );
  });

  it.each([
    'transient internal error',
    'Internal error in Durable Object storage caused object to be reset; reference = hgg3lskugo2gd02g27ptv5tu',
    'Internal error while starting up Durable Object storage caused object to be reset; reference = 5ldq0rva4k7tmh2oaat71a31',
  ])('does not retry POST tool calls for %s even when Cloudflare marks the error retryable', (message) => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'POST',
      body: '{}',
    });

    expect(
      shouldRetryDurableObjectTransportRequest(
        request,
        durableObjectError(message, { retryable: true }),
      ),
    ).toBe(false);
  });

  it('returns the retry error when the fresh stub attempt also fails', async () => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'DELETE',
    });
    const retryError = new Error('retry failed');

    const result = await recoverDurableObjectTransportRequest(
      request,
      durableObjectError('transient internal error', { retryable: true }),
      vi.fn(async () => {
        throw retryError;
      }),
      { delayMs: 0 },
    );

    expect(result).toEqual({
      error: retryError,
      response: null,
      retried: true,
    });
  });
});
