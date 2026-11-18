import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWidgetAssetReader } from '../src/widgetAssetReader';
import { MCP_APPS_SHARED_COMPONENT_PATHS } from '../src/widgetConfig';

const baseUrl = 'https://mcp.useorgx.test/widgets/';
const readers: ReturnType<typeof createWidgetAssetReader>[] = [];
const reader = (
  fetchAsset?: (request: Request) => Promise<Response>,
  timeoutMs?: number
) => {
  const value = createWidgetAssetReader(
    fetchAsset ? { fetch: fetchAsset } as Pick<Fetcher, 'fetch'> : undefined,
    baseUrl,
    timeoutMs
  );
  readers.push(value);
  return value;
};

afterEach(() => {
  for (const value of readers.splice(0)) value.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('widget resource asset delivery', () => {
  it('reads versioned assets through the binding without a public edge request', async () => {
    const publicFetch = vi.fn();
    vi.stubGlobal('fetch', publicFetch);
    const binding = vi.fn(async () => new Response('<main>Widget</main>'));
    const assets = reader(binding);
    await expect(assets.readAsset('orgx-panel.html?v=version-1', 'text/html'))
      .resolves.toEqual({ status: 200, ok: true, text: '<main>Widget</main>' });
    const request = binding.mock.calls[0][0] as Request;
    expect(request.url).toBe(baseUrl + 'orgx-panel.html?v=version-1');
    expect(request.headers.get('accept')).toBe('text/html');
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('retains the public-asset path when the binding is unavailable', async () => {
    const publicFetch = vi.fn(async () => new Response('public widget'));
    vi.stubGlobal('fetch', publicFetch);
    await expect(reader().readAsset('decisions.html', 'text/html'))
      .resolves.toMatchObject({ text: 'public widget' });
    const request = publicFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(baseUrl + 'decisions.html');
    expect(request.signal).toBeDefined();
  });

  it('falls back from a missing minified asset to its readable source', async () => {
    const binding = vi.fn(async (request: Request) => request.url.includes('/inline/')
      ? new Response(null, { status: 404 })
      : new Response('window.Widget = true;'));
    const assets = reader(binding);
    const result = await assets.readInlineAssets('<script src="shared/widget-runtime.js"></script>');
    expect(result['shared/widget-runtime.js']).toBe('window.Widget = true;');
    expect(binding.mock.calls.map(([request]) => request.url)).toEqual([
      baseUrl + 'inline/shared/widget-runtime.js',
      baseUrl + 'shared/widget-runtime.js',
    ]);
  });

  it('loads dependencies concurrently while respecting the connection limit', async () => {
    vi.useFakeTimers();
    const paths = MCP_APPS_SHARED_COMPONENT_PATHS.slice(0, 12);
    let active = 0;
    let peak = 0;
    const assets = reader(async (request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response(request.url);
    });
    const result = assets.readInlineAssets(paths.join('\n'));
    await vi.advanceTimersByTimeAsync(20);
    expect(Object.keys(await result)).toEqual(expect.arrayContaining(paths));
    expect(peak).toBe(6);
  });

  it('bounds an asset fetch even when the binding ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const assets = reader((request) => {
      signal = request.signal;
      return new Promise(() => {});
    }, 100);
    const result = expect(assets.readAsset('decisions.html', 'text/html'))
      .rejects.toThrow('Widget resource loading timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it('includes a stalled response body in the deadline and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const assets = reader(async () => new Response(body), 100);
    const result = expect(assets.readAsset('decisions.html', 'text/html'))
      .rejects.toThrow('Widget resource loading timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('cancels a body returned after the deadline by a binding that ignored abort', async () => {
    vi.useFakeTimers();
    let deliver: (response: Response) => void = () => {};
    const assets = reader(() => new Promise<Response>((resolve) => { deliver = resolve; }), 100);
    const result = expect(assets.readAsset('decisions.html', 'text/html'))
      .rejects.toThrow('Widget resource loading timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    deliver(new Response(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('shares its deadline with the API fallback instead of restarting a timeout', async () => {
    vi.useFakeTimers();
    const assets = reader(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return new Response(null, { status: 404 });
    }, 100);
    const initial = assets.readAsset('decisions.html', 'text/html');
    await vi.advanceTimersByTimeAsync(70);
    await initial;
    let signal: AbortSignal | undefined;
    const fallback = expect(assets.readResponse((inputSignal) => {
      signal = inputSignal;
      return new Promise(() => {});
    })).rejects.toThrow('timed out after 100ms');
    await vi.advanceTimersByTimeAsync(30);
    await fallback;
    expect(signal?.aborted).toBe(true);
  });
});
