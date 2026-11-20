import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiJson } from '../src/orgxApi';
import { currentReadInvocationBudget } from '../src/readInvocationBudget';
import { installSessionToolObservationWrapper } from '../src/sessionSummary';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-invocation-budget-test',
};
type Handler = (...args: unknown[]) => unknown;
function registry() {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: Record<string, unknown>, handler: Handler) => handlers.set(name, handler) };
  installSessionToolObservationWrapper(server as never, () => {});
  return { server, handlers };
}
function stalledFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
  }));
}

describe('registered tool read invocation budget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shares ten seconds between sequential API requests, including read-only POST execution', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return Response.json({ data: { id: 'authorized-workspace' } });
      })
      .mockImplementation(stalledFetch());
    vi.stubGlobal('fetch', fetch);
    const { server, handlers } = registry();
    server.registerTool('read_fixture', { annotations: { readOnlyHint: true } }, async () => {
      await callOrgxApiJson(env, '/api/identity', undefined, { allowFallback: false });
      return callOrgxApiJson(env, '/api/tools/execute', { method: 'POST', body: '{"tool_id":"get_agent_status"}' });
    });
    let settled = false;
    const result = Promise.resolve(handlers.get('read_fixture')!({}, {})).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'upstream_timeout', status: 504 } } });
    expect(fetch).toHaveBeenCalledTimes(2); // The POST remains ineligible for fallback.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['orgx_search', 'orgx_get_next_actions', 'orgx_get_agent_status', 'orgx_get_initiative_progress'])(
    'bounds metered %s despite its truthful readOnlyHint:false annotation', async (name) => {
      vi.useFakeTimers();
      const { server, handlers } = registry();
      let signal: AbortSignal | undefined;
      server.registerTool(name, { annotations: { readOnlyHint: false } }, () => {
        signal = currentReadInvocationBudget()?.signal;
        return new Promise(() => {});
      });
      const result = handlers.get(name)!({}, {});

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'upstream_timeout' } } });
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('inherits the outer read deadline across nested compatibility wrappers', async () => {
    vi.useFakeTimers();
    const { server, handlers } = registry();
    let outerDeadline: number | undefined;
    let innerDeadline: number | undefined;
    server.registerTool('legacy_read', { annotations: { readOnlyHint: true } }, () => {
      innerDeadline = currentReadInvocationBudget()?.deadline;
      return new Promise(() => {});
    });
    server.registerTool('orgx_search', { annotations: { readOnlyHint: false } }, async () => {
      outerDeadline = currentReadInvocationBudget()?.deadline;
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return handlers.get('legacy_read')!({}, {});
    });
    const result = handlers.get('orgx_search')!({}, {});

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toMatchObject({ isError: true });
    expect(innerDeadline).toBe(outerDeadline);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the active read and refuses a caught-error retry before another fetch', async () => {
    vi.useFakeTimers();
    const fetch = stalledFetch();
    vi.stubGlobal('fetch', fetch);
    const { server, handlers } = registry();
    let retried = false;
    let secondFailure: unknown;
    server.registerTool('orgx_search', {}, async () => {
      try {
        await callOrgxApiJson(env, '/api/read');
      } catch {
        retried = true;
        try { await callOrgxApiJson(env, '/api/read-again'); }
        catch (error) { secondFailure = error; }
      }
      return { content: [] };
    });
    const controller = new AbortController();
    const result = handlers.get('orgx_search')!({}, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'request_cancelled' } } });
    expect(retried).toBe(true);
    expect(secondFailure).toMatchObject({ message: 'The request was cancelled.' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not impose the read budget on unknown or mutating commands', async () => {
    vi.useFakeTimers();
    const { server, handlers } = registry();
    const budgets: unknown[] = [];
    for (const name of ['unknown_command', 'orgx_start_agent_task']) server.registerTool(name, { annotations: { readOnlyHint: false } }, async () => {
      budgets.push(currentReadInvocationBudget());
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const results = [...handlers.values()].map((handler) => handler({}, {}));

    await vi.advanceTimersByTimeAsync(12_000);

    for (const result of results) await expect(result).resolves.toMatchObject({ content: [{ text: 'done' }] });
    expect(budgets).toEqual([undefined, undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not run a read handler when its SDK request was already cancelled', async () => {
    vi.useFakeTimers();
    const { server, handlers } = registry();
    const run = vi.fn();
    server.registerTool('orgx_search', {}, run);
    const controller = new AbortController();
    controller.abort();

    await expect(handlers.get('orgx_search')!({}, { signal: controller.signal })).resolves.toMatchObject({ isError: true });

    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a successful scope before a detached child can start more API I/O', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({ data: {} }));
    vi.stubGlobal('fetch', fetch);
    const { server, handlers } = registry();
    let detachedError: unknown;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let child: Promise<void> | undefined;
    server.registerTool('orgx_search', {}, () => {
      child = (async () => {
        await pending;
        try { await callOrgxApiJson(env, '/api/detached'); }
        catch (error) { detachedError = error; }
      })();
      return { content: [{ type: 'text', text: 'done' }] };
    });

    await expect(handlers.get('orgx_search')!({}, {})).resolves.toMatchObject({ content: [{ text: 'done' }] });
    release();
    await child;

    expect(detachedError).toMatchObject({ message: 'The request was cancelled.' });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
