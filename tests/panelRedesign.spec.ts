// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot, D1, D2 } from './fixtures/panel';
import { outputFrontDoor } from './fixtures/outputFrontDoor';

/**
 * The redesign's new pieces, end to end in the widget: bulk approve with its
 * undo window, number questions, ready answers, a person's own answer,
 * Outputs, Goals and steering a running task. Nothing is approved, sent back
 * or said in the chat without a press, and none of it writes model context.
 */
type Call = { name: string; arguments: Record<string, unknown> };
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

const OUT = 'a1111111-1111-4111-8111-111111111111';
const OUT2 = 'a2222222-2222-4222-8222-222222222222';
const GOAL = '77777777-7777-4777-8777-777777777777';
const INIT = '22222222-2222-4222-8222-222222222222';
const TASK = '66666666-6666-4666-8666-666666666666';
const PREVIEW = 'Hand-written preview of the launch post';

const contract = (extra: Record<string, unknown> = {}) => ({
  kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Approve', reject: 'Send back' },
  reject_requires_reason: true, answer: null, selection: null, questions: null, items: null, ...extra,
});
const decided = (m: Mounted) =>
  m.calls.callServerTool.mock.calls.map((c: unknown[]) => c[0] as Call).filter((c: Call) => c.name === 'orgx_widget_decide');
const reads = (m: Mounted) =>
  m.calls.callServerTool.mock.calls.map((c: unknown[]) => c[0] as Call).filter((c: Call) => c.name === 'orgx_panel_snapshot');

function outputsView() {
  const out = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, type: 'blog_post', family: 'writing', status: 'in_review', has_preview: false, external_url: null,
    initiative_id: INIT, task_id: null, made_at: new Date(Date.now() - 3600_000).toISOString(), made_by: 'Mark',
    accepted: { state: 'waiting', at: null, by: null }, landed: null, moved: null, checks: [], checks_source: null,
    eval_score: null, decision_id: null, url: `https://useorgx.com/artifacts/${id}`, ...extra,
  });
  return {
    status: 'ok', total: 2,
    items: [
      out(OUT, 'Launch post', { has_preview: true, decision_id: D1, checks: [{ label: 'Cites sources', met: true }, { label: 'Has a CTA', met: false }], checks_source: 'Launch post' }),
      out(OUT2, 'Pricing FAQ', { accepted: { state: 'accepted', at: new Date(Date.now() - 1800_000).toISOString(), by: 'you' }, status: 'approved' }),
    ],
  };
}

function goalsView(items: unknown[] = []) {
  return { status: 'ok', items, total: items.length, unlinked: [], unlinked_total: 0, quality_bars: [] };
}

async function open(focus: Record<string, unknown> | null = null, views: Record<string, { data: unknown; meta?: Record<string, unknown> }> = {}) {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.calls.callServerTool.mockImplementation(async (params: Call) => {
    if (params.name === 'orgx_widget_decide') return { structuredContent: { decision_id: params.arguments.decision_id, action: params.arguments.action === 'reject' ? 'rejected' : 'approved' } };
    if (params.name === 'orgx_get_operation_status') return { structuredContent: { kind: 'decision', id: params.arguments.id, state: 'succeeded', next_poll_after_ms: null } };
    const view = params.name === 'orgx_panel_snapshot' ? String(params.arguments?.view || '') : '';
    if (view && views[view]) return { structuredContent: snapshot({ [view]: views[view]!.data }), _meta: views[view]!.meta || {} };
    return new Promise(() => undefined);
  });
  const base = snapshot();
  const data = focus ? snapshot({ focus: { ...(base.focus as Record<string, unknown>), options: [], multiselect: false, widget_actions: null, ...focus } }) : base;
  m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1', [D2]: 'tok-2' } } } });
  await m.flush();
  const doc = m.dom.window.document;
  const click = (selector: string) => {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`nothing matches ${selector}`);
    el.click();
  };
  const type = (selector: string, value: string) => {
    const el = doc.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
    el.value = value;
    el.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
  };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await m.flush(); };
  const wait = (ms: number) => new Promise((r) => m.dom.window.setTimeout(r, ms));
  const press = () => (doc.querySelector('.packet ox-footer') as HTMLElement).dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true, detail: {} }));
  return { ...m, doc, click, type, settle, wait, press };
}

describe('bulk approve', () => {
  it('is an explicit choice with an undo window: nothing reaches OrgX until the bar runs out', async () => {
    const p = await open();
    // Rows are plain until the person asks to select.
    expect(p.doc.querySelector('[data-action="bulk-check"]')).toBeNull();
    p.click('[data-action="bulk-mode"]');
    expect(p.doc.querySelectorAll('[data-action="bulk-check"]').length).toBe(2);
    // Selecting is not approving.
    expect(p.doc.querySelector('[data-action="bulk-approve"]')).toBeNull();
    p.click(`[data-action="bulk-check"][data-id="${D1}"]`);
    p.click(`[data-action="bulk-check"][data-id="${D2}"]`);
    p.click('[data-action="bulk-approve"]');
    await p.settle();
    const toast = p.doc.querySelector('#pn-toast-host')!;
    expect(toast.textContent).toContain('Approving 2 decisions. Nothing is sent until the bar runs out.');
    expect(decided(p)).toEqual([]);
    await p.wait(2500);
    expect(decided(p)).toEqual([]);
    await p.wait(3000);
    await p.settle();
    expect(decided(p).map((c) => [c.arguments.decision_id, c.arguments.action, c.arguments.approval_token])).toEqual([
      [D1, 'approve', 'tok-1'],
      [D2, 'approve', 'tok-2'],
    ]);
    expect(p.calls.updateModelContext).not.toHaveBeenCalled();
  }, 15000);

  it('sends nothing when Undo is pressed, from the toast or with Escape', async () => {
    const p = await open();
    p.click('[data-action="bulk-mode"]');
    p.click('[data-action="bulk-mode"]'); // the second press selects every eligible one
    p.click('[data-action="bulk-approve"]');
    await p.settle();
    (p.doc.querySelector('#pn-toast-host [data-action="bulk-undo"]') as HTMLElement).click();
    await p.settle();
    expect(p.doc.querySelector('#pn-toast-host')!.textContent).toBe('');
    // The decisions are back in the queue, each still one tap from its own ruling.
    expect(p.doc.querySelectorAll('.row').length).toBeGreaterThanOrEqual(2);
    p.click('[data-action="bulk-mode"]');
    p.click('[data-action="bulk-mode"]');
    p.click('[data-action="bulk-approve"]');
    await p.settle();
    p.doc.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p.wait(5600);
    await p.settle();
    expect(decided(p)).toEqual([]);
  }, 15000);

  it('sends back only with one note for all, still behind the undo window', async () => {
    const p = await open();
    p.click('[data-action="bulk-mode"]');
    p.click('[data-action="bulk-mode"]');
    p.click('[data-action="bulk-sendback"]');
    p.click('[data-action="bulk-reject"]');
    await p.settle();
    // An empty note starts nothing.
    expect(p.doc.querySelector('#pn-toast-host')?.textContent ?? '').toBe('');
    p.type('#bulk-note', 'Hold until QA signs off');
    p.click('[data-action="bulk-reject"]');
    await p.wait(5600);
    await p.settle();
    const calls = decided(p);
    expect(calls.map((c) => [c.arguments.decision_id, c.arguments.action])).toEqual([[D1, 'reject'], [D2, 'reject']]);
    expect(JSON.stringify(calls[0]!.arguments)).toContain('Hold until QA signs off');
  }, 15000);
});

describe('a number question', () => {
  const questions = {
    fields: [{
      id: 'budget', step_title: null, type: 'number', label: 'Monthly budget', description: null, placeholder: null, required: true,
      min_select: null, max_select: null, max_length: 2000, options: [], number: { min: 0, max: 5000, step: 50, unit: '$', recommended: 1200 },
    }],
  };

  it('starts on the recommended amount, steps on its grid and sends the number only when pressed', async () => {
    const p = await open({ widget_actions: contract({ labels: { approve: 'Send answer', reject: 'Send back' }, questions }) });
    const range = p.doc.querySelector('input[data-qnum="budget"]') as HTMLInputElement;
    expect(range.value).toBe('1200');
    expect(p.doc.querySelector('[data-amt-out]')!.textContent).toBe('$1,200');
    p.click('[data-action="q-step"][data-delta="1"]');
    p.click('[data-action="q-step"][data-delta="1"]');
    expect((p.doc.querySelector('input[data-qnum="budget"]') as HTMLInputElement).value).toBe('1300');
    p.type('input[data-qnum="budget"]', '4950');
    p.click('[data-action="q-step"][data-delta="1"]');
    p.click('[data-action="q-step"][data-delta="1"]');
    // Kept inside the range.
    expect((p.doc.querySelector('input[data-qnum="budget"]') as HTMLInputElement).value).toBe('5000');
    expect(decided(p)).toEqual([]);
    for (let i = 0; i < 4 && !decided(p).length; i += 1) { p.press(); await p.settle(); }
    expect(decided(p)[0]!.arguments).toMatchObject({ decision_id: D1, action: 'approve', approval_token: 'tok-1', answers: { budget: '5000' } });
  });
});

describe('ready answers and a person’s own answer', () => {
  it('fills the answer box from a suggestion without sending it', async () => {
    const p = await open({ widget_actions: contract({ labels: { approve: 'Send answer', reject: 'Send back' }, answer: { required_for: ['approve'], max_length: 2000, save_as_precedent: false, suggestions: ['Ship Friday', 'Hold for QA'] } }) });
    p.click('[data-action="answer-suggest"][data-value="Hold for QA"]');
    await p.settle();
    expect((p.doc.querySelector(`textarea[data-field="answer"][data-id="${D1}"]`) as HTMLTextAreaElement).value).toBe('Hold for QA');
    expect(p.doc.querySelector('[data-action="answer-suggest"][data-value="Hold for QA"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(decided(p)).toEqual([]);
  });

  it('opens Write my own as a send back that needs the words', async () => {
    const option = (id: string, label: string) => ({ id, label, description: null, implied_action: null, requires_reason: false, recommended: false });
    const p = await open({ widget_actions: contract({ reject_requires_reason: false, selection: { mode: 'single', min: 1, max: 1, required_for: ['approve'], options: [option('eu', 'EU'), option('us', 'US')] } }) });
    p.click('[data-action="own-open"]');
    await p.settle();
    expect(p.doc.querySelector(`label[for="reason-${D1}"]`)!.textContent).toBe('Your own answer · required');
    p.click(`[data-action="submit-sendback"][data-id="${D1}"]`);
    await p.settle();
    expect(decided(p)).toEqual([]);
    p.type(`textarea[data-reason="${D1}"]`, 'Split it: EU first, US next quarter');
    p.click(`[data-action="submit-sendback"][data-id="${D1}"]`);
    await p.settle();
    expect(decided(p).map((c) => c.arguments.action)).toEqual(['reject']);
    expect(JSON.stringify(decided(p)[0]!.arguments)).toContain('Split it: EU first, US next quarter');
  });
});

describe('Outputs', () => {
  it('keeps native recovery for the selected receipt when the connected SDK silently returns', async () => {
    const p = await open(null, { outputs: { data: outputsView() } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    p.click(`[data-action="out-select"][data-id="${OUT}"]`);
    await p.settle();
    p.click('.pn-md-detail [data-action="open"]');
    await p.settle();
    expect(p.calls.openLink).toHaveBeenCalledExactlyOnceWith({ url: `https://useorgx.com/artifacts/${OUT}` });
    const recovery = p.doc.querySelector('#ox-link-recovery a') as HTMLAnchorElement;
    expect(recovery?.href).toBe(`https://useorgx.com/artifacts/${OUT}`);
    expect(recovery?.target).toBe('_blank');
    expect(recovery?.rel).toContain('noopener');
    expect(recovery?.hasAttribute('data-ox-link')).toBe(false);
    expect(decided(p)).toEqual([]);
  });

  it('rejects an unsafe receipt destination before host dispatch or native recovery', async () => {
    const outputs = outputsView();
    outputs.items[0]!.url = 'javascript:alert(1)';
    const p = await open(null, { outputs: { data: outputs } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    p.click(`[data-action="out-select"][data-id="${OUT}"]`);
    await p.settle();
    p.click('.pn-md-detail [data-action="open"]');
    await p.settle();
    expect(p.calls.openLink).not.toHaveBeenCalled();
    expect(p.doc.querySelector('#ox-link-recovery')).toBeNull();
    expect(decided(p)).toEqual([]);
  });

  it('hydrates the selected canonical answer and routes its decision to the existing controls', async () => {
    const p = await open(null, { outputs: { data: outputsView(), meta: { 'orgx/panelPreviews': { [OUT]: { summary: null, preview: PREVIEW, frontDoor: outputFrontDoor() } } } } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    p.click(`[data-action="out-select"][data-id="${OUT}"]`);
    await p.settle();
    expect(reads(p).filter((c) => c.arguments.query === OUT)).toHaveLength(1);
    const summary = p.doc.querySelector('.pn-md-detail [data-front-door]')!;
    expect(summary.textContent).toContain('Review the client deck');
    expect(summary.textContent).toContain('Budget was not recorded.');
    expect(summary.textContent).toContain('$0.00');
    expect(summary.querySelector('[data-action="out-decide"]')?.getAttribute('data-id')).toBe(D1);
    expect(decided(p)).toEqual([]);
    p.click('[data-front-door] [data-action="out-decide"]');
    await p.settle();
    expect(p.doc.querySelector('#pn-tab-needs[aria-selected="true"]')).not.toBeNull();
    expect(decided(p)).toEqual([]);
    expect(p.calls.updateModelContext).not.toHaveBeenCalled();
  });
  it('renders the output preview as safe structured Markdown', async () => {
    const markdown = '# Client answer\n\n**Review the deck.**\n\n| Work | Owner | Due | State | Next |\n| --- | --- | --- | --- | --- |\n| Deck | Hope | Friday | Ready | Review |\n\n[Unsafe](javascript:alert(1))';
    const p = await open(null, { outputs: { data: outputsView(), meta: { 'orgx/panelPreviews': { [OUT]: { summary: null, preview: markdown } } } } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    p.click(`[data-action="out-select"][data-id="${OUT}"]`);
    await p.settle();
    const preview = p.doc.querySelector('.pn-md-detail .ox-markdown')!;
    expect(preview.querySelector('h1')?.textContent).toBe('Client answer');
    expect(preview.querySelector('strong')?.textContent).toBe('Review the deck.');
    expect(preview.querySelectorAll('th')).toHaveLength(5);
    expect(preview.querySelector('table')?.getAttribute('data-stack')).toBe('true');
    expect(preview.querySelector('a')).toBeNull();
    expect(decided(p)).toEqual([]);
  });

  it('reads view outputs once, shows the chain and the widget-only preview, and reviews with the same decision', async () => {
    const p = await open(null, { outputs: { data: outputsView(), meta: { 'orgx/panelPreviews': { [OUT]: { summary: null, preview: PREVIEW } } } } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    expect(reads(p).filter((c) => c.arguments.view === 'outputs')).toHaveLength(1);
    // The tab counts what waits on the person.
    expect(p.doc.querySelector('#pn-tab-outputs .pn-tab-n')!.textContent).toBe('1');
    p.click(`[data-action="out-select"][data-id="${OUT}"]`);
    await p.settle();
    const detail = p.doc.querySelector('.pn-md-detail')!;
    expect(detail.textContent).toContain(PREVIEW);
    expect(detail.textContent).toContain('Launch post quality bar · 1 of 2 met');
    // Nothing recorded as landed: it says so instead of guessing.
    expect(detail.textContent).toContain('Not recorded');
    expect(detail.querySelector('[data-action="approve"]')).not.toBeNull();
    expect(decided(p)).toEqual([]);
    p.click('.pn-md-detail [data-action="approve"]');
    await p.settle();
    expect(decided(p).map((c) => [c.arguments.decision_id, c.arguments.approval_token])).toEqual([[D1, 'tok-1']]);
    expect(p.calls.updateModelContext).not.toHaveBeenCalled();
  });

  it('says it could not read outputs instead of showing an empty list', async () => {
    const p = await open(null, { outputs: { data: { status: 'unavailable', items: [], total: 0 } } });
    p.click('[data-tab="outputs"]');
    await p.settle();
    expect(p.doc.querySelector('.pn-outputs [data-action="outputs-retry"]')).not.toBeNull();
  });
});

describe('Goals', () => {
  it('turns a first goal into a sentence in the chat, only when Set goal is pressed', async () => {
    const p = await open(null, { goals: { data: goalsView() } });
    p.click('[data-tab="goals"]');
    await p.settle();
    p.type('#gl-goal', '40 paid workspaces by Dec 31');
    expect(p.calls.sendMessage).not.toHaveBeenCalled();
    p.click('[data-action="goal-send"]');
    await p.settle();
    expect(p.calls.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'Create a goal in OrgX: 40 paid workspaces by Dec 31.' }] });
  });

  it('shows progress with the reason from _meta, and no pace without a due date', async () => {
    const goal = {
      id: GOAL, title: '40 paid workspaces', status: 'active', unit: 'workspaces', due: null, target: 40, current: 23, baseline: 12,
      history: [{ at: '2026-09-01T00:00:00.000Z', value: 12 }, { at: '2026-10-01T00:00:00.000Z', value: 23 }],
      moves: [{ at: '2026-10-01T00:00:00.000Z', from: 21, to: 23, delta: 2, has_reason: true, decision_id: null }],
      initiatives: [], initiative_total: 0, url: `https://useorgx.com/objectives/${GOAL}`,
    };
    const p = await open(null, { goals: { data: goalsView([goal]), meta: { 'orgx/panelGoalReasons': { [GOAL]: ['Two trials converted'] } } } });
    p.click('[data-tab="goals"]');
    await p.settle();
    const view = p.doc.querySelector('.pn-goals')!;
    expect(view.textContent).toContain('23 of 40 workspaces');
    expect(view.textContent).toContain('Two trials converted');
    expect(view.textContent).not.toContain('On pace');
    expect(view.textContent).not.toContain('Behind pace');
  });
});

describe('steering a running task', () => {
  it('says the words in the chat for the person, naming the agent and the task', async () => {
    const work = {
      status: 'ok', total: 1,
      items: [{ id: TASK, agent: 'Eli', state: 'running', title: 'Wire the flag', detail: null, updated_at: '2026-10-02T11:59:00.000Z', url: `https://useorgx.com/tasks/${TASK}`, initiative_id: INIT,
        steps: [{ title: 'Read the spec', state: 'done' }, { title: 'Wire it', state: 'live' }] }],
    };
    const p = await open(null, { work: { data: work } });
    p.click('[data-tab="work"]');
    await p.settle();
    p.click(`[data-action="work-select"][data-id="${TASK}"]`);
    await p.settle();
    expect(p.doc.querySelector('.pn-md-detail')!.textContent).toContain('Wire it');
    p.type('input[data-action="steer-text"]', 'Keep the old flag name.');
    expect(p.calls.sendMessage).not.toHaveBeenCalled();
    p.click(`[data-action="steer-send"][data-id="${TASK}"]`);
    await p.settle();
    expect(p.calls.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'In OrgX, tell Eli working on “Wire the flag”: Keep the old flag name.' }] });
    expect(decided(p)).toEqual([]);
  });
});
