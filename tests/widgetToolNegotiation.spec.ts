// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../public/widgets/shared/widget-runtime.js';

interface Runtime {
  __resetForTests(): void;
  callToolResult(name: string, args: Record<string, unknown>): Promise<unknown>;
  callWidgetRead(name: string, args: Record<string, unknown>): Promise<unknown>;
  callWidgetToolResult(name: string, args: Record<string, unknown>): Promise<unknown>;
  getWidgetToolName(operation: string): string | null;
}
const runtime = (window as unknown as { OrgXWidgetRuntime: Runtime }).OrgXWidgetRuntime;

function host(
  surface?: Record<string, unknown>,
  implementation: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({ structuredContent: { ok: true } })
) {
  const callTool = vi.fn(implementation);
  (window as unknown as { openai: unknown }).openai = {
    callTool, toolResponseMetadata: surface ? { 'orgx/toolSurface': surface } : null,
  };
  return callTool;
}

function capabilities(tools: string[], widgetTools: Record<string, string>, legacy = false) {
  return { contract_version: legacy ? 'orgx-mcp-legacy/1' : 'orgx-mcp-operations/1', profile: legacy ? 'legacy' : 'chatgpt', tools, widget_tools: widgetTools };
}

afterEach(() => {
  runtime.__resetForTests();
  delete (window as unknown as { openai?: unknown }).openai;
});

describe('widget tools use the current operation contract', () => {
  it('dispatches the explicit status read once with its original arguments', async () => {
    const callTool = host(capabilities(['orgx_get_operation_status'], { operation_status: 'orgx_get_operation_status' }));
    await runtime.callWidgetRead('orgx_get_operation_status', { kind: 'decision', id: 'd1' });
    expect(callTool).toHaveBeenCalledExactlyOnceWith('orgx_get_operation_status', { kind: 'decision', id: 'd1' });
  });

  it('sends only the explicit workspace selector input', async () => {
    const callTool = host(capabilities(['orgx_widget_select_workspace'], { workspace_select: 'orgx_widget_select_workspace' }));
    await runtime.callWidgetToolResult('orgx_widget_select_workspace', { workspace_id: 'w1', force: true });
    expect(callTool).toHaveBeenCalledExactlyOnceWith('orgx_widget_select_workspace', { workspace_id: 'w1' });
  });

  it('never retries a failed workspace write under another name', async () => {
    const callTool = host(capabilities(['orgx_widget_select_workspace', 'orgx_bootstrap'], { workspace_select: 'orgx_widget_select_workspace' }), async () => {
      throw new Error('MCP Resource not found');
    });
    await expect(runtime.callWidgetToolResult('orgx_widget_select_workspace', { workspace_id: 'w1' })).rejects.toMatchObject({ code: 'tool_unavailable' });
    expect(callTool).toHaveBeenCalledExactlyOnceWith('orgx_widget_select_workspace', { workspace_id: 'w1' });
  });

  it.each([
    capabilities(['orgx_widget_select_workspace'], { workspace_select: 'orgx_bootstrap' }),
    capabilities(['orgx_bootstrap'], { workspace_select: 'orgx_bootstrap' }, true),
    capabilities(['orgx_act'], { workspace_select: 'orgx_act' }),
    { contract_version: 'unknown', tools: ['orgx_widget_select_workspace'], widget_tools: { workspace_select: 'orgx_widget_select_workspace' } },
  ])('refuses an unlisted or unknown workspace contract', async (surface) => {
    const callTool = host(surface);
    await expect(runtime.callWidgetToolResult('orgx_widget_select_workspace', { workspace_id: 'w1' })).rejects.toMatchObject({ code: 'tool_unavailable' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports a missing descriptor and never dispatches a fallback tool', async () => {
    const callTool = host();
    callTool.mockRejectedValueOnce(new Error('MCP error -32602: Tool orgx_get_work_receipt not found'));
    await expect(runtime.callWidgetRead('orgx_get_work_receipt', { receipt_id: 'r1' })).rejects.toMatchObject({ code: 'tool_unavailable' });
    await runtime.callWidgetRead('orgx_get_work_receipt', { receipt_id: 'r2' });
    expect(callTool.mock.calls).toEqual([
      ['orgx_get_work_receipt', { receipt_id: 'r1' }],
      ['orgx_get_work_receipt', { receipt_id: 'r2' }],
    ]);
  });

  it.each([
    new Error('HTTP 404: MCP Resource not found'),
    Object.assign(new Error('MCP Resource not found'), { status: 404 }),
    new Error('Unknown resource'),
    new Error('Network request failed'),
    new Error('Tool orgx_get_work_receipt disabled'),
  ])('does not fall back for backend, transport, policy or ambiguous errors', async (failure) => {
    const callTool = host(undefined, async () => { throw failure; });
    await expect(runtime.callWidgetRead('orgx_get_work_receipt', { receipt_id: 'r1' })).rejects.toBeInstanceOf(Error);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for a dispatched server refusal with a misleading missing-tool message', async () => {
    const callTool = host(undefined, async () => ({ structuredContent: { ok: false, error: { code: 'not_found', message: 'MCP Resource not found' } } }));
    await expect(runtime.callWidgetRead('orgx_get_work_receipt', { receipt_id: 'r1' })).rejects.toMatchObject({ code: 'not_found' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses arbitrary operations even if they were advertised as a read', async () => {
    const callTool = host();
    await expect(runtime.callWidgetRead('orgx_cancel_work', { id: 'i1' })).rejects.toMatchObject({ code: 'host_unavailable' });
    expect(callTool).not.toHaveBeenCalled();
  });
});
