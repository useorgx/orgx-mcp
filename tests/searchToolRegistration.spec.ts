import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/openaiOutputSchemas', () => ({ getToolOutputSchema: () => undefined }));
vi.mock('../src/toolGuidance', () => ({ sanitizeToolResultGuidance: (result: unknown) => result }));
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

describe('search result registration', () => {
  it('adds diagnostics and its verified health field to successful search only', async () => {
    let wrapped: (...args: unknown[]) => Promise<any>;
    const registerTool = vi.fn((_name, _config, handler) => { wrapped = handler; });
    const context = vi.fn().mockResolvedValue({ meta: { grant: 'signed' }, health: { failed: 1 } });
    const server = { registerTool };
    installToolResultGuidanceWrapper(server as any, null, undefined, context);
    server.registerTool('orgx_search', {}, async () => ({ structuredContent: { results: [] } }));
    const result = await wrapped!();
    expect(result.structuredContent.search_widget_health).toEqual({ failed: 1 });
    expect(result._meta['orgx/searchPayload']).toEqual({ results: [] });
    expect(result._meta['orgx/widgetDiagnostics']).toEqual({ grant: 'signed' });
    server.registerTool('orgx_inspect', {}, async () => ({ structuredContent: { entity: {} } }));
    expect(await wrapped!()).toEqual({ structuredContent: { entity: {} } });
    expect(context).toHaveBeenCalledTimes(1);
  });
  it('does not break healthy results when diagnostics are unavailable', async () => {
    let wrapped: (...args: unknown[]) => Promise<any>;
    const server = { registerTool: vi.fn((_name, _config, handler) => { wrapped = handler; }) };
    installToolResultGuidanceWrapper(server as any, null, undefined, vi.fn().mockRejectedValue(new Error('KV unavailable')));
    server.registerTool('orgx_search', {}, async () => ({ structuredContent: { results: [] } }));
    expect((await wrapped!()).structuredContent).toEqual({ results: [] });
  });
});
