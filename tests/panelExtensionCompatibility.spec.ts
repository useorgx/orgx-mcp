// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { mountPanel, snapshot } from './fixtures/panel';

type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
const receiptId = 'receipt-a';
const privateSummary = 'Private workspace A release evidence';

function click(m: Mounted, selector: string) {
  (m.dom.window.document.querySelector(selector) as HTMLElement).click();
}

function receipt(summary = privateSummary) {
  return {
    receipt_id: 'ledger-document-a', external_receipt_id: receiptId, summary,
    criteria: { met: 1, unmet: 0, unknown: 0 },
    producer_claims: { outcome_status: 'succeeded', verification_status: 'verified', acceptance_status: 'accepted' },
    receipt_assessment: {
      evidence_status: 'recorded', verification_status: 'producer_reported',
      acceptance_status: 'awaiting_human_review', outcome_status: null,
    },
  };
}

async function open() {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_get_work_receipt'
    ? { structuredContent: { ok: true, ...receipt(), criteria: [], evidence: [], uncertain: [] },
        _meta: { 'orgx/widgetApproval': { receipt_approval_tokens: { [receiptId]: 'document-token' } } } }
    : { structuredContent: { ok: true, total: 1, results: [receipt()], window_days: 120 } });
  m.app().ontoolresult({ structuredContent: snapshot() });
  await m.flush();
  click(m, '[data-tab="done"]');
  await m.flush(); await m.flush();
  click(m, '[data-action="work-receipt"][data-id="receipt-a"]');
  await m.flush(); await m.flush();
  return m;
}

afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

describe('ChatGPT extension workspace and receipt operation contract', () => {
  it('drops receipt rows, details and review authority when the workspace changes', async () => {
    const m = await open();
    expect(m.dom.window.document.body.textContent).toContain(privateSummary);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: { ok: true, total: 0, results: [], window_days: 120 } });
    const before = m.calls.callServerTool.mock.calls.length;
    m.app().ontoolresult({ structuredContent: snapshot({ workspace: { id: 'workspace-b', name: 'Workspace B' } }) });
    await m.flush();
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(before + 1);
    expect(m.dom.window.document.body.textContent).not.toContain(privateSummary);
    expect(m.dom.window.document.querySelector('[data-action="receipt-call"]')).toBeNull();
  });

  it('does not apply a receipt write response after switching workspace and sends a single write', async () => {
    const m = await open();
    let finish!: (value: unknown) => void;
    m.calls.callServerTool.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const before = m.calls.callServerTool.mock.calls.length;
    const button = m.dom.window.document.querySelector('[data-action="receipt-call"][data-status="failed"]') as HTMLElement;
    button.click();
    button.click();
    await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(before + 1);
    m.app().ontoolresult({ structuredContent: snapshot({ workspace: { id: 'workspace-b', name: 'Workspace B' } }) });
    await m.flush();
    finish({ structuredContent: { recorded: true, receipt_id: receiptId, status: 'failed' } });
    await m.flush(); await m.flush();
    expect(m.dom.window.document.body.textContent).not.toContain(privateSummary);
    expect(m.dom.window.document.getElementById('panel')?.textContent).not.toContain('Recorded your call.');
    expect(m.dom.window.document.getElementById('pn-live')?.textContent).not.toBe('Recorded your call.');
    expect(m.dom.window.document.querySelector('[data-action="receipt-call"]')).toBeNull();
  });

  it('does not apply a previous receipt revision’s write after the current packet changes in the same workspace', async () => {
    const m = await open();
    let finish!: (value: unknown) => void;
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_receipt_call'
      ? new Promise((resolve) => { finish = resolve; })
      : { structuredContent: { ok: true, total: 1, results: [{ ...receipt('A changed receipt packet'), receipt_review_revision: 'new-revision' }] } });
    click(m, '[data-action="receipt-call"][data-status="failed"]');
    await m.flush();
    click(m, '[data-action="done-range"][data-id="30d"]');
    await m.flush(); await m.flush();
    finish({ structuredContent: { recorded: true, receipt_id: receiptId, status: 'failed' } });
    await m.flush(); await m.flush();
    expect(m.dom.window.document.querySelector('.rc-row .rc-chip')?.textContent).toBe('Agent reports done');
    expect(m.dom.window.document.getElementById('pn-live')?.textContent).not.toBe('Recorded your call.');
    expect(m.dom.window.document.body.textContent).toContain('A changed receipt packet');
    expect(m.dom.window.document.querySelector('[data-action="receipt-call"]')).toBeNull();
  });

  it('shows a confirmed human receipt judgment as a human outcome instead of a producer claim', async () => {
    const m = await open();
    m.calls.callServerTool.mockResolvedValue({ structuredContent: { recorded: true, receipt_id: receiptId, status: 'failed' } });
    click(m, '[data-action="receipt-call"][data-status="failed"]');
    await m.flush(); await m.flush();
    expect(m.dom.window.document.querySelector('.rc-row .rc-chip')?.textContent).toBe('Not done');
    expect(m.dom.window.document.querySelector('.rc-verdict .rc-chip')?.textContent).toBe('Not done');
    expect(m.dom.window.document.querySelector('.rc-cn')?.textContent).toContain('Recorded in the Work Ledger');
  });

  it.each([
    { recorded: true, receipt_id: 'different-receipt', status: 'failed' },
    { recorded: true, receipt_id: receiptId, status: 'succeeded' },
    { recorded: true },
  ])('refuses a success response that does not confirm this receipt and judgment: %j', async (response) => {
    const m = await open();
    m.calls.callServerTool.mockResolvedValue({ structuredContent: response });
    const before = m.calls.callServerTool.mock.calls.length;
    click(m, '[data-action="receipt-call"][data-status="failed"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(before + 1);
    expect(m.dom.window.document.querySelector('.rc-row .rc-chip')?.textContent).toBe('Agent reports done');
    expect(m.dom.window.document.querySelector('.rc-cn')?.textContent).toContain('could not be confirmed');
    expect(m.dom.window.document.getElementById('panel')?.textContent).not.toContain('Recorded your call.');
    expect(m.dom.window.document.getElementById('pn-live')?.textContent).not.toBe('Recorded your call.');
  });

  it('shows a refresh error without using previous panel reads when the host has no current receipt descriptors', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.calls.callServerTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name !== 'orgx_panel_snapshot') throw new Error(`MCP error -32602: Tool ${name} not found`);
      return { structuredContent: args.view === 'receipt'
        ? snapshot({ receipt: { status: 'ok', id: receiptId, row: { id: receiptId, summary: privateSummary, criteria: { met: 0, unmet: 0, unknown: 0 } }, criteria: [], artifacts: [], uncertain: [] } })
        : snapshot({ receipts: { status: 'ok', total: 1, items: [{ id: receiptId, summary: privateSummary, criteria: { met: 0, unmet: 0, unknown: 0 } }] } }) };
    });
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.map(([call]) => call.name)).toEqual(['orgx_list_work_receipts']);
    expect(m.dom.window.document.querySelector('[data-action="receipt-call"]')).toBeNull();
    expect(m.dom.window.document.querySelector('.pn-done .notice')?.textContent).toContain('Refresh the OrgX app');
  });

  it('blocks workspace selection when no compatible write contract was advertised', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ workspaces: { status: 'ok', items: [
      { id: 'workspace-a', name: 'Acme', current: true }, { id: 'workspace-b', name: 'Workspace B', current: false },
    ] } }) });
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-action="workspaces"]');
    await m.flush(); await m.flush();
    const reads = m.calls.callServerTool.mock.calls.length;
    (m.dom.window as unknown as { OrgXPanelHost: { _setHostInfo(info: { name: string }): void } }).OrgXPanelHost._setHostInfo({ name: 'ChatGPT' });
    click(m, '[data-action="switch-workspace"][data-id="workspace-b"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(reads);
    expect(m.dom.window.document.querySelector('.ws-menu')?.textContent).toContain('Refresh the OrgX app in ChatGPT settings');
  });

  it('ignores a workspace-write completion after a newer host workspace replaces it', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    let finish!: (value: unknown) => void;
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_select_workspace'
      ? new Promise((resolve) => { finish = resolve; })
      : { structuredContent: snapshot({ workspaces: { status: 'ok', items: [
          { id: 'workspace-a', name: 'Acme', current: true }, { id: 'workspace-b', name: 'Workspace B', current: false },
        ] } }) });
    m.app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/toolSurface': {
      contract_version: 'orgx-mcp-operations/1', profile: 'chatgpt',
      tools: ['orgx_widget_select_workspace'], widget_tools: { workspace_select: 'orgx_widget_select_workspace' },
    } } });
    await m.flush();
    click(m, '[data-action="workspaces"]');
    await m.flush(); await m.flush();
    click(m, '[data-action="switch-workspace"][data-id="workspace-b"]');
    await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(2);
    m.app().ontoolresult({ structuredContent: snapshot({ workspace: { id: 'workspace-c', name: 'Workspace C' } }) });
    await m.flush();
    finish({ structuredContent: { ok: true } });
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(2);
    expect(m.dom.window.document.querySelector('.ws-btn')?.textContent).toContain('Workspace C');
    expect(m.dom.window.document.getElementById('pn-live')?.textContent).not.toBe('Switched to Workspace B.');
  });
});
