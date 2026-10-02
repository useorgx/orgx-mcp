import { describe, expect, it, vi } from 'vitest';
import { buildSearchDiagnosticsContext, handleSearchWidgetDiagnostics, readSearchWidgetHealth } from '../src/searchWidgetDiagnostics';

const now = Date.parse('2026-10-02T04:00:00Z');
function environment() {
  const values = new Map<string, string>();
  return { MCP_JWT_SECRET: 'test-secret-with-no-production-authority', MCP_SERVER_URL: 'https://mcp.useorgx.com', OAUTH_KV: {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value); },
  } };
}
function request(body: unknown) { return new Request('https://mcp.useorgx.com/telemetry/search-widget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
describe('signed search widget diagnostics', () => {
  it('records a widget failure and exposes a private-data-free alert signal in future searches', async () => {
    const env = environment();
    const context = (await buildSearchDiagnosticsContext(env, now))!;
    const report = vi.fn();
    const body = { grant: context.meta.grant, code: 'incomplete_response', protocol: 'chatgpt' };
    expect((await handleSearchWidgetDiagnostics(request(body), env, report, now))!.status).toBe(204);
    expect((await handleSearchWidgetDiagnostics(request(body), env, report, now))!.status).toBe(204);
    expect(report).toHaveBeenCalledTimes(1);
    const next = (await readSearchWidgetHealth(env, now + 1000))!;
    expect(next).toMatchObject({ failed: 1, latest_failure_code: 'incomplete_response' });
    expect(JSON.stringify(report.mock.calls)).not.toContain(context.meta.grant);
  });
  it('rejects forged/expired grants and free text without reporting', async () => {
    const env = environment();
    const context = (await buildSearchDiagnosticsContext(env, now))!;
    const report = vi.fn();
    expect((await handleSearchWidgetDiagnostics(request({ grant: 'forged', code: 'tool_error', protocol: 'chatgpt' }), env, report, now))!.status).toBe(401);
    const valid = { grant: context.meta.grant, code: 'tool_error', protocol: 'chatgpt' };
    expect((await handleSearchWidgetDiagnostics(request(valid), env, report, now + 901_000))!.status).toBe(401);
    expect((await handleSearchWidgetDiagnostics(request({ ...valid, query: 'private' }), env, report, now))!.status).toBe(400);
    expect((await handleSearchWidgetDiagnostics(request({ ...valid, code: 'private query' }), env, report, now))!.status).toBe(400);
    expect(report).not.toHaveBeenCalled();
  });
  it('bounds unauthenticated input and does not expose a read endpoint', async () => {
    const env = environment();
    expect((await handleSearchWidgetDiagnostics(request({ text: 'x'.repeat(3000) }), env, vi.fn(), now))!.status).toBe(413);
    expect((await handleSearchWidgetDiagnostics(new Request('https://mcp.useorgx.com/telemetry/search-widget'), env, vi.fn(), now))!.status).toBe(405);
  });
});
