import {
  MCP_APPS_SHARED_COMPONENT_PATHS,
  mcpAppsInlineAssetPath,
} from './widgetConfig';

/** Resource reads must finish before the host gives up opening the widget. */
export const WIDGET_RESOURCE_TIMEOUT_MS = 5_000;
const ASSET_CONCURRENCY = 6;

export interface WidgetAssetText {
  status: number;
  ok: boolean;
  text: string;
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let text = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw signal.reason;
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/**
 * One deadline includes response bodies and all shared assets. The ASSETS
 * binding avoids sending every resource dependency back through the public
 * edge; deployments without the binding retain the public-asset path.
 */
export function createWidgetAssetReader(
  assets: Pick<Fetcher, 'fetch'> | undefined,
  baseUrl: string,
  timeoutMs = WIDGET_RESOURCE_TIMEOUT_MS
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Widget resource loading timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  async function readResponse(
    load: (signal: AbortSignal) => Promise<Response>
  ): Promise<WidgetAssetText> {
    return Promise.race([
      (async () => {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        const response = await load(controller.signal);
        // Consume the body inside the deadline, rather than timing only headers.
        const text = response.ok ? await readText(response, controller.signal) : '';
        if (!response.ok) void response.body?.cancel().catch(() => {});
        return { status: response.status, ok: response.ok, text };
      })(),
      deadline,
    ]);
  }

  function readAsset(path: string, accept: string) {
    return readResponse((signal) => {
      const request = new Request(new URL(path, baseUrl), {
        headers: { accept },
        signal,
      });
      return assets ? assets.fetch(request) : fetch(request);
    });
  }

  async function readInlineAsset(path: string): Promise<string | null> {
    const accept = path.endsWith('.css')
      ? 'text/css,*/*'
      : 'text/javascript,application/javascript,*/*';
    for (const candidate of [mcpAppsInlineAssetPath(path), path]) {
      const response = await readAsset(candidate, accept);
      if (response.ok) return response.text;
    }
    return null;
  }

  async function readInlineAssets(html: string) {
    const paths = [
      'shared/interaction-kit.css',
      'shared/interaction-kit.js',
      ...MCP_APPS_SHARED_COMPONENT_PATHS,
    ].filter((path) => html.includes(path));
    const result: Record<string, string | null> = {};
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, paths.length) }, async () => {
      while (next < paths.length) {
        const path = paths[next++];
        try {
          result[path] = await readInlineAsset(path);
        } catch {
          result[path] = null;
        }
      }
    }));
    if (controller.signal.aborted) {
      throw new Error('Widget resource loading timed out');
    }
    return result;
  }

  return {
    readAsset,
    readResponse,
    readInlineAssets,
    dispose: () => clearTimeout(timer),
  };
}
