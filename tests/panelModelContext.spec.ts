// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/openai-extensions.js';
import { MCP_APPS_SHARED_COMPONENT_PATHS, sanitizeMcpAppsHtml } from '../src/widgetConfig';

type Payload = { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> };

interface Shim {
  buildSelectionContext(input: unknown): Payload | null;
  buildClearedContext(input: unknown): Payload;
  readSharedSelection(current: unknown, workspaceId: string | null): unknown;
  createExtensions(app: unknown): {
    modelContext?: { getCurrent(): unknown; update(params: Payload): Promise<unknown> };
  };
  createShareController(options: unknown): {
    shared: unknown;
    share(item: unknown, workspaceId: string): Promise<unknown>;
    stop(workspaceId: string): Promise<unknown>;
    restore(selection: unknown, workspaceId: string): void;
  };
  __onMessageForTests(event: unknown): void;
  __resetForTests(): void;
}

const shim = (window as unknown as { OrgXOpenAIExtensions: Shim }).OrgXOpenAIExtensions;

const WS = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const D1 = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
const D2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const INIT = 'c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f';
const URL_D1 = `https://useorgx.com/initiatives/${INIT}?focus=decisions&decision=${D1}`;

const ITEM = {
  id: D1,
  version: '2026-09-29T10:00:00.000Z',
  title: 'Ship release 4.2 to production?',
  urgency: 'critical',
  url: URL_D1,
  // Fields that must never travel into model context:
  evidence: [{ title: 'secret evidence' }],
  note: 'private note',
  approval_token: 'tok',
};

afterEach(() => {
  shim.__resetForTests();
});

describe('Share with chat payload', () => {
  it('is exactly the redacted facts-only selection', () => {
    expect(shim.buildSelectionContext({ item: ITEM, workspaceId: WS, sharedAt: '2026-10-02T12:00:00.000Z' })).toEqual({
      content: [{ type: 'text', text: `OrgX item: decision "Ship release 4.2 to production?" — pending, critical. ${URL_D1}` }],
      structuredContent: {
        schema: 'orgx.selection.v1',
        workspace_id: WS,
        entity: { type: 'decision', id: D1, version: '2026-09-29T10:00:00.000Z' },
        url: URL_D1,
        shared_at: '2026-10-02T12:00:00.000Z',
      },
    });
  });

  it('caps the title at 120 characters, strips quotes and control characters, and drops non-canonical links', () => {
    const payload = shim.buildSelectionContext({
      item: { ...ITEM, title: `Say "yes"\n\u0007 now ${'x'.repeat(300)}`, url: 'https://evil.com/decisions/' + D1, urgency: 'weird' },
      workspaceId: WS,
      sharedAt: 't',
    })!;
    const quoted = payload.content[0]!.text.match(/"(.*)"/)![1]!;
    expect(Array.from(quoted).length).toBe(120);
    expect(quoted.endsWith('…')).toBe(true);
    expect(quoted).not.toMatch(/["\n\u0007]/);
    expect(payload.content[0]!.text).toContain('— pending, medium.');
    expect(payload.content[0]!.text).not.toContain('evil.com');
    expect(payload.structuredContent.url).toBeNull();
    const serialized = JSON.stringify(payload);
    for (const forbidden of ['secret evidence', 'private note', 'tok"', 'approval']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('refuses an item without a UUID or a workspace', () => {
    expect(shim.buildSelectionContext({ item: { ...ITEM, id: 'nope' }, workspaceId: WS })).toBeNull();
    expect(shim.buildSelectionContext({ item: ITEM, workspaceId: '' })).toBeNull();
  });

  it('Stop sharing replaces the item with a no-selection payload', () => {
    expect(shim.buildClearedContext({ workspaceId: WS, clearedAt: 'now' })).toEqual({
      content: [{ type: 'text', text: 'OrgX: no item is shared from the panel.' }],
      structuredContent: { schema: 'orgx.selection.v1', workspace_id: WS, entity: null, url: null, shared_at: 'now' },
    });
  });
});

describe('restored chat selection', () => {
  const restored = (workspaceId: string, schema = 'orgx.selection.v1') => ({
    updateId: 'u1',
    structuredContent: { schema, workspace_id: workspaceId, entity: { type: 'decision', id: D1, version: 'v1' } },
  });

  it('is a hint for this workspace only', () => {
    expect(shim.readSharedSelection(restored(WS), WS)).toEqual({
      status: 'match',
      entity: { type: 'decision', id: D1, version: 'v1' },
    });
    expect(shim.readSharedSelection(restored(OTHER_WS), WS)).toEqual({ status: 'mismatch' });
    expect(shim.readSharedSelection(restored(WS, 'someone.else.v1'), WS)).toBeNull();
    expect(shim.readSharedSelection(null, WS)).toBeNull();
  });
});

describe('model context capability', () => {
  const app = (caps: unknown, context: Record<string, unknown> = {}) => ({
    getHostCapabilities: () => caps,
    getHostContext: () => context,
    updateModelContext: vi.fn(async () => ({ _meta: { 'openai/modelContext': { updateId: 'upd-1' } } })),
  });

  it('is undefined when the host does not offer it', () => {
    expect(shim.createExtensions(app({})).modelContext).toBeUndefined();
    expect(shim.createExtensions(app({ experimental: {} })).modelContext).toBeUndefined();
  });

  it('is detected from the raw initialize result even when the SDK stripped experimental keys', () => {
    shim.__onMessageForTests({
      source: window.parent,
      data: { jsonrpc: '2.0', id: 1, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } } } },
    });
    expect(shim.createExtensions(app({ experimental: {} })).modelContext).toBeDefined();
  });

  it('ignores capability messages that do not come from the parent', () => {
    shim.__onMessageForTests({
      source: {},
      data: { jsonrpc: '2.0', id: 1, result: { hostCapabilities: { experimental: { 'openai/modelContext': {} } } } },
    });
    expect(shim.createExtensions(app({})).modelContext).toBeUndefined();
  });

  it('accepts the standard updateModelContext capability and returns the update id', async () => {
    const host = app({ updateModelContext: {} }, { 'openai/modelContext': { updateId: 'u0', structuredContent: {} } });
    const ext = shim.createExtensions(host);
    expect(ext.modelContext?.getCurrent()).toEqual({ updateId: 'u0', structuredContent: {} });
    await expect(ext.modelContext!.update({ content: [], structuredContent: {} })).resolves.toEqual({ updateId: 'upd-1' });
  });

  it('the share controller writes only from share() and stop()', async () => {
    const update = vi.fn(async () => undefined);
    const controller = shim.createShareController({ modelContext: { update }, now: () => 'T' });
    controller.restore({ status: 'match', entity: { id: D1, version: 'v1' } }, WS);
    expect(update).not.toHaveBeenCalled();
    await controller.share(ITEM, WS);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual(shim.buildSelectionContext({ item: ITEM, workspaceId: WS, sharedAt: 'T' }));
    await controller.stop(WS);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]).toEqual(shim.buildClearedContext({ workspaceId: WS, clearedAt: 'T' }));
  });
});

// ---------------------------------------------------------------------------
// The panel itself, served exactly as the worker serves it (shared assets
// inlined), against a fake MCP Apps host.
// ---------------------------------------------------------------------------

function snapshot(overrides: Record<string, unknown> = {}) {
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

async function mountPanel(hostContext: Record<string, unknown>, capabilities: Record<string, unknown>) {
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

describe('the panel updates model context only from the Share click', () => {
  it('does not write on mount, restore, host-context change or refresh, and writes the exact payload on click', async () => {
    const restoredSelection = {
      updateId: 'u-restored',
      structuredContent: { schema: 'orgx.selection.v1', workspace_id: WS, entity: { type: 'decision', id: D1, version: 'v1' } },
    };
    const { dom, app, calls, flush } = await mountPanel(
      { theme: 'light', 'openai/modelContext': restoredSelection },
      { updateModelContext: {} }
    );
    app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1' } } } });
    await flush();
    const doc = dom.window.document;
    expect(doc.querySelector('#pk-q')?.textContent).toBe('Ship release 4.2?');
    // Restored as already shared (a hint), with no write.
    expect(doc.getElementById('panel')!.textContent).toContain('Shared with chat');
    expect(calls.updateModelContext).not.toHaveBeenCalled();

    // A host-context change and a user refresh still write nothing.
    app().context = { ...app().context, theme: 'dark' };
    app().onhostcontextchanged({ theme: 'dark' });
    (doc.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(calls.callServerTool).toHaveBeenCalledWith({ name: 'orgx_panel_snapshot', arguments: {} });
    expect(calls.updateModelContext).not.toHaveBeenCalled();
    expect(calls.sendMessage).not.toHaveBeenCalled();

    // Stop sharing, then share again: one write per click, exact payloads.
    (doc.querySelector('[data-action="stop-share"]') as HTMLButtonElement).click();
    await flush();
    expect(calls.updateModelContext).toHaveBeenCalledTimes(1);
    expect(calls.updateModelContext.mock.calls[0]![0]).toMatchObject({
      structuredContent: { schema: 'orgx.selection.v1', workspace_id: WS, entity: null, url: null },
    });
    (doc.querySelector('[data-action="share"]') as HTMLButtonElement).click();
    await flush();
    expect(calls.updateModelContext).toHaveBeenCalledTimes(2);
    const shared = calls.updateModelContext.mock.calls[1]![0] as unknown as Payload;
    expect(shared.content).toEqual([
      { type: 'text', text: `OrgX item: decision "Ship release 4.2?" — pending, high. https://useorgx.com/decisions/${D1}` },
    ]);
    expect(shared.structuredContent).toMatchObject({
      schema: 'orgx.selection.v1',
      workspace_id: WS,
      entity: { type: 'decision', id: D1, version: 'v1' },
      url: `https://useorgx.com/decisions/${D1}`,
    });
    expect(calls.sendMessage).not.toHaveBeenCalled();
  });

  it('renders no share control when the host lacks the capability, and shows Approve only with a token', async () => {
    const { dom, app, flush } = await mountPanel({ theme: 'light' }, {});
    app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D2]: 'tok-2' } } } });
    await flush();
    const doc = dom.window.document;
    expect(doc.querySelector('[data-action="share"]')).toBeNull();
    expect(doc.getElementById('panel')!.textContent).not.toContain('Share with chat');
    // Focused D1 has no token: the single action is Decide in OrgX.
    expect(doc.querySelector('.packet ox-footer')).toBeNull();
    expect(doc.querySelector('.packet .primary-btn')?.textContent).toContain('Decide in OrgX');
    // D2 has a token: Approve and Send back in place on its row.
    expect(doc.querySelector(`[data-action="approve"][data-id="${D2}"]`)).not.toBeNull();
    expect(doc.querySelector(`[data-action="sendback"][data-id="${D2}"]`)).not.toBeNull();
  });

  it('shows a restored selection from another workspace as unavailable, without fetching it', async () => {
    const { dom, app, calls, flush } = await mountPanel(
      {
        'openai/modelContext': {
          updateId: 'u-x',
          structuredContent: { schema: 'orgx.selection.v1', workspace_id: OTHER_WS, entity: { type: 'decision', id: D2, version: 'v1' } },
        },
      },
      { updateModelContext: {} }
    );
    app().ontoolresult({ structuredContent: snapshot() });
    await flush();
    const doc = dom.window.document;
    expect(doc.getElementById('panel')!.textContent).toContain('This item isn’t available here.');
    expect(doc.querySelector('[data-action="back"]')).not.toBeNull();
    expect(calls.callServerTool).not.toHaveBeenCalled();
    expect(calls.updateModelContext).not.toHaveBeenCalled();
  });

  it('follows an allowlisted deep link with exactly one snapshot call, and ignores others', async () => {
    const good = await mountPanel({ 'openai/deepLink': { url: `https://useorgx.com/decisions/${D2}` } }, {});
    good.app().ontoolresult({ structuredContent: snapshot() });
    await good.flush();
    await good.flush();
    expect(good.calls.callServerTool).toHaveBeenCalledTimes(1);
    expect(good.calls.callServerTool).toHaveBeenCalledWith({
      name: 'orgx_panel_snapshot',
      arguments: { focus: { type: 'decision', id: D2 } },
    });

    const bad = await mountPanel({ 'openai/deepLink': { url: `https://useorgx.com.evil.com/decisions/${D2}` } }, {});
    bad.app().ontoolresult({ structuredContent: snapshot() });
    await bad.flush();
    expect(bad.calls.callServerTool).not.toHaveBeenCalled();
    expect(bad.dom.window.document.querySelector('#pk-q')?.textContent).toBe('Ship release 4.2?');
  });

  it('approves in place with the token, polls command status, then refreshes without writing model context', async () => {
    const { dom, app, calls, flush } = await mountPanel({}, { updateModelContext: {} });
    calls.callServerTool.mockImplementation(async (params: { name: string; arguments: Record<string, unknown> }) => {
      if (params.name === 'orgx_widget_decide') return { structuredContent: { decision_id: D1, action: 'approved' } };
      if (params.name === 'orgx_command_status') {
        return { structuredContent: { kind: 'decision', id: D1, state: 'succeeded', outcome: 'approved', next_poll_after_ms: null } };
      }
      return { structuredContent: snapshot({ generated_at: '2026-10-02T12:09:00.000Z', queue: [], focus: null, attention: { pending: 0, oldest_at: null, blocking: false } }) };
    });
    app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1' } } } });
    await flush();
    const footer = dom.window.document.querySelector('.packet ox-footer')!;
    footer.dispatchEvent(new dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true, detail: {} }));
    for (let i = 0; i < 6; i += 1) await flush();
    expect(calls.callServerTool.mock.calls.map((call) => (call[0] as { name: string }).name).slice(0, 2)).toEqual([
      'orgx_widget_decide',
      'orgx_command_status',
    ]);
    expect(calls.callServerTool.mock.calls[0]![0]).toEqual({
      name: 'orgx_widget_decide',
      arguments: { decision_id: D1, action: 'approve', approval_token: 'tok-1' },
    });
    expect(calls.callServerTool.mock.calls[1]![0]).toEqual({
      name: 'orgx_command_status',
      arguments: { kind: 'decision', id: D1 },
    });
    await new Promise((r) => dom.window.setTimeout(r, 1000));
    await flush();
    expect(calls.callServerTool.mock.calls.at(-1)![0]).toEqual({ name: 'orgx_panel_snapshot', arguments: {} });
    expect(dom.window.document.getElementById('panel')!.textContent).toContain('Approved by you');
    expect(calls.updateModelContext).not.toHaveBeenCalled();
    expect(calls.sendMessage).not.toHaveBeenCalled();
  });

  it('honors next_poll_after_ms, and a status read that fails never undoes a recorded ruling', async () => {
    const { dom, app, calls, flush } = await mountPanel({}, {});
    let statusCalls = 0;
    calls.callServerTool.mockImplementation(async (params: { name: string; arguments: Record<string, unknown> }) => {
      if (params.name === 'orgx_widget_decide') return { structuredContent: { decision_id: params.arguments.decision_id, action: 'rejected' } };
      if (params.name === 'orgx_command_status') {
        statusCalls += 1;
        if (statusCalls === 1) return { structuredContent: { kind: 'decision', id: D2, state: 'running', next_poll_after_ms: 10 } };
        throw new Error('status unavailable');
      }
      return { structuredContent: snapshot({ generated_at: '2026-10-02T12:09:00.000Z' }) };
    });
    app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D2]: 'tok-2' } } } });
    await flush();
    const doc = dom.window.document;
    (doc.querySelector(`[data-action="sendback"][data-id="${D2}"]`) as HTMLButtonElement).click();
    await flush();
    const submit = doc.querySelector(`[data-action="submit-sendback"][data-id="${D2}"]`) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const area = doc.querySelector(`textarea[data-reason="${D2}"]`) as HTMLTextAreaElement;
    area.value = 'Use the staging keys first.';
    area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(false);
    submit.click();
    await flush();
    expect(calls.callServerTool.mock.calls[0]![0]).toEqual({
      name: 'orgx_widget_decide',
      arguments: { decision_id: D2, action: 'reject', approval_token: 'tok-2', reason: 'Use the staging keys first.' },
    });
    await new Promise((r) => dom.window.setTimeout(r, 600));
    await flush();
    expect(statusCalls).toBe(2);
    const row = doc.querySelector(`[data-row="${D2}"]`);
    expect(row?.querySelector('ox-state-chip')?.getAttribute('state')).toBe('rejected');
    expect(doc.querySelector('.error-line')).toBeNull();
    expect(calls.updateModelContext).not.toHaveBeenCalled();
  });
});

describe('panel buttons come from the server', () => {
  const decided = (calls: { callServerTool: ReturnType<typeof vi.fn> }) =>
    calls.callServerTool.mock.calls
      .map((call) => call[0] as { name: string; arguments: Record<string, unknown> })
      .filter((call) => call.name === 'orgx_widget_decide');
  const withFocus = (focus: Record<string, unknown>) => {
    const base = snapshot();
    return snapshot({ focus: { ...(base.focus as Record<string, unknown>), ...focus } });
  };
  const decideResult = async (params: { name: string; arguments: Record<string, unknown> }) => {
    if (params.name === 'orgx_widget_decide') return { structuredContent: { decision_id: params.arguments.decision_id, action: 'approved' } };
    if (params.name === 'orgx_command_status') {
      return { structuredContent: { kind: 'decision', id: params.arguments.id, state: 'succeeded', next_poll_after_ms: null } };
    }
    return { structuredContent: snapshot() };
  };

  it('renders one button per option and sends the option_id with one click', async () => {
    const { dom, app, calls, flush } = await mountPanel({}, {});
    calls.callServerTool.mockImplementation(decideResult);
    const options = [
      { id: 'tonight', label: 'Tonight' },
      { id: 'monday', label: 'Monday' },
    ];
    app().ontoolresult({ structuredContent: withFocus({ options, multiselect: false, widget_actions: null }), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1' } } } });
    await flush();
    const doc = dom.window.document;
    const buttons = doc.querySelectorAll('.packet .opt[data-action="option"]');
    expect(Array.from(buttons, (b) => b.textContent?.replace('›', '').trim())).toEqual(['Tonight', 'Monday']);
    // Empty, not absent: absent would bring back the kit's default primary.
    expect(doc.querySelector('.packet ox-footer')!.getAttribute('primary-label')).toBe('');
    expect(doc.querySelector('.packet [data-action="sendback"]')).not.toBeNull();
    (buttons[1] as HTMLButtonElement).click();
    await flush();
    expect(decided(calls)[0]).toEqual({
      name: 'orgx_widget_decide',
      arguments: { decision_id: D1, action: 'approve', approval_token: 'tok-1', option_id: 'monday' },
    });
  });

  it('turns a multiselect decision into toggles plus Confirm N with option_ids', async () => {
    const { dom, app, calls, flush } = await mountPanel({}, {});
    calls.callServerTool.mockImplementation(decideResult);
    const options = [
      { id: 'eu', label: 'EU' },
      { id: 'us', label: 'US' },
      { id: 'apac', label: 'APAC' },
    ];
    app().ontoolresult({ structuredContent: withFocus({ options, multiselect: true, widget_actions: null }), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1' } } } });
    await flush();
    const doc = dom.window.document;
    const footer = () => doc.querySelector('.packet ox-footer')!;
    expect(footer().hasAttribute('disabled')).toBe(true);
    (doc.querySelector('.opt[data-option="us"]') as HTMLButtonElement).click();
    (doc.querySelector('.opt[data-option="eu"]') as HTMLButtonElement).click();
    expect(doc.querySelector('.opt[data-option="eu"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(footer().getAttribute('primary-label')).toBe('Confirm 2');
    expect(decided(calls)).toEqual([]);
    footer().dispatchEvent(new dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true, detail: {} }));
    await flush();
    expect(decided(calls)[0]!.arguments).toEqual({ decision_id: D1, action: 'approve', approval_token: 'tok-1', option_ids: ['eu', 'us'] });
  });

  it('prefers widget_actions, and shows Approve and Send back for any decision with a token', async () => {
    const { dom, app, calls, flush } = await mountPanel({}, {});
    calls.callServerTool.mockImplementation(decideResult);
    app().ontoolresult({
      structuredContent: withFocus({
        urgency: 'critical',
        options: [{ id: 'x', label: 'Ignored' }, { id: 'y', label: 'Ignored too' }],
        multiselect: false,
        widget_actions: [
          { kind: 'approve', label: 'Accept the plan', option_id: null },
          { kind: 'reject', label: 'Push back', option_id: null },
        ],
      }),
      _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1', [D2]: 'tok-2' } } },
    });
    await flush();
    const doc = dom.window.document;
    expect(doc.querySelectorAll('.packet .opt')).toHaveLength(0);
    const footer = doc.querySelector('.packet ox-footer')!;
    expect(footer.getAttribute('primary-label')).toBe('Accept the plan');
    expect(doc.querySelector('.packet [data-action="sendback"]')!.textContent).toBe('Push back');
    // The other row has a token and no options: Approve and Send back.
    expect(doc.querySelector(`[data-action="approve"][data-id="${D2}"]`)).not.toBeNull();
    expect(doc.querySelector(`[data-action="sendback"][data-id="${D2}"]`)).not.toBeNull();
    footer.dispatchEvent(new dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true, detail: {} }));
    await flush();
    expect(decided(calls)[0]!.arguments).toEqual({ decision_id: D1, action: 'approve', approval_token: 'tok-1' });
  });

  it('says Decide in OrgX only when there is no token', async () => {
    const { dom, app, flush } = await mountPanel({}, {});
    app().ontoolresult({ structuredContent: withFocus({ options: [], multiselect: false, widget_actions: null }), _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
    await flush();
    const doc = dom.window.document;
    expect(doc.querySelector('.packet .primary-btn')!.textContent).toContain('Decide in OrgX');
    expect(doc.querySelector('.packet ox-footer')).toBeNull();
  });
});
