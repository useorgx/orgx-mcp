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
    document.body.innerHTML = '';
    delete (window as unknown as { McpApps?: unknown }).McpApps;
    delete (window as unknown as { openai?: unknown }).openai;
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    });
  });

  it.each([
    { ok: false, error: { message: 'Upstream unavailable' } },
    { isError: true, content: [{ type: 'text', text: '{"error":{"message":"Upstream unavailable"}}' }] },
  ])('shows a failed initial result and recovers without rendering it as success: %j', (toolOutput) => {
    document.body.innerHTML = '<main id="content">Awaiting context</main>';
    (window as unknown as { openai: unknown }).openai = { toolOutput, setWidgetHeight: vi.fn() };
    const render = vi.fn();
    runtime.initWidget({ render });
    expect(render).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Upstream unavailable');
    expect(document.getElementById('content')?.hidden).toBe(true);
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: null } } }));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: { message: 'Recovered' } } } }));
    expect(render).toHaveBeenLastCalledWith({ message: 'Recovered' });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.getElementById('content')?.hidden).toBe(false);
  });

  it('rejects a failed action result so callers cannot report a successful approval', async () => {
    (window as unknown as { openai: unknown }).openai = {
      callTool: vi.fn().mockResolvedValue({ isError: true, structuredContent: { error: { message: 'Approval rejected' } } }),
    };
    await expect(runtime.callTool('approve_decision', { decision_id: 'd-1' })).rejects.toThrow('Approval rejected');
  });

  it('rejects instead of resolving null when the ChatGPT bridge cannot call tools', async () => {
    (window as unknown as { openai: unknown }).openai = { toolOutput: {} };
    await expect(runtime.callTool('approve_decision', { decision_id: 'd-1' })).rejects.toMatchObject({
      code: 'host_unavailable',
    });
  });

  it('rejects in standalone mode so a preview never reports an action as done', async () => {
    await expect(runtime.callTool('reject_decision', { decision_id: 'd-1', reason: 'x' })).rejects.toMatchObject({
      code: 'host_unavailable',
    });
  });

  it.each([
    { isError: true, content: [{ type: 'text', text: '{"error":{"code":"human_session_required","message":"Approval requires a signed-in person"}}' }] },
    { structuredContent: { ok: false, error: { code: 'human_session_required', message: 'Approval requires a signed-in person' } } },
  ])('rejects a failed MCP Apps action result: %j', async (result) => {
    class FakeApp {
      connect = vi.fn().mockResolvedValue(undefined);
      getHostContext = vi.fn().mockReturnValue({});
      callServerTool = vi.fn().mockResolvedValue(result);
      close = vi.fn();
    }
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: vi.fn() } });
    (window as unknown as { McpApps: unknown }).McpApps = { App: FakeApp, applyDocumentTheme: vi.fn() };
    runtime.initWidget({ render: vi.fn() });
    await expect(runtime.callTool('approve_decision', { decision_id: 'd-1' })).rejects.toMatchObject({
      code: 'human_session_required',
      message: 'Approval requires a signed-in person',
    });
  });

  it.each([
    { degraded: ['brief_route_timeout'], metrics: { completed: 0 } },
    { degraded: true, results: [{ id: 'partial-result' }] },
    { structuredContent: { data: { degraded: ['source_unavailable'], results: [] } } },
  ])('discloses partial data, retains usable content and clears the notice after recovery: %j', (toolOutput) => {
    document.body.innerHTML = '<main id="content">Usable partial results</main>';
    (window as unknown as { openai: unknown }).openai = { toolOutput, setWidgetHeight: vi.fn() };
    const render = vi.fn();
    runtime.initWidget({ render });
    expect(render).toHaveBeenCalledOnce();
    expect(document.getElementById('content')?.hidden).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Data may be incomplete');
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain('brief_route_timeout');
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: null } } }));
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: { degraded: false, metrics: { completed: 2 } } } } }));
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(render).toHaveBeenLastCalledWith({ degraded: false, metrics: { completed: 2 } });
  });

  it('replaces a partial-data notice with an actual tool failure', () => {
    (window as unknown as { openai: unknown }).openai = { toolOutput: { degraded: true }, setWidgetHeight: vi.fn() };
    runtime.initWidget({ render: vi.fn() });
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: { ok: false, error: 'Upstream unavailable' } } } }));
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Upstream unavailable');
  });

  it.each([{}, { degraded: false }, { degraded: [] }])('does not mark a complete result as partial: %j', (toolOutput) => {
    (window as unknown as { openai: unknown }).openai = { toolOutput, setWidgetHeight: vi.fn() };
    runtime.initWidget({ render: vi.fn() });
    expect(document.querySelector('[role="status"]')).toBeNull();
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

  it('ignores an older host result so a re-render cannot move state backwards', () => {
    const rendered: unknown[] = [];
    (window as unknown as { openai: unknown }).openai = {
      toolOutput: { status: 'completed', updated_at: '2026-08-27T00:02:00.000Z' },
      setWidgetHeight: vi.fn(),
    };

    runtime.initWidget({ render: (value) => rendered.push(value) });
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: {
          globals: {
            toolOutput: { status: 'in_progress', updated_at: '2026-08-27T00:01:00.000Z' },
          },
        },
      })
    );

    expect(rendered).toEqual([
      { status: 'completed', updated_at: '2026-08-27T00:02:00.000Z' },
    ]);
  });

  it('keeps a terminal snapshot when a same-timestamp replay is less advanced', () => {
    const rendered: unknown[] = [];
    (window as unknown as { openai: unknown }).openai = {
      toolOutput: { status: 'completed', updated_at: '2026-08-27T00:02:00.000Z' },
      setWidgetHeight: vi.fn(),
    };

    runtime.initWidget({ render: (value) => rendered.push(value) });
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', {
        detail: {
          globals: {
            toolOutput: { status: 'in_progress', updated_at: '2026-08-27T00:02:00.000Z' },
          },
        },
      })
    );

    expect(rendered).toEqual([
      { status: 'completed', updated_at: '2026-08-27T00:02:00.000Z' },
    ]);
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
