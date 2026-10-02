// @vitest-environment jsdom

/**
 * Widget runtime error contract (live-QA A7) and the legacy tool aliases.
 *
 * Every rejection from callTool / callToolResult is { code, message, details }:
 * a human message, the raw host text only in details.raw, and the server's own
 * refusal codes unchanged. Widgets render copy from `code`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/widget-runtime.js';

type ToolError = Error & { code: string; details: Record<string, unknown>; tool: string | null };

interface WidgetRuntime {
  __resetForTests(): void;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  callToolResult(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; meta: unknown }>;
  normalizeToolError(error: unknown, tool?: string): ToolError;
  getToolCallState(): { inputSeen: boolean; resultSeen: boolean; awaitingResult: boolean };
  initWidget(options: Record<string, unknown>): unknown;
  TOOL_ERROR_CODES: string[];
}

const runtime = (window as unknown as { OrgXWidgetRuntime: WidgetRuntime }).OrgXWidgetRuntime;

function useChatGpt(callTool: (...args: unknown[]) => unknown) {
  (window as unknown as { openai: unknown }).openai = { callTool: vi.fn(callTool), setWidgetHeight: vi.fn() };
  return (window as unknown as { openai: { callTool: ReturnType<typeof vi.fn> } }).openai.callTool;
}

async function rejection(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    return error as ToolError;
  }
  throw new Error('expected a rejection');
}

const RAW_JSON_SNIPPET = /[{}"]/;

describe('widget runtime tool errors', () => {
  afterEach(() => {
    runtime.__resetForTests();
    document.body.innerHTML = '';
    delete (window as unknown as { openai?: unknown }).openai;
  });

  it('publishes the runtime codes widgets render copy from', () => {
    expect(runtime.TOOL_ERROR_CODES).toEqual(['tool_unavailable', 'network', 'host_unavailable', 'tool_failed']);
  });

  it.each([
    ['ChatGPT pretty-printed host 404', new Error('{\n  "detail": "MCP Resource not found"\n}')],
    ['ChatGPT compact host 404', new Error('{"detail":"MCP Resource not found"}')],
    ['MCP unknown tool', new Error('MCP error -32602: Tool orgx_widget_decide not found')],
    ['disabled tool', new Error('Tool orgx_widget_decide disabled')],
  ])('maps %s to tool_unavailable with a human message', async (_label, hostError) => {
    useChatGpt(() => Promise.reject(hostError));
    const error = await rejection(runtime.callTool('orgx_widget_decide', { decision_id: 'd1' }));
    expect(error.code).toBe('tool_unavailable');
    expect(error.message).not.toMatch(RAW_JSON_SNIPPET);
    expect(error.message).toMatch(/OrgX/);
    expect(error.details.raw).toBe(hostError.message);
    expect(error.tool).toBe('orgx_widget_decide');
  });

  it('treats a host error body resolved as a result as a failure, not a success', async () => {
    useChatGpt(() => Promise.resolve({ detail: 'MCP Resource not found' }));
    const error = await rejection(runtime.callTool('orgx_command_status', { kind: 'run', id: 'r1' }));
    expect(error.code).toBe('tool_unavailable');
    expect(error.details.raw).toContain('MCP Resource not found');
  });

  it('maps an isError result whose text is the host body to tool_unavailable', async () => {
    useChatGpt(() =>
      Promise.resolve({ isError: true, content: [{ type: 'text', text: '{"detail":"MCP Resource not found"}' }] })
    );
    const error = await rejection(runtime.callTool('orgx_widget_decide', {}));
    expect(error.code).toBe('tool_unavailable');
    expect(error.message).not.toMatch(RAW_JSON_SNIPPET);
  });

  it.each([
    new TypeError('Failed to fetch'),
    new Error('NetworkError when attempting to fetch resource.'),
    new Error('tools/call timed out'),
    new Error('502 Bad Gateway'),
  ])('maps transport failure %s to network', async (hostError) => {
    useChatGpt(() => Promise.reject(hostError));
    const error = await rejection(runtime.callTool('orgx_search', { query: 'x' }));
    expect(error.code).toBe('network');
    expect(error.message).toMatch(/reach OrgX/);
    expect(error.details.raw).toBe(hostError.message);
  });

  it('turns a synchronous host throw into a normalized rejection', async () => {
    useChatGpt(() => {
      throw new Error('{"detail":"MCP Resource not found"}');
    });
    const error = await rejection(runtime.callTool('orgx_widget_decide', {}));
    expect(error.code).toBe('tool_unavailable');
  });

  it('keeps server refusal codes, messages and details unchanged', async () => {
    useChatGpt(() =>
      Promise.resolve({
        structuredContent: {
          ok: false,
          error: {
            code: 'widget_view_out_of_date',
            message: 'This view is out of date.',
            details: { widget_actions: { kind: 'decision' } },
          },
        },
      })
    );
    const error = await rejection(runtime.callTool('orgx_widget_decide', {}));
    expect(error.code).toBe('widget_view_out_of_date');
    expect(error.message).toBe('This view is out of date.');
    expect(error.details).toEqual({ widget_actions: { kind: 'decision' } });
    expect(error.details).not.toHaveProperty('raw');
  });

  it('replaces a raw server message but keeps its refusal code', () => {
    const error = runtime.normalizeToolError(Object.assign(new Error('{"x":1}'), { code: 'conflict' }));
    expect(error.code).toBe('conflict');
    expect(error.message).not.toMatch(RAW_JSON_SNIPPET);
    expect(error.details.raw).toBe('{"x":1}');
  });

  it('keeps a worded unclassified failure and hides an unreadable one', () => {
    const worded = runtime.normalizeToolError(new Error('Decision already settled elsewhere'));
    expect(worded).toMatchObject({ code: 'tool_failed', message: 'Decision already settled elsewhere' });
    const lone = runtime.normalizeToolError(new Error('{'));
    expect(lone.code).toBe('tool_failed');
    expect(lone.message).not.toBe('{');
    expect(lone.details.raw).toBe('{');
  });

  it('keeps host_unavailable when there is no host bridge', async () => {
    const error = await rejection(runtime.callTool('orgx_search', {}));
    expect(error.code).toBe('host_unavailable');
  });

  it('normalizes callToolResult rejections the same way', async () => {
    useChatGpt(() => Promise.reject(new Error('{"detail":"MCP Resource not found"}')));
    const error = await rejection(runtime.callToolResult('get_pending_decisions', {}));
    expect(error.code).toBe('tool_unavailable');
    expect(error.tool).toBe('get_pending_decisions');
  });

  it('never prints a raw host payload in the initial-result alert', () => {
    (window as unknown as { openai: unknown }).openai = {
      toolOutput: { isError: true, content: [{ type: 'text', text: '{\n "detail": "MCP Resource not found"\n}' }] },
      setWidgetHeight: vi.fn(),
    };
    runtime.initWidget({ render: vi.fn() });
    const alert = document.querySelector('[role="alert"] p')?.textContent ?? '';
    expect(alert).not.toMatch(RAW_JSON_SNIPPET);
    expect(alert).toMatch(/OrgX/);
  });
});

describe('widget runtime tool aliases', () => {
  afterEach(() => {
    runtime.__resetForTests();
    delete (window as unknown as { openai?: unknown }).openai;
  });

  it('sends get_pending_decisions as orgx_decide list_pending and returns its _meta', async () => {
    const callTool = useChatGpt(() =>
      Promise.resolve({
        structuredContent: { decisions: [] },
        _meta: { 'orgx/widgetApproval': { approval_tokens: {} } },
      })
    );
    const result = await runtime.callToolResult('get_pending_decisions', { initiative_id: 'i1' });
    expect(callTool).toHaveBeenCalledWith('orgx_decide', { initiative_id: 'i1', action: 'list_pending' });
    expect(result.meta).toEqual({ 'orgx/widgetApproval': { approval_tokens: {} } });
  });

  it('leaves canonical tool names untouched', async () => {
    const callTool = useChatGpt(() => Promise.resolve({ structuredContent: { ok: true } }));
    await runtime.callTool('orgx_widget_decide', { decision_id: 'd1' });
    expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', { decision_id: 'd1' });
  });
});

describe('widget runtime tool-input state', () => {
  afterEach(() => {
    runtime.__resetForTests();
    delete (window as unknown as { openai?: unknown }).openai;
  });

  it('reports input seen with no result yet, then the result', () => {
    const onToolInput = vi.fn();
    (window as unknown as { openai: unknown }).openai = {
      toolInput: { query: 'x' },
      toolOutput: null,
      setWidgetHeight: vi.fn(),
    };
    runtime.initWidget({ render: vi.fn(), onToolInput });
    expect(onToolInput).toHaveBeenCalledWith(expect.objectContaining({ inputSeen: true, awaitingResult: true }));
    expect(runtime.getToolCallState()).toMatchObject({ inputSeen: true, resultSeen: false, awaitingResult: true });
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: { ok: true } } } }));
    expect(runtime.getToolCallState()).toMatchObject({ resultSeen: true, awaitingResult: false });
  });
});

describe('widget runtime input tracker', () => {
  it('marks the last input on <html> once, like interaction-kit.js', () => {
    expect((document as unknown as { __oxInput?: number }).__oxInput).toBe(1);
    document.dispatchEvent(new Event('pointerdown'));
    expect(document.documentElement.getAttribute('data-ox-input')).toBe('pointer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.documentElement.getAttribute('data-ox-input')).toBe('keyboard');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));
    expect(document.documentElement.getAttribute('data-ox-input')).toBe('keyboard');
  });
});
