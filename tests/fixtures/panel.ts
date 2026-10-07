import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import { MCP_APPS_SHARED_COMPONENT_PATHS, sanitizeMcpAppsHtml } from '../../src/widgetConfig';
export const WS = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
export const D1 = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
export const D2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

export function snapshot(overrides: Record<string, unknown> = {}) {
  const queueItem = (id: string, title: string) => ({
    id, version: 'v1', title, urgency: 'high', waiting_since: '2026-09-30T10:00:00.000Z', initiative_title: 'Release',
    blocked: false, decide_in_orgx_reason: null, url: `https://useorgx.com/decisions/${id}`,
  });
  return {
    schema: 'orgx.panel.v1',
    generated_at: '2026-10-02T12:00:00.000Z',
    state: 'ok',
    workspace: { id: WS, name: 'Acme' },
    attention: { pending: 2, oldest_at: '2026-09-30T10:00:00.000Z', blocking: false },
    queue: [queueItem(D1, 'Ship release 4.2?'), queueItem(D2, 'Rotate keys?')],
    focus: {
      type: 'decision', id: D1, version: 'v1', question: 'Ship release 4.2?', urgency: 'high',
      waiting_since: '2026-09-30T10:00:00.000Z', initiative_title: 'Release',
      recommendation: { status: 'ready', action: 'Approve' }, evidence: [], evidence_total: 0,
      consequence_if_approved: 'It ships.', consequence_if_rejected: null, blocked: false,
      decide_in_orgx_reason: null, url: `https://useorgx.com/decisions/${D1}`,
    },
    selection: { requested_id: null, status: 'default' },
    proof: { last_accepted: null, completed_unaccepted: 0 },
    degraded: [],
    ...overrides,
  };
}

export async function mountPanel(hostContext: Record<string, unknown>, capabilities: Record<string, unknown>) {
  const widgets = resolve(process.cwd(), 'public/widgets');
  const html = readFileSync(resolve(widgets, 'orgx-panel.html'), 'utf8');
  const sharedComponents: Record<string, string> = {};
  for (const path of MCP_APPS_SHARED_COMPONENT_PATHS) {
    sharedComponents[path] = path === 'shared/mcp-apps-sdk.umd.js'
      ? 'window.McpApps = window.__FakeMcpApps;'
      : readFileSync(resolve(widgets, path), 'utf8');
  }
  const served = sanitizeMcpAppsHtml(html, {
    interactionKitCss: '',
    interactionKitJs: readFileSync(resolve(widgets, 'shared/interaction-kit.js'), 'utf8'),
    sharedComponents,
  });

  const calls = {
    updateModelContext: vi.fn(async () => ({ _meta: { 'openai/modelContext': { updateId: 'upd-9' } } })),
    callServerTool: vi.fn(async () => ({ structuredContent: snapshot({ generated_at: '2026-10-02T12:05:00.000Z' }) })),
    sendMessage: vi.fn(),
    openLink: vi.fn(async () => ({})),
  };
  let app: Record<string, any> | null = null;
  const dom = new JSDOM(served, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://mcp.useorgx.test/widgets/orgx-panel.html',
    beforeParse(win) {
      Object.defineProperty(win, 'parent', { configurable: true, value: { postMessage: () => {} } });
      (win as unknown as Record<string, unknown>).__FakeMcpApps = {
        App: class FakeApp {
          context = hostContext;
          constructor() {
            app = this as unknown as Record<string, any>;
          }
          connect = vi.fn(async () => undefined);
          getHostContext = () => this.context;
          getHostCapabilities = () => capabilities;
          updateModelContext = calls.updateModelContext;
          callServerTool = calls.callServerTool;
          sendMessage = calls.sendMessage;
          openLink = calls.openLink;
          close = vi.fn();
        },
        applyDocumentTheme: () => {},
      };
    },
  });
  const flush = () => new Promise((r) => dom.window.setTimeout(r, 0));
  await flush();
  await flush();
  return { dom, app: () => app!, calls, flush };
}
