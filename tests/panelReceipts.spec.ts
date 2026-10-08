// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPanelReceiptDetail,
  buildPanelReceipts,
  ledgerFailure,
  receiptRangeQuery,
} from '../src/panelReceipts';
import { handlePanelSnapshot, handleReceiptCall, type PanelSurfaceHost } from '../src/panelSurface';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { mountPanel, snapshot } from './fixtures/panel';

const WS = '11111111-1111-4111-8111-111111111111';

// The ledger's own row shape (rowOf in the app) and full receipt (GET /receipts/{id}).
const ROW = {
  id: 'row-1', externalId: 'rcpt-abc', at: '2026-10-07T10:00:00.000Z', actor: 'Eli', repo: 'useorgx/orgx',
  summary: 'Fix the flaky checkout test and open a PR', outcome: 'succeeded', verification: 'verified', accepted: null,
  workType: 'bugfix', workTypeConfidence: 0.8, area: 'checkout', workstream: 'ws-1', entity: { type: 'initiative', id: 'i-1', title: 'Release' },
  criteria: { met: 2, unmet: 1, unknown: 1 }, prs: ['useorgx/orgx#3236'], costUsd: 0.4, confidence: 0.7,
};
const FULL = {
  row: ROW,
  receipt: {
    receipt_id: 'rcpt-abc',
    intent: {
      summary: ROW.summary,
      objective: 'Stop checkout from failing in CI',
      criteria: [
        { id: 'c1', text: 'The checkout suite passes ten runs in a row', kind: 'test' },
        { id: 'c2', text: 'The fix has a regression test', kind: 'test' },
        { id: 'c3', text: 'No new console errors on checkout' },
        { id: 'c4', text: 'A person reviewed the PR' },
      ],
    },
    actor: { type: 'agent', id: 'eli', display_name: 'Eli' },
    artifacts: [
      { id: 'a1', kind: 'pull_request', name: 'useorgx/orgx#3236', role: 'output', ref: { system: 'github', type: 'pr', id: 'useorgx/orgx#3236' } },
      { id: 'a2', kind: 'file', name: 'checkout.spec.ts', role: 'output', ref: { system: 'git', type: 'file', id: 'tests/checkout.spec.ts' } },
    ],
    outcome: {
      status: 'succeeded',
      summary: 'Opened the PR; the suite passed ten runs.',
      criteria_results: [
        { criterion_id: 'c1', status: 'met', evidence_ids: ['e1'], confidence: 0.95 },
        { criterion_id: 'c2', status: 'met', evidence_ids: ['e2'], confidence: 0.5 },
        { criterion_id: 'c3', status: 'unmet', evidence_ids: ['e3'], confidence: 0.9 },
      ],
    },
    verification: { status: 'verified' },
    cost: { total: 0.4 },
    lineage: { parent_receipt_refs: [], references: [] },
    timestamps: { started_at: '2026-10-07T10:00:00.000Z', completed_at: '2026-10-07T10:30:00.000Z' },
  },
  workstream: { id: 'ws-1', title: 'Checkout reliability' },
  uncertain: ['no evidence either way for: A person reviewed the PR'],
};

describe('Work Ledger receipts, shaped for the panel', () => {
  it('reads a range as a since: filter on its first day', () => {
    const now = new Date('2026-10-08T15:00:00.000Z');
    expect(receiptRangeQuery('today', now)).toBe('since:2026-10-08');
    expect(receiptRangeQuery('7d', now)).toBe('since:2026-10-02');
    expect(receiptRangeQuery('30d', now)).toBe('since:2026-09-09');
  });

  it('keeps the ledger counts and never invents a verdict', () => {
    const list = buildPanelReceipts({ data: { total: 3, results: [ROW, { id: 'no-summary' }] } }, 'since:2026-10-02');
    expect(list.status).toBe('ok');
    expect(list.total).toBe(3);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: 'rcpt-abc', criteria: { met: 2, unmet: 1, unknown: 1 }, prs: ['useorgx/orgx#3236'], entity_title: 'Release' });
    expect(buildPanelReceipts(null, 'pr:1', 'The Work Ledger answered 500.')).toMatchObject({ status: 'unavailable', reason: 'The Work Ledger answered 500.' });
  });

  it('pairs each declared criterion with its result, and an unrecorded one stays unknown', () => {
    const d = buildPanelReceiptDetail(FULL, 'rcpt-abc');
    expect(d.status).toBe('ok');
    expect(d.criteria.map((c) => [c.id, c.status, c.confidence])).toEqual([['c1', 'met', 0.95], ['c2', 'met', 0.5], ['c3', 'unmet', 0.9], ['c4', 'unknown', null]]);
    expect(d.artifacts[0]).toEqual({ kind: 'pull_request', name: 'useorgx/orgx#3236', url: 'https://github.com/useorgx/orgx/pull/3236' });
    expect(d.artifacts[1]!.url).toBeNull();
    expect(d.uncertain).toEqual(['no evidence either way for: A person reviewed the PR']);
    expect(d.workstream_title).toBe('Checkout reliability');
  });

  it('says why a ledger read failed, in plain words', () => {
    expect(ledgerFailure(Object.assign(new Error('x'), { status: 403 }))).toMatch(/signed in/);
    expect(ledgerFailure(new Error('request timed out'))).toMatch(/too long/);
    expect(ledgerFailure(new Error('OrgX API 502 Bad Gateway'))).toBe('The Work Ledger answered 502.');
  });
});

function host(overrides: Partial<PanelSurfaceHost> = {}): PanelSurfaceHost {
  return {
    authRequired: vi.fn(() => null),
    viewerUserIds: vi.fn(() => ['u1']),
    sessionWorkspace: vi.fn(() => ({ id: WS, name: 'Acme' })),
    inferWorkspace: vi.fn(async () => null),
    fetchPendingDecisions: vi.fn(async () => ({ ok: true, data: { decisions: [] } })),
    fetchArtifacts: vi.fn(async () => []),
    run: vi.fn((runner) => runner()),
    now: () => new Date('2026-10-08T15:00:00.000Z'),
    ...overrides,
  };
}

describe('orgx_panel_snapshot: receipts, one receipt, and history that says why it failed', () => {
  it('reads receipts for a range, or for a query like pr:3236, and matches the output schema', async () => {
    const fetchLedgerReceipts = vi.fn(async () => ({ data: { total: 1, results: [ROW] } }));
    const r1 = await handlePanelSnapshot(host({ fetchLedgerReceipts }), { view: 'receipts', range: '7d' });
    expect(fetchLedgerReceipts).toHaveBeenLastCalledWith({ workspaceId: WS, query: 'since:2026-10-02', limit: 50 });
    expect((r1.structuredContent as { receipts: { items: unknown[] } }).receipts.items).toHaveLength(1);
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(r1.structuredContent).success).toBe(true);
    await handlePanelSnapshot(host({ fetchLedgerReceipts }), { view: 'receipts', query: 'pr:3236' });
    expect(fetchLedgerReceipts).toHaveBeenLastCalledWith({ workspaceId: WS, query: 'pr:3236', limit: 50 });
  });

  it('reads one receipt in full, and a failed read becomes a reason, not a crash', async () => {
    const ok = await handlePanelSnapshot(host({ fetchLedgerReceipt: vi.fn(async () => FULL) }), { view: 'receipt', receipt_id: 'rcpt-abc' });
    expect((ok.structuredContent as { receipt: { criteria: unknown[] } }).receipt.criteria).toHaveLength(4);
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(ok.structuredContent).success).toBe(true);
    const failed = await handlePanelSnapshot(host({ fetchLedgerReceipt: vi.fn(async () => { throw Object.assign(new Error('no'), { status: 404 }); }) }), { view: 'receipt', receipt_id: 'gone' });
    expect((failed.structuredContent as { receipt: { status: string; reason: string } }).receipt).toMatchObject({ status: 'unavailable', reason: 'The Work Ledger has nothing for this yet.' });
  });

  it('carries why decision history failed', async () => {
    const r = await handlePanelSnapshot(host({ fetchDecisionHistory: vi.fn(async () => { throw Object.assign(new Error('bad'), { status: 400 }); }) }), { view: 'history', range: 'today' });
    expect((r.structuredContent as { history: { status: string; reason: string } }).history).toMatchObject({ status: 'unavailable', reason: 'OrgX answered 400 when reading settled decisions.' });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(r.structuredContent).success).toBe(true);
  });
});

describe('orgx_widget_receipt_call: a person\'s call on a receipt', () => {
  it('records the call in the session workspace and says what it recorded', async () => {
    const recordReceiptCall = vi.fn(async () => undefined);
    const r = await handleReceiptCall(host({ recordReceiptCall }), { receipt_id: 'rcpt-abc', status: 'failed' });
    expect(recordReceiptCall).toHaveBeenCalledWith({ workspaceId: WS, receiptId: 'rcpt-abc', status: 'failed' });
    expect(r.structuredContent).toEqual({ recorded: true, receipt_id: 'rcpt-abc', status: 'failed', reason: null });
  });

  it('refuses a call it cannot record, and says why', async () => {
    const bad = await handleReceiptCall(host({ recordReceiptCall: vi.fn() }), { receipt_id: 'rcpt-abc', status: 'great' });
    expect(bad.isError).toBe(true);
    const refused = await handleReceiptCall(host({ recordReceiptCall: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 404 }); }) }), { receipt_id: 'nope', status: 'succeeded' });
    expect(refused.structuredContent).toMatchObject({ recorded: false, reason: 'The Work Ledger has no receipt with that id.' });
  });
});

// ── On the real panel page ───────────────────────────────────────────────

type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

async function openWith(data: Record<string, unknown>) {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
  await m.flush();
  return m;
}

const LIST = buildPanelReceipts({ data: { total: 1, results: [ROW] } }, 'since:2026-10-02');
const DETAIL = buildPanelReceiptDetail(FULL, 'rcpt-abc');

describe('Done › Work: the work, what done meant, and your call', () => {
  it('opens on the work, shows each check, takes it into the chat, and records your call', async () => {
    const m = await openWith(snapshot());
    m.calls.callServerTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'orgx_widget_receipt_call') return { structuredContent: { recorded: true, receipt_id: args.receipt_id, status: args.status, reason: null } };
      if (args.view === 'receipt') return { structuredContent: snapshot({ receipt: DETAIL }) };
      return { structuredContent: snapshot({ receipts: LIST }) };
    });
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls[0]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: { view: 'receipts', range: '7d' } });
    // Nothing selected: quality across the range.
    expect(doc(m).querySelector('.q-card .md-title')!.textContent).toBe('1 piece of work, 4 checks');
    expect(doc(m).querySelector('.rc-row .rc-pips')!.getAttribute('aria-label')).toBe('2 of 4 checks met, 1 not met, 1 with no evidence');

    click(m, '[data-action="work-receipt"][data-id="rcpt-abc"]');
    await m.flush(); await m.flush();
    const crits = Array.from(doc(m).querySelectorAll('.rc-c')).map((c) => `${c.getAttribute('data-s')}: ${c.querySelector('.rc-cs')!.textContent}`);
    expect(crits).toEqual(['met: Met', 'met: Met · a guess', 'unmet: Not met', 'unknown: No evidence']);
    expect(doc(m).querySelector('.rc-unsure')!.textContent).toContain('A person reviewed the PR');

    click(m, '[data-action="receipt-iterate"]');
    await m.flush(); await m.flush();
    const sent = m.calls.sendMessage.mock.calls[0]![0].content[0].text as string;
    expect(sent).toContain('OrgX Work Ledger receipt rcpt-abc');
    expect(sent).toContain('Fix the flaky checkout test');

    click(m, '[data-action="receipt-call"][data-status="partially_succeeded"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'orgx_widget_receipt_call', arguments: { receipt_id: 'rcpt-abc', status: 'partially_succeeded' } }));
    expect(doc(m).querySelector('.rc-cn')!.textContent).toContain('Recorded in the Work Ledger');
    expect(doc(m).querySelector('.rc-row .rc-chip')!.textContent).toBe('Partly done');
  });

  it('says why receipts could not be read and offers to try again', async () => {
    const m = await openWith(snapshot());
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ receipts: buildPanelReceipts(null, 'since:x', 'The Work Ledger needs you signed in to this workspace.') }) });
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-done .notice')!.textContent).toContain('needs you signed in');
    expect(doc(m).querySelector('.pn-done .notice [data-action="done-range"]')).not.toBeNull();
  });
});

describe('Needs you: the work behind a decision', () => {
  it('reads the receipt for the PR a decision is about and shows it before the decision', async () => {
    const base = snapshot();
    const data = snapshot({ focus: { ...(base.focus as Record<string, unknown>), question: 'The OrgX floor stopped a merge.\n\nCommand:\ngh pr merge 3236' } });
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ receipts: LIST }) });
    m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
    await m.flush(); await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'orgx_panel_snapshot', arguments: expect.objectContaining({ view: 'receipts', query: 'pr:3236' }) }));
    const behind = doc(m).querySelector('.packet .rc-behind')!;
    expect(behind.textContent).toContain('Fix the flaky checkout test');
    // Read before deciding: it sits above the decide bar.
    expect(behind.compareDocumentPosition(doc(m).querySelector('.packet .actions')!) & 4).toBeTruthy();
  });
});

describe('when ChatGPT has an older copy of the OrgX tools', () => {
  it('says to refresh the app instead of echoing the validator', async () => {
    const m = await openWith(snapshot());
    m.calls.callServerTool.mockRejectedValue(new Error("Parameters failed connector schema validation: view [enum]: Value 'receipts' not in allowed enum"));
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-done .notice')!.textContent).toContain('Refresh the OrgX app in ChatGPT settings');
  });
});
