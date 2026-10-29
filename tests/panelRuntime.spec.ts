// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/widget-runtime.js';

const runtime = (window as unknown as {
  OrgXWidgetRuntime: {
    __resetForTests(): void;
    initWidget(options: Record<string, unknown>): unknown;
  };
}).OrgXWidgetRuntime;
const originalParent = window.parent;

describe('opt-in panel runtime', () => {
  afterEach(() => {
    runtime.__resetForTests();
    delete (window as unknown as { McpApps?: unknown }).McpApps;
    delete (window as unknown as { openai?: unknown }).openai;
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
  });

  it('registers the initial-result callback before connect, uses it once, and disposes its listener', async () => {
    let app: {
      ontoolresult?: (result: unknown) => void;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      getHostContext: ReturnType<typeof vi.fn>;
      callServerTool: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    } | null = null;
    const payload = { schema: 'orgx.panel.v1', state: 'ok' };

    class FakeApp {
      ontoolresult?: (result: unknown) => void;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      getHostContext = vi.fn().mockReturnValue({ theme: 'light' });
      callServerTool = vi.fn();
      close = vi.fn();
      connect = vi.fn(async () => {
        expect(this.ontoolresult).toBeTypeOf('function');
        this.ontoolresult?.({ structuredContent: payload });
      });

      constructor() {
        app = this;
      }
    }

    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: vi.fn() } });
    (window as unknown as { McpApps: unknown }).McpApps = { App: FakeApp };
    const render = vi.fn();
    const controller = runtime.initWidget({ bridge: 'mcp-apps-sdk', render }) as {
      ready: Promise<void>;
      getApp(): unknown;
      getExtensions(): unknown;
      getData(): unknown;
      dispose(): void;
    };

    await controller.ready;

    expect(render).toHaveBeenNthCalledWith(1, null);
    expect(render).toHaveBeenLastCalledWith(payload);
    expect(controller.getData()).toEqual(payload);
    expect(controller.getApp()).toBe(app);
    expect(controller.getExtensions()).toBeNull();
    expect(app!.addEventListener).toHaveBeenCalledTimes(1);
    expect(app!.addEventListener).toHaveBeenCalledWith('hostcontextchanged', expect.any(Function));
    expect(app!.callServerTool).not.toHaveBeenCalled();

    controller.dispose();
    expect(app!.removeEventListener).toHaveBeenCalledTimes(1);
    expect(app!.removeEventListener).toHaveBeenCalledWith('hostcontextchanged', expect.any(Function));
    expect(app!.close).toHaveBeenCalledTimes(1);
    app!.ontoolresult?.({ structuredContent: { state: 'late' } });
    expect(render).toHaveBeenLastCalledWith(payload);
  });

  it('keeps existing non-opt-in widgets on the ChatGPT window.openai result path', () => {
    class FakeApp {
      connect = vi.fn();
    }
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: vi.fn() } });
    (window as unknown as { McpApps: unknown }).McpApps = { App: FakeApp };
    const chatgptPayload = { origin: 'window.openai' };
    (window as unknown as { openai: unknown }).openai = { toolOutput: chatgptPayload };
    const render = vi.fn();

    runtime.initWidget({ render });

    expect(render).toHaveBeenCalledWith(chatgptPayload);
    expect(runtime.detectProtocol()).toBe('chatgpt');
  });
});
