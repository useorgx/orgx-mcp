// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/widget-runtime.js';

interface WidgetRuntime {
  __resetForTests(): void;
  applyTheme(value: string, source?: string): string | null;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  detectProtocol(): string;
  getErrorMessage(value: unknown, fallback?: string): string;
  getTheme(): string | null;
  getWidgetSessionId(): string | null;
  initWidget(options: { render(value: unknown): void }): unknown;
  openWidgetLink(url: string, event?: Event): boolean;
  persistWidgetState(state: Record<string, unknown>): Promise<unknown>;
  requestDisplayMode(mode: string): Promise<unknown>;
  sendFollowUpMessage(prompt: string): Promise<unknown>;
  updateModelContext(payload: Record<string, unknown>): Promise<unknown>;
}

const runtime = (
  window as unknown as { OrgXWidgetRuntime: WidgetRuntime }
).OrgXWidgetRuntime;
const originalParent = window.parent;

describe('shared OrgX widget runtime', () => {
  afterEach(() => {
    runtime.__resetForTests();
    delete (window as unknown as { McpApps?: unknown }).McpApps;
    delete (window as unknown as { openai?: unknown }).openai;
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });
  });

  it('routes official MCP Apps actions through one connected SDK app', async () => {
    let app: {
      callServerTool: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      getHostContext: ReturnType<typeof vi.fn>;
      openLink: ReturnType<typeof vi.fn>;
      requestDisplayMode: ReturnType<typeof vi.fn>;
      updateModelContext: ReturnType<typeof vi.fn>;
      ontoolresult?: (result: unknown) => void;
      onhostcontextchanged?: (context: Record<string, unknown>) => void;
    } | null = null;

    class FakeApp {
      connect = vi.fn().mockResolvedValue(undefined);
      getHostContext = vi.fn().mockReturnValue({ theme: 'dark' });
      callServerTool = vi.fn().mockResolvedValue({ structuredContent: { ok: true } });
      openLink = vi.fn().mockResolvedValue(undefined);
      updateModelContext = vi.fn().mockResolvedValue(undefined);
      requestDisplayMode = vi.fn().mockResolvedValue({ mode: 'fullscreen' });
      close = vi.fn();
      ontoolresult?: (result: unknown) => void;
      onhostcontextchanged?: (context: Record<string, unknown>) => void;

      constructor() {
        app = this;
      }
    }

    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
    (window as unknown as { McpApps: unknown }).McpApps = {
      App: FakeApp,
      applyDocumentTheme: vi.fn(),
    };

    const rendered: unknown[] = [];
    runtime.initWidget({ render: (value) => rendered.push(value) });
    await vi.waitFor(() => expect(app).not.toBeNull());
    expect(runtime.detectProtocol()).toBe('mcp-apps-sdk');
    expect(rendered).toEqual([null]);

    await expect(runtime.callTool('approve_decision', { decision_id: 'd1' })).resolves.toEqual({ ok: true });
    await runtime.updateModelContext({ structuredContent: { action: 'approved' } });
    await runtime.requestDisplayMode('fullscreen');
    expect(runtime.openWidgetLink('https://useorgx.com/decisions')).toBe(false);
    await vi.waitFor(() => expect(app!.openLink).toHaveBeenCalled());

    expect(app!.connect).toHaveBeenCalledTimes(1);
    expect(app!.callServerTool).toHaveBeenCalledWith({
      name: 'approve_decision',
      arguments: { decision_id: 'd1' },
    });
    expect(app!.updateModelContext).toHaveBeenCalledWith({
      structuredContent: { action: 'approved' },
    });
    expect(app!.requestDisplayMode).toHaveBeenCalledWith({ mode: 'fullscreen' });
  });

  it('persists ChatGPT widget state and narrates a completed operator action', async () => {
    const setWidgetState = vi.fn().mockResolvedValue(undefined);
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { openai: unknown }).openai = {
      widgetSessionId: 'widget-session-1',
      setWidgetState,
      sendFollowUpMessage,
    };

    expect(runtime.detectProtocol()).toBe('chatgpt');
    expect(runtime.getWidgetSessionId()).toBe('widget-session-1');
    await runtime.persistWidgetState({ currentPage: 2 });
    await runtime.sendFollowUpMessage('Decision approved.');

    expect(setWidgetState).toHaveBeenCalledWith({ currentPage: 2 });
    expect(sendFollowUpMessage).toHaveBeenCalledWith({
      prompt: 'Decision approved.',
    });
  });

  it('applies ChatGPT theme changes without requiring a new tool payload', () => {
    const rendered: unknown[] = [];
    (window as unknown as { openai: unknown }).openai = {
      theme: 'dark',
      toolOutput: { status: 'ready' },
      setWidgetHeight: vi.fn(),
    };

    runtime.initWidget({ render: (value) => rendered.push(value) });
    expect(runtime.getTheme()).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('host');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: { globals: { theme: 'light' } },
      })
    );

    expect(runtime.getTheme()).toBe('light');
    expect(rendered).toEqual([{ status: 'ready' }]);
  });

  it('exposes one normalized theme setter for non-host integrations', () => {
    expect(runtime.applyTheme('dark', 'test')).toBe('dark');
    expect(runtime.getTheme()).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('test');
    expect(runtime.applyTheme('sepia', 'test')).toBeNull();
    expect(runtime.getTheme()).toBe('dark');
  });

  it('turns structured host errors into readable widget copy', () => {
    expect(runtime.getErrorMessage({ message: 'Search timed out', code: 'timeout' })).toBe(
      'Search timed out'
    );
    expect(runtime.getErrorMessage({ error: { detail: 'Connection lost' } })).toBe(
      'Connection lost'
    );
    expect(runtime.getErrorMessage({}, 'Search unavailable')).toBe('Search unavailable');
    expect(runtime.getErrorMessage({ code: 'upstream_unavailable' })).toBe(
      'upstream_unavailable'
    );
    expect(runtime.getErrorMessage({})).not.toBe('[object Object]');
  });
});
