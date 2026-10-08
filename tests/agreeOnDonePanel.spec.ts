// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildPanelReceiptDetail, buildPanelReceipts } from '../src/panelReceipts';
import { buildPanelSnapshot } from '../src/panelSurface';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { mountPanel, snapshot, D1, D2, WS } from './fixtures/panel';

const AGREE = '5b1c9e2a-4f3d-4a8b-9e61-2c7d0a9f4b13';

// The "Agree on done" decision as the app documents it: kind expectation_agreement, set in context.
const SET = {
  id: 'set-1',
  status: 'drafted',
  decision_id: AGREE,
  checks: [
    { scope: 'workstream', statement: 'Plans match the billing catalog', verify: 'artifact', source: 'learned', source_label: 'your call on #3211', owner_agent: 'engineering-agent', new_since_last: true },
    { scope: 'workstream', statement: 'Every PR is reviewed by a person', verify: 'manual', source: 'rule', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'Checkout e2e passes ten runs', verify: 'command', source: 'artifact_type', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'Lighthouse is 90 or higher', verify: 'http', source: 'suggested', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'No regression in billing tests', verify: 'command', source: 'drafted', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'Old pricing URLs redirect', verify: 'http', source: 'drafted', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'Prices render in the visitor’s currency', verify: 'command', source: 'drafted', owner_agent: 'engineering-agent' },
    { scope: 'workstream', statement: 'Ends with one clear call to action', verify: 'manual', source: 'learned', owner_agent: 'marketing-agent' },
    { scope: 'initiative', statement: 'No outbound email without approval', verify: 'manual', source: 'rule' },
  ],
};
const appDecision = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: 'Is this what done means for “Launch the new pricing page”?',
  urgency: 'high',
  created_at: '2026-10-08T15:00:00.000Z',
  ...extra,
});

describe('panel snapshot: an Agree on done decision', () => {
  const s = buildPanelSnapshot({
    workspace: { id: WS, name: 'Acme' },
    decisions: [
      appDecision(AGREE, { decision_kind: 'expectation_agreement', context: { expectations: SET } }),
      appDecision(D2, { summary: 'Rotate keys?', urgency: 'low' }),
    ],
    artifacts: [],
  });

  it('carries the bar on the focus and marks the row, and nothing on other decisions', () => {
    expect(s.focus?.id).toBe(AGREE);
    expect(s.focus?.expectations?.checks).toHaveLength(9);
    expect(s.focus?.expectations?.decision_id).toBe(AGREE);
    expect(s.queue.find((q) => q.id === AGREE)?.agreement).toBe(true);
    expect(s.queue.find((q) => q.id === D2)).not.toHaveProperty('agreement');
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('keeps a plain decision without a bar', () => {
    const plain = buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [appDecision(D2, { expectations: SET })], artifacts: [] });
    expect(plain.focus).not.toHaveProperty('expectations');
  });
});

describe('panel receipts: each check names its source and the agreed bar', () => {
  const detail = buildPanelReceiptDetail({
    receipt: {
      receipt_id: 'rcpt-1',
      intent: {
        summary: 'Fix the flaky checkout test',
        expectations: { agreed_at: '2026-10-08T15:20:00.000Z', agreed_by: 'user-1' },
        criteria: [
          { id: 'c1', text: 'Checkout e2e passes', source: 'artifact_type' },
          { id: 'c2', text: 'Plans match the billing catalog', source: 'learned', learned_from: { label: 'your call on #3211' } },
          { id: 'c3', text: 'Every PR is reviewed by a person', source: 'rule', source_label: 'not shown for rules' },
          { id: 'c4', text: 'An older criterion with no source' },
        ],
      },
      outcome: { criteria_results: [{ criterion_id: 'c1', status: 'met' }] },
    },
    row: { externalId: 'rcpt-1', summary: 'Fix the flaky checkout test' },
  }, 'rcpt-1');

  it('passes the source through, names a learned call, and reads the agreement date', () => {
    expect(detail.criteria.map((c) => [c.id, c.source ?? null, c.source_label ?? null])).toEqual([
      ['c1', 'artifact_type', null],
      ['c2', 'learned', 'your call on #3211'],
      ['c3', 'rule', null],
      ['c4', null, null],
    ]);
    expect(detail.bar).toEqual({ agreed_at: '2026-10-08T15:20:00.000Z', agreed_by: 'user-1' });
    const built = buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [], artifacts: [] });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse({ ...built, receipt: detail }).success).toBe(true);
  });

  it('says nothing about a bar the ledger does not name', () => {
    const none = buildPanelReceiptDetail({ receipt: { receipt_id: 'r', intent: { criteria: [] } } }, 'r');
    expect(none.bar).toBeNull();
  });
});

// ── On the real panel page ───────────────────────────────────────────────

type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

function agreementSnapshot() {
  const s = buildPanelSnapshot({
    workspace: { id: WS, name: 'Acme' },
    decisions: [
      appDecision(AGREE, {
        decision_kind: 'expectation_agreement',
        context: { expectations: SET },
        widget_actions: { kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Approve', reject: 'Reject' }, reject_requires_reason: true },
      }),
      appDecision(D1, { summary: 'Ship release 4.2?', urgency: 'medium' }),
    ],
    artifacts: [],
  });
  return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
}

async function open(tokens: Record<string, string> = { [AGREE]: 'single-use-token', [D1]: 'other-token' }) {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: agreementSnapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: tokens } } });
  await m.flush();
  return m;
}

describe('Needs you: agreeing on what done means', () => {
  it('drafted: shows the bar grouped new-first then per owner, five per owner and the rest folded', async () => {
    const m = await open();
    const groups = Array.from(doc(m).querySelectorAll('.packet .xp-g')).map((g) => g.querySelector('.xp-gn')!.textContent);
    expect(groups).toEqual(['New since last time', 'Eli', 'Mark', 'Across the initiative']);
    const eli = doc(m).querySelector('.packet .xp-g[data-group="owner:engineering-agent"]')!;
    expect(eli.querySelectorAll(':scope > .xp-cs > .xp-c')).toHaveLength(5);
    expect(eli.querySelector('.xp-more summary')!.textContent).toBe('1 more');
    const chips = Array.from(doc(m).querySelectorAll('.packet .xp-src')).map((c) => c.textContent);
    expect(chips).toContain('learned · your call on #3211');
    expect(chips).toEqual(expect.arrayContaining(['your rule', 'kind of work', 'suggested', 'drafted']));
    expect(doc(m).querySelector('.packet .xp-sum')!.textContent).toContain('9 checks across 2 owners');
    // An agreement is read, not approved from the row; generic chat chips stay off it.
    expect(doc(m).querySelector(`.row[data-row="${AGREE}"] [data-action="approve"]`)).toBeNull();
    expect(doc(m).querySelector('.packet .pn-asks')).toBeNull();
    const footer = doc(m).querySelector(`ox-footer[data-id="${AGREE}"]`)!;
    expect(footer.getAttribute('primary-label')).toBe('Agree · start work');
    expect(footer.getAttribute('heading')).toBe('Agree on done');
    expect(footer.querySelector('[data-action="sendback"]')!.textContent).toBe('Send back');
  });

  it('agreed: settles through orgx_widget_decide with the single-use token', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'approved' } }
      : { structuredContent: { kind: 'decision', id: AGREE, state: 'succeeded', outcome: 'approved', status: 'approved', next_poll_after_ms: null } });
    doc(m).querySelector(`ox-footer[data-id="${AGREE}"]`)!.dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true }));
    await m.flush(); await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'orgx_widget_decide',
      arguments: expect.objectContaining({ decision_id: AGREE, action: 'approve', approval_token: 'single-use-token', kind: 'decision' }),
    }));
    const done = doc(m).querySelector(`ox-footer[data-id="${AGREE}"]`)!;
    expect(done.getAttribute('heading')).toBe('Agreed by you');
    expect(done.getAttribute('detail')).toBe('agents start; every receipt is judged against this bar');
  });

  it('sent back: takes a note and records the send back', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'rejected' } }
      : { structuredContent: { kind: 'decision', id: AGREE, state: 'succeeded', outcome: 'rejected', status: 'rejected', next_poll_after_ms: null } });
    click(m, `ox-footer[data-id="${AGREE}"] [data-action="sendback"]`);
    await m.flush();
    const note = doc(m).querySelector(`textarea[data-reason="${AGREE}"]`) as HTMLTextAreaElement;
    note.value = 'Drop the Lighthouse check; this page is static.';
    note.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    await m.flush();
    click(m, `[data-action="submit-sendback"][data-id="${AGREE}"]`);
    await m.flush(); await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'orgx_widget_decide',
      arguments: expect.objectContaining({ decision_id: AGREE, action: 'reject', reason: 'Drop the Lighthouse check; this page is static.' }),
    }));
    const done = doc(m).querySelector(`ox-footer[data-id="${AGREE}"]`)!;
    expect(done.getAttribute('heading')).toBe('Sent back by you');
    expect(done.getAttribute('detail')).toBe('OrgX redrafts it and asks again');
  });

  it('Edit in chat posts the sentence as the person’s own message', async () => {
    const m = await open();
    click(m, `[data-action="exp-edit"][data-id="${AGREE}"]`);
    await m.flush(); await m.flush();
    const sent = m.calls.sendMessage.mock.calls[0]![0].content[0].text as string;
    expect(sent).toContain('change what done means');
    expect(sent).toContain('9 checks');
  });

  it('waiting: without a token the person is sent to OrgX, never approved from here', async () => {
    const m = await open({});
    expect(doc(m).querySelector(`ox-footer[data-id="${AGREE}"]`)).toBeNull();
    expect(doc(m).querySelector('.packet [data-action="exp-edit"]')).not.toBeNull();
    expect(doc(m).querySelector('.packet .primary-btn')!.textContent).toContain('Decide in OrgX');
  });
});

describe('Done: a receipt with sources', () => {
  it('shows each source chip, the learned call, and the bar it was judged against', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
    await m.flush();
    const row = { externalId: 'rcpt-1', summary: 'Fix the flaky checkout test', outcome: 'succeeded', criteria: { met: 1, unmet: 0, unknown: 1 } };
    const detail = buildPanelReceiptDetail({
      row,
      receipt: {
        receipt_id: 'rcpt-1',
        intent: {
          expectations: { agreed_at: '2026-10-08T15:20:00.000Z' },
          criteria: [
            { id: 'c1', text: 'Plans match the billing catalog', source: 'learned', learned_from: { label: 'your call on #3211' } },
            { id: 'c2', text: 'Every PR is reviewed by a person', source: 'rule' },
          ],
        },
        outcome: { criteria_results: [{ criterion_id: 'c1', status: 'met' }] },
      },
    }, 'rcpt-1');
    m.calls.callServerTool.mockImplementation(async ({ arguments: args }: { arguments: Record<string, unknown> }) =>
      args.view === 'receipt'
        ? { structuredContent: snapshot({ receipt: detail }) }
        : { structuredContent: snapshot({ receipts: buildPanelReceipts({ data: { total: 1, results: [row] } }, 'since:x') }) });
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    click(m, '[data-action="work-receipt"][data-id="rcpt-1"]');
    await m.flush(); await m.flush();
    const chips = Array.from(doc(m).querySelectorAll('.rc-c .xp-src')).map((c) => c.textContent);
    expect(chips).toEqual(['learned · from your call on #3211', 'your rule']);
    expect(doc(m).querySelector('.rc-bar')!.textContent).toMatch(/^Judged against the bar you agreed on \w+ \d+\.$/);
  });
});

describe('Start: the teaser', () => {
  it('says OrgX asks you to agree on done before work starts', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
    await m.flush();
    click(m, '[data-tab="start"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-start .st-done')!.textContent).toBe('Before work starts, OrgX asks you to agree on what done means.');
  });
});
