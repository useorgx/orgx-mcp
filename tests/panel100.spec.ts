// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPanelHistory,
  buildPanelSnapshot,
  buildPanelWork,
  historyRangeStart,
} from '../src/panelSurface';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { mountPanel, snapshot } from './fixtures/panel';

const WS = '7af01a51-49b1-47d8-98b9-91a198debca8';
const FLOOR = (pr: number, id: string) => {
  const question = `The OrgX floor stopped a merge action in a agent-cli session and is waiting for you.\n\nAgent's reason: PR #${pr} (https://github.com/hopeatina/orgx/pull/${pr}) adds tiles. All checks pass.\n\nCommand:\ngh pr merge ${pr}\n\nApprove to let exactly this action run once in the next 24 hours. Decline and the agent is told to continue without it.`;
  return {
    id, type: 'decision_queue', agent_id: null, agent_name: 'OrgX System', summary: question, urgency: 'medium',
    created_at: '2026-09-29T17:47:09.949Z', context: { initiative_id: '14985d6c-214c-4f9e-96ac-4f6b254e1770' },
    review_packet: { question, current: { blocked: true }, recommendation: { status: 'unavailable', action: null }, evidence: [],
      uncertainty: ['No LLM recommendation is available for this gate yet.'],
      authority: { kind: 'human', reason: 'This gate blocks work until an authorized person answers.' } },
    widget_actions: { kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Allow once', reject: 'Deny' }, reject_requires_reason: false, answer: null, selection: null },
  };
};
const IDS = ['b965e82d-8043-49bc-a8e8-f4db92c97859', 'b3d8b968-7aea-4643-b198-4f14f29e3d38', 'c727d4e2-ac4e-4fbc-9aa0-e9a0ac9c5eba'];
const APPROVAL = {
  id: 'f31b639b-7810-5281-8018-ee191f656f8e', type: 'approval', agent_id: null, agent_name: 'Agent',
  summary: 'The requested planning-only delegation was denied by the weekly-cap gate on all four attempts.', urgency: 'high',
  created_at: '2026-10-08T07:17:50.977Z',
  context: { run_id: '3bc823bb-eb3d-4c21-a275-8a4be353aa52', initiative_id: '830cc1f1-1536-4247-84da-67656f9e90f3', policy_key: 'specialist_planning_weekly_cap' },
  review_packet: { question: 'The requested planning-only delegation was denied by the weekly-cap gate on all four attempts.', current: { blocked: true },
    uncertainty: ['No LLM recommendation is available for this gate yet.', 'Budget reset date is unknown.'],
    authority: { reason: 'This gate blocks work until an authorized person answers.' } },
};

describe('the production decision shapes', () => {
  const snap = buildPanelSnapshot({
    workspace: { id: WS, name: 'OrgX Business' },
    decisions: [APPROVAL, ...IDS.map((id, i) => FLOOR(3236 + i, id))],
    artifacts: [],
  });

  it('sends a detail even when OrgX repeats the whole question as the title, so repeated rows group', () => {
    const merges = snap.queue.filter((q) => q.asker_kind === 'floor');
    expect(merges).toHaveLength(3);
    for (const item of merges) expect(item.detail).toContain('Command:');
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snap).success).toBe(true);
  });

  it('names who asks honestly: the floor and its session, an unnamed agent, never a placeholder identity', () => {
    const floor = snap.queue.find((q) => q.id === IDS[0])!;
    expect(floor).toMatchObject({ asker: null, asker_kind: 'floor', session_label: 'agent-cli session' });
    const approval = snap.queue.find((q) => q.id === APPROVAL.id)!;
    expect(approval.asker_kind).toBe('unnamed');
  });

  it('carries why the person is asked: policy, authority, real uncertainty, source run and initiative', () => {
    const focus = buildPanelSnapshot({
      workspace: { id: WS, name: 'OrgX Business' }, decisions: [APPROVAL], artifacts: [], focus: { type: 'decision', id: APPROVAL.id },
    }).focus!;
    expect(focus.why).toEqual({
      authority: 'This gate blocks work until an authorized person answers.',
      policy: 'Specialist planning weekly cap',
      // The missing recommendation is said in the recommendation line, not again here.
      uncertainty: ['Budget reset date is unknown.'],
      run_url: 'https://useorgx.com/runs/3bc823bb-eb3d-4c21-a275-8a4be353aa52',
      initiative_url: expect.stringContaining('830cc1f1-1536-4247-84da-67656f9e90f3'),
    });
  });
});

describe('In progress rows', () => {
  const now = Date.now();
  const work = buildPanelWork({
    agents: [
      { agent_id: 'engineering-agent', agent_name: 'Eli', status: 'queued', observability_state: 'stale', tasks: [
        { task_id: '7c1fbb8e-4af6-4046-9c8a-4b05e3467d0e', title: 'Ship the panel', status: 'in_progress', updated_at: new Date(now - 6 * 86400000).toISOString() },
        { task_id: '45de2f58-7e0d-42fe-b79c-68a679fd6052', title: 'Rebuild widgets', status: 'todo' },
      ] },
      { agent_id: 'operations-agent', agent_name: 'Orion', status: 'running', tasks: [
        { task_id: 'not-a-uuid', title: 'Fixture', status: 'blocked', initiative_id: '8a7baebd-2da5-4584-9e32-5b081b830d84' },
      ] },
    ],
  });

  it('links each task to its own page (task_id), names the agent domain, and calls stale work stale', () => {
    const ship = work.items.find((i) => i.title === 'Ship the panel')!;
    expect(ship).toMatchObject({ url: 'https://useorgx.com/tasks/7c1fbb8e-4af6-4046-9c8a-4b05e3467d0e', domain: 'Engineering', state: 'running', stale: true });
    expect(work.items.find((i) => i.title === 'Rebuild widgets')!.stale).toBe(false);
  });

  it('never falls back to the empty mission-control page', () => {
    const fixture = work.items.find((i) => i.title === 'Fixture')!;
    expect(fixture.url).toContain('/live/8a7baebd-2da5-4584-9e32-5b081b830d84');
    expect(work.items.every((i) => !/\/live(\?|$)/.test(i.url))).toBe(true);
  });
});

describe('decision history for Done', () => {
  const now = new Date('2026-10-08T15:00:00Z');
  const records = [
    { id: '11111111-1111-4111-8111-111111111111', title: 'Ship 4.1?\n\nmore', status: 'approved', updated_at: '2026-10-08T12:00:00Z' },
    { id: '22222222-2222-4222-8222-222222222222', title: 'Rotate keys', status: 'declined', updated_at: '2026-10-05T12:00:00Z' },
    { id: '33333333-3333-4333-8333-333333333333', title: 'Old one', status: 'approved', updated_at: '2026-08-01T12:00:00Z' },
    { id: '44444444-4444-4444-8444-444444444444', title: 'Still pending', status: 'pending', updated_at: '2026-10-08T13:00:00Z' },
  ];

  it('keeps settled decisions inside the range, newest first, titled by their first line', () => {
    expect(buildPanelHistory(records, 'today', now).items.map((i) => i.title)).toEqual(['Ship 4.1?']);
    const week = buildPanelHistory(records, '7d', now);
    expect(week.items.map((i) => [i.title, i.outcome])).toEqual([['Ship 4.1?', 'approved'], ['Rotate keys', 'declined']]);
    expect(week.items[0]!.url).toContain('/decisions/11111111-1111-4111-8111-111111111111');
  });

  it('starts today at midnight UTC and says unavailable when the read failed', () => {
    expect(new Date(historyRangeStart('today', now)).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(buildPanelHistory(null, '30d', now)).toEqual({ status: 'unavailable', range: '30d', items: [] });
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

function productionSnapshot() {
  const snap = buildPanelSnapshot({ workspace: { id: WS, name: 'OrgX Business' }, decisions: [APPROVAL, ...IDS.map((id, i) => FLOOR(3236 + i, id))], artifacts: [] });
  return { ...snap, generated_at: '2026-10-08T08:00:00.000Z' } as unknown as Record<string, unknown>;
}

describe('Needs you with production data', () => {
  it('groups the floor merges and leads each line with its command', async () => {
    const m = await openWith(productionSnapshot());
    const group = doc(m).querySelector('.qgroup')!;
    expect(group).not.toBeNull();
    expect(Array.from(group.querySelectorAll('.row-sub.is-cmd')).map((n) => n.textContent)).toEqual(['gh pr merge 3236', 'gh pr merge 3237', 'gh pr merge 3238']);
    expect(group.querySelector('.ax-floor')).not.toBeNull();
  });

  it('says an unnamed agent asks instead of showing an "A"', async () => {
    const m = await openWith(productionSnapshot());
    const meta = doc(m).querySelector('.packet .meta')!;
    expect(meta.textContent).toContain('An agent asks');
    expect(meta.querySelector('.ax-agent')).not.toBeNull();
  });

  it('opens "Why you’re asked" with the packet facts and its links', async () => {
    const m = await openWith(productionSnapshot());
    click(m, '[data-action="why"]');
    await m.flush();
    const body = doc(m).querySelector('.why-b')!;
    expect(body.hasAttribute('hidden')).toBe(false);
    expect(body.textContent).toContain('Specialist planning weekly cap');
    expect(body.textContent).toContain('This gate blocks work until an authorized person answers.');
    expect(body.querySelector('[data-url*="/runs/3bc823bb"]')).not.toBeNull();
  });

  it('reads a PR as one link, never "PR #3236 (PR #3236 ↗)"', async () => {
    const data = productionSnapshot();
    const m = await openWith({ ...data, focus: buildPanelSnapshot({ workspace: { id: WS, name: 'x' }, decisions: [FLOOR(3236, IDS[0]!)], artifacts: [], focus: { type: 'decision', id: IDS[0]! } }).focus, selection: { requested_id: IDS[0], status: 'selected' } });
    const text = doc(m).querySelector('.packet')!.textContent!;
    expect(text).toContain('PR #3236 ↗ adds tiles');
    expect(text).not.toContain('PR #3236 (');
    expect(doc(m).querySelector('.q-cmd code')!.textContent).toBe('gh pr merge 3236');
  });
});

describe('In progress at scale', () => {
  const items = [
    { id: 't1', agent: 'Orion', domain: 'Operations', title: 'Agent routing fixture', state: 'blocked', url: 'https://useorgx.com/tasks/t1' },
    { id: 't2', agent: 'Eli', domain: 'Engineering', title: 'Upgrade the Mac', state: 'running', stale: true, updated_at: '2026-10-02T00:00:00.000Z', url: 'https://useorgx.com/tasks/t2' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, agent: 'Eli', domain: 'Engineering', title: `Queued ${i}`, state: 'queued', url: 'https://useorgx.com/tasks/q' })),
  ];

  async function openWork() {
    const m = await openWith(snapshot());
    m.calls.callServerTool.mockResolvedValueOnce({ structuredContent: snapshot({ generated_at: '2026-10-02T12:05:00.000Z', work: { status: 'ok', total: items.length, items } }) });
    click(m, '[data-tab="work"]');
    await m.flush(); await m.flush();
    return m;
  }

  it('groups by agent with its domain, blocked first, a few rows each and the rest one press away', async () => {
    const m = await openWork();
    const agents = Array.from(doc(m).querySelectorAll('.ag')).map((a) => a.querySelector('.ag-name')!.textContent);
    expect(agents).toEqual(['OrionOperations', 'EliEngineering']);
    expect(doc(m).querySelectorAll('.ag[data-agent="Eli"] .wk-row')).toHaveLength(4);
    click(m, '[data-action="agent-expand"][data-id="Eli"]');
    await m.flush();
    expect(doc(m).querySelectorAll('.ag[data-agent="Eli"] .wk-row')).toHaveLength(7);
  });

  it('filters by state and shows the selected task in the detail pane, stale work called stale', async () => {
    const m = await openWork();
    click(m, '[data-action="work-filter"][data-id="running"]');
    await m.flush();
    expect(Array.from(doc(m).querySelectorAll('.wk-t')).map((n) => n.textContent)).toEqual(['Upgrade the Mac']);
    click(m, '[data-action="work-select"][data-id="t2"]');
    await m.flush();
    const detail = doc(m).querySelector('.pn-md-detail')!;
    expect(detail.querySelector('.md-title')!.textContent).toBe('Upgrade the Mac');
    expect(detail.textContent).toContain('Eli · Engineering');
    expect(detail.textContent).toContain('It may be stalled.');
    expect(detail.querySelector('[data-url="https://useorgx.com/tasks/t2"]')).not.toBeNull();
  });
});

describe('Done over a time range', () => {
  it('reads the history for the range once, lists it and opens a receipt beside it', async () => {
    const m = await openWith(snapshot());
    // Done opens on Work (its receipts read first); Decisions is one press away.
    m.calls.callServerTool
      .mockResolvedValueOnce({ structuredContent: snapshot({ receipts: { status: 'ok', query: 'since:2026-09-26', total: 0, items: [], reason: null } }) })
      .mockResolvedValueOnce({ structuredContent: snapshot({
        generated_at: '2026-10-02T12:06:00.000Z',
        history: { status: 'ok', range: '7d', items: [{ id: 'h1', title: 'Ship 4.1?', outcome: 'approved', settled_at: '2026-10-01T10:00:00.000Z', url: 'https://useorgx.com/decisions/h1' }] },
      }) });
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    click(m, '[data-action="done-lens"][data-id="decisions"]');
    await m.flush();
    click(m, '[data-action="done-range"][data-id="7d"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls[1]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: { view: 'history', range: '7d' } });
    expect(doc(m).querySelector('.pn-done-sum')!.textContent).toContain('1 decision settled in the last 7 days');
    click(m, '[data-action="receipt"][data-id="h1"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-md-detail .md-title')!.textContent).toBe('Ship 4.1?');
    expect(doc(m).querySelector('.pn-md-detail .rt-line')!.textContent).toContain('Approved in OrgX');
    // Back to 7 days again: no second read (the two reads are Work's receipts and this history).
    click(m, '[data-action="done-range"][data-id="session"]');
    await m.flush();
    click(m, '[data-action="done-range"][data-id="7d"]');
    await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(2);
  });
});

describe('workspace switcher overlay', () => {
  it('floats over the panel and offers a filter for long lists', async () => {
    const m = await openWith(snapshot());
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`.slice(-36), name: `Workspace ${i}`, current: i === 0 }));
    m.calls.callServerTool.mockResolvedValueOnce({ structuredContent: snapshot({ generated_at: '2026-10-02T12:07:00.000Z', workspaces: { status: 'ok', items: many } }) });
    click(m, '[data-action="workspaces"]');
    await m.flush(); await m.flush();
    const menu = doc(m).getElementById('pn-ws-menu')!;
    expect(menu.getAttribute('role')).toBe('dialog');
    const input = menu.querySelector('input[data-action="ws-query"]') as HTMLInputElement;
    input.value = 'Workspace 1';
    input.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    await m.flush();
    expect(Array.from(doc(m).querySelectorAll('.ws-item-n')).map((n) => n.textContent)).toEqual(['Workspace 1', 'Workspace 10', 'Workspace 11']);
  });
});

describe('links land where they promise', () => {
  it('sends "all runs" to Runs, never the empty mission-control view, and the ledger to its workspace', async () => {
    const m = await openWith(snapshot());
    const links = (m.dom.window as unknown as { OrgXLinks: Record<string, (...a: unknown[]) => string> }).OrgXLinks;
    expect(links.live!()).toBe('https://useorgx.com/runs');
    expect(links.live!(null, { task: '7c1fbb8e-4af6-4046-9c8a-4b05e3467d0e' })).toBe('https://useorgx.com/tasks/7c1fbb8e-4af6-4046-9c8a-4b05e3467d0e');
    expect(links.workLedger!({ center: WS, range: '7d' })).toBe(`https://useorgx.com/work-ledger?center=${WS}&range=7d`);
  });
});

describe('Start: setting work going from the panel', () => {
  it('is its own tab, and the other views lead to it instead of repeating prompt lists', async () => {
    const m = await openWith(snapshot());
    expect(Array.from(doc(m).querySelectorAll('.pn-tab')).map((t) => t.getAttribute('data-tab'))).toEqual(['needs', 'work', 'done', 'start']);
    click(m, '[data-tab="done"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-done .pn-section, .pn-done .pn-prompt')).toBeNull();
    click(m, '.st-link [data-tab="start"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-start')).not.toBeNull();
  });

  it('shows the exact sentence, hands it to the chosen agent, and sends exactly that', async () => {
    const m = await openWith(snapshot());
    click(m, '[data-tab="start"]');
    await m.flush();
    const send = doc(m).querySelector('[data-action="start-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // Who takes it is one pill in the composer bar; the roster is a menu behind it.
    expect(doc(m).querySelector('.st-menu')).toBeNull();
    click(m, '[data-action="start-who"]');
    await m.flush();
    click(m, '[data-action="start-agent"][data-id="eli"]');
    await m.flush();
    expect(doc(m).querySelector('.st-menu')).toBeNull();
    expect(doc(m).querySelector('.st-who')!.textContent).toContain('Eli');
    expect(doc(m).querySelector('.st-verb[aria-checked="true"] b')!.textContent).toBe('Hand to Eli');
    const ta = doc(m).querySelector('#st-text') as HTMLTextAreaElement;
    ta.value = 'Fix the flaky checkout test';
    ta.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    const expected = 'In OrgX, hand this to Eli (Engineering): Fix the flaky checkout test.';
    expect(doc(m).querySelector('.st-preview')!.textContent).toBe(`Sends “${expected}”`);
    // Typing does not rebuild the composer (the caret stays where it is).
    expect(doc(m).querySelector('#st-text')).toBe(ta);
    click(m, '[data-action="start-send"]');
    await m.flush(); await m.flush();
    expect(m.calls.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: expected }] });
  });

  it('plans first or starts an initiative in plain words', async () => {
    const m = await openWith(snapshot());
    click(m, '[data-tab="start"]');
    await m.flush();
    const ta = doc(m).querySelector('#st-text') as HTMLTextAreaElement;
    ta.value = 'Launch the pricing page by Friday.';
    ta.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    click(m, '[data-action="start-verb"][data-id="plan"]');
    await m.flush();
    expect(doc(m).querySelector('.st-preview')!.textContent).toContain('Plan this in OrgX before anything runs: Launch the pricing page by Friday.');
    click(m, '[data-action="start-verb"][data-id="initiative"]');
    await m.flush();
    expect(doc(m).querySelector('.st-preview')!.textContent).toContain('Start a new initiative in OrgX: Launch the pricing page by Friday.');
  });

  it('fills the composer from a starter instead of sending it', async () => {
    const m = await openWith(snapshot());
    click(m, '[data-tab="start"]');
    await m.flush();
    const starter = doc(m).querySelector('[data-action="start-fill"]') as HTMLElement;
    const text = starter.getAttribute('data-text')!;
    starter.click();
    await m.flush();
    expect((doc(m).querySelector('#st-text') as HTMLTextAreaElement).value).toBe(text);
    expect(m.calls.sendMessage).not.toHaveBeenCalled();
  });

  it('sends on Enter, keeps Shift+Enter for a new line, and closes the who menu on Escape', async () => {
    const m = await openWith(snapshot());
    click(m, '[data-tab="start"]');
    await m.flush();
    const ta = doc(m).querySelector('#st-text') as HTMLTextAreaElement;
    ta.value = 'Write a PRD for team workspaces';
    ta.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    const key = (k: string, shift = false) => ta.dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    key('Enter', true);
    expect(m.calls.sendMessage).not.toHaveBeenCalled();
    click(m, '[data-action="start-who"]');
    await m.flush();
    expect(doc(m).querySelector('.st-menu')).not.toBeNull();
    doc(m).dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await m.flush();
    expect(doc(m).querySelector('.st-menu')).toBeNull();
    expect(doc(m).activeElement!.getAttribute('data-action')).toBe('start-who');
    // Closing the menu re-renders; the text survives and Enter sends it.
    const again = doc(m).querySelector('#st-text') as HTMLTextAreaElement;
    expect(again.value).toBe('Write a PRD for team workspaces');
    again.dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await m.flush(); await m.flush();
    expect(m.calls.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'Start a new initiative in OrgX: Write a PRD for team workspaces.' }] });
  });
});

describe('Needs you: the queue and its empty state', () => {
  it('lists the whole queue with the open decision marked, so the count matches the attention line', async () => {
    const m = await openWith(snapshot());
    const data = snapshot();
    const rows = doc(m).querySelectorAll('.queue .row');
    expect(rows).toHaveLength(data.queue.length);
    expect(doc(m).querySelector('.queue-n')!.textContent).toBe(String(data.attention.pending));
    const current = doc(m).querySelectorAll('.queue .row[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-row')).toBe(data.focus!.id);
  });

  it('says you are clear, what is still moving, and offers the next prompt', async () => {
    const calm = snapshot({ queue: [], focus: null, attention: { pending: 0, oldest_at: null, blocking: false }, proof: { last_accepted: null, completed_unaccepted: 1 } });
    const m = await openWith(calm);
    expect(doc(m).querySelector('.cm-h')!.textContent).toBe('You’re clear.');
    expect(doc(m).querySelector('.cm-sub')!.textContent).toContain('Nothing needs your decision.');
    expect(doc(m).querySelector('.queue')).toBeNull();
    click(m, '[data-action="start-open"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-start')).not.toBeNull();
    expect(doc(m).activeElement!.id).toBe('st-text');
  });
});
