import { describe, expect, it, vi } from 'vitest';
import { boundWidgetEvent, buildWidgetTelemetryContext, handleWidgetTelemetry, WIDGET_EVENTS } from '../src/widgetTelemetry';
import { sanitizeWorkerTelemetryProperties } from '../src/workerTelemetryPrivacy';

const now = Date.parse('2026-10-10T07:00:00Z');
const WS = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
function environment() {
  const values = new Map<string, string>();
  return {
    MCP_JWT_SECRET: 'test-secret-with-no-production-authority', MCP_SERVER_URL: 'https://mcp.useorgx.com',
    OAUTH_KV: { get: async (key: string) => values.get(key) ?? null, put: async (key: string, value: string) => { values.set(key, value); } },
    values,
  };
}
function request(body: unknown, contentType = 'application/json') {
  return new Request('https://mcp.useorgx.com/telemetry/widget', { method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('widget telemetry grant and endpoint', () => {
  it('forwards a bounded batch on a valid grant, on the viewer and workspace the grant names', async () => {
    const env = environment();
    const context = (await buildWidgetTelemetryContext(env, { widget: 'orgx-panel', userId: 'user_1', workspaceId: WS }, now))!;
    expect(context.endpoint).toBe('https://mcp.useorgx.com/telemetry/widget');
    const report = vi.fn();
    const body = { grant: context.grant, protocol: 'chatgpt', events: [
      { name: 'panel_opened', props: { host: 'chatgpt', platform: 'mobile', display_mode: 'fullscreen', ttfc_ms: 812.4, cold: false } },
      { name: 'panel_read', props: { panel_read_kind: 'receipts', panel_trigger: 'warm', latency_ms: 1203, ok: false, error_code: 'upstream_error', title: 'Ship release 4.2?' } },
      { name: 'not_an_event', props: { anything: 'x' } },
    ] };
    expect((await handleWidgetTelemetry(request(body), env, report, now))!.status).toBe(204);
    expect(report).toHaveBeenCalledTimes(1);
    const sent = report.mock.calls[0]![0];
    expect(sent).toMatchObject({ widget: 'orgx-panel', protocol: 'chatgpt', subject: 'user_1', workspaceId: WS });
    expect(sent.events).toEqual([
      { name: 'panel_opened', properties: { host: 'chatgpt', platform: 'mobile', display_mode: 'fullscreen', ttfc_ms: 812, cold: false } },
      { name: 'panel_read', properties: { panel_read_kind: 'receipts', panel_trigger: 'warm', latency_ms: 1203, ok: false, error_code: 'upstream_error' } },
    ]);
    expect(JSON.stringify(sent)).not.toContain('Ship release');
    expect(JSON.stringify(sent)).not.toContain(context.grant);
  });

  it('rejects forged or expired grants, unknown shapes, and free text without reporting', async () => {
    const env = environment();
    const context = (await buildWidgetTelemetryContext(env, { widget: 'orgx-panel' }, now))!;
    const report = vi.fn();
    const ok = { grant: context.grant, protocol: 'chatgpt', events: [{ name: 'panel_tour', props: { panel_tour_outcome: 'finished', step_index: 5 } }] };
    expect((await handleWidgetTelemetry(request({ ...ok, grant: 'forged' }), env, report, now))!.status).toBe(401);
    expect((await handleWidgetTelemetry(request(ok), env, report, now + 4 * 3600 * 1000 + 5000))!.status).toBe(401);
    expect((await handleWidgetTelemetry(request({ ...ok, query: 'private' }), env, report, now))!.status).toBe(400);
    expect((await handleWidgetTelemetry(request({ ...ok, protocol: 'telnet' }), env, report, now))!.status).toBe(400);
    expect((await handleWidgetTelemetry(request({ ...ok, events: [] }), env, report, now))!.status).toBe(400);
    expect((await handleWidgetTelemetry(request({ ...ok, events: [{ name: 'panel_tour', props: { panel_tour_outcome: 'I pressed the thing and it broke' } }] }), env, report, now))!.status).toBe(204);
    // The free-text value was dropped; the event itself still counts.
    expect(report.mock.calls[0]![0].events).toEqual([{ name: 'panel_tour', properties: {} }]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('bounds the body, the batch, and what one grant may send over its life', async () => {
    const env = environment();
    const context = (await buildWidgetTelemetryContext(env, { widget: 'orgx-panel' }, now))!;
    const report = vi.fn();
    expect((await handleWidgetTelemetry(request('x'.repeat(9000)), env, report, now))!.status).toBe(413);
    const many = { grant: context.grant, protocol: 'mcp-apps-sdk', events: Array.from({ length: 26 }, () => ({ name: 'panel_tab_switched', props: {} })) };
    expect((await handleWidgetTelemetry(request(many), env, report, now))!.status).toBe(400);
    const batch = { ...many, events: many.events.slice(0, 25) };
    for (let i = 0; i < 16; i += 1) expect((await handleWidgetTelemetry(request(batch), env, report, now))!.status).toBe(204);
    expect((await handleWidgetTelemetry(request(batch), env, report, now))!.status).toBe(429);
    expect(report).toHaveBeenCalledTimes(16);
    expect((await handleWidgetTelemetry(new Request('https://mcp.useorgx.com/telemetry/widget'), env, report, now))!.status).toBe(405);
    expect(await handleWidgetTelemetry(new Request('https://mcp.useorgx.com/telemetry/other', { method: 'POST' }), env, report, now)).toBeNull();
  });

  it('accepts a keepalive flush sent as text/plain, since a closing page cannot always set JSON', async () => {
    const env = environment();
    const context = (await buildWidgetTelemetryContext(env, { widget: 'orgx-panel' }, now))!;
    const report = vi.fn();
    const body = { grant: context.grant, protocol: 'chatgpt', events: [{ name: 'panel_decision', props: { panel_decision_action: 'approve', panel_outcome: 'confirmed', latency_ms: 2400, ok: true } }] };
    expect((await handleWidgetTelemetry(request(body, 'text/plain;charset=UTF-8'), env, report, now))!.status).toBe(204);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('every property an event may carry survives the worker privacy boundary', () => {
    const sample: Record<string, unknown> = {
      host: 'claude', platform: 'desktop', display_mode: 'inline', safe_source: 'none', cold: true, ttfc_ms: 420,
      panel_from_tab: 'needs', panel_tab: 'work', latency_ms: 180, warm: true,
      panel_read_kind: 'history', panel_trigger: 'range', ok: true, error_code: 'timeout',
      panel_decision_action: 'reject', panel_outcome: 'validation',
      panel_verb: 'delegate', agent_picked: true,
      panel_error_code: 'offline', panel_tour_outcome: 'skipped', step_index: 2,
    };
    const kept = sanitizeWorkerTelemetryProperties(sample);
    for (const key of new Set(Object.values(WIDGET_EVENTS).flat())) {
      expect(kept, `${key} dropped by the privacy boundary`).toHaveProperty(key);
    }
    expect(sanitizeWorkerTelemetryProperties({ host: 'someone-elses-app' })).toEqual({ host: 'other' });
  });

  it('rounds and bounds numbers, and drops strings that are not labels', () => {
    expect(boundWidgetEvent({ name: 'panel_read', props: { latency_ms: 12.6, ok: 'yes', panel_read_kind: 'a b', error_code: 'x'.repeat(49) } }))
      .toEqual({ name: 'panel_read', properties: { latency_ms: 13 } });
    expect(boundWidgetEvent({ name: 'panel_read', props: { latency_ms: -1 } })).toEqual({ name: 'panel_read', properties: {} });
    expect(boundWidgetEvent({ name: 'panel_read', props: { latency_ms: Number.POSITIVE_INFINITY } })).toEqual({ name: 'panel_read', properties: {} });
    expect(boundWidgetEvent({ name: 'nope' })).toBeNull();
  });
});
