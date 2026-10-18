// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot, D1 } from './fixtures/panel';

/**
 * Decisions beyond yes or no: a recommended option that starts picked,
 * several questions asked one at a time, outputs kept or sent back one by
 * one with a note each, and a typed answer saved for next time.
 */
type Call = { name: string; arguments: Record<string, unknown> };
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

const contract = (extra: Record<string, unknown> = {}) => ({
  kind: 'decision',
  actions: ['approve', 'reject'],
  labels: { approve: 'Approve', reject: 'Send back' },
  reject_requires_reason: true,
  answer: null,
  selection: null,
  questions: null,
  items: null,
  ...extra,
});
const withFocus = (focus: Record<string, unknown>) => {
  const base = snapshot();
  return snapshot({ focus: { ...(base.focus as Record<string, unknown>), options: [], multiselect: false, widget_actions: null, ...focus } });
};
const decided = (calls: Mounted['calls']) =>
  calls.callServerTool.mock.calls.map((c: unknown[]) => c[0] as Call).filter((c: Call) => c.name === 'orgx_widget_decide');

async function open(actions: Record<string, unknown>) {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.calls.callServerTool.mockImplementation(async (params: Call) => {
    if (params.name === 'orgx_widget_decide') return { structuredContent: { decision_id: params.arguments.decision_id, action: params.arguments.action === 'reject' ? 'rejected' : 'approved' } };
    if (params.name === 'orgx_get_operation_status') return { structuredContent: { kind: 'decision', id: params.arguments.id, state: 'succeeded', next_poll_after_ms: null } };
    return new Promise(() => undefined);
  });
  m.app().ontoolresult({ structuredContent: withFocus({ widget_actions: actions }), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-1' } } } });
  await m.flush();
  const doc = m.dom.window.document;
  const footer = () => doc.querySelector('.packet ox-footer') as HTMLElement;
  const press = () => footer().dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true, detail: {} }));
  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  const type = (selector: string, value: string) => {
    const area = doc.querySelector(selector) as HTMLTextAreaElement;
    area.value = value;
    area.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
  };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await m.flush(); };
  const wait = (ms: number) => new Promise((r) => m.dom.window.setTimeout(r, ms));
  return { ...m, doc, footer, press, click, type, settle, wait };
}

const option = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, description: null, implied_action: null, requires_reason: false, recommended: false, ...extra });

describe('a recommended option', () => {
  it('starts picked and tagged, and the primary names it; nothing is sent until pressed', async () => {
    const p = await open(contract({
      labels: { approve: 'Approve selected', reject: 'Request changes' },
      selection: { mode: 'single', min: 1, max: 1, required_for: ['approve'], options: [option('a', 'Ship Tuesday'), option('b', 'Ship Monday', { recommended: true, description: 'Two days of buffer' })] },
    }));
    expect(p.doc.querySelector('.opt[data-option="b"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(p.doc.querySelector('.opt[data-option="b"] .opt-tag.rec')!.textContent).toBe('Recommended');
    expect(p.footer().getAttribute('primary-label')).toBe('Go with Ship Monday');
    expect(decided(p.calls)).toEqual([]);
    p.click('.opt[data-option="a"]');
    expect(p.footer().getAttribute('primary-label')).toBe('Go with Ship Tuesday');
    p.press();
    await p.settle();
    expect(decided(p.calls)[0]!.arguments).toMatchObject({ action: 'approve', option_id: 'a' });
  });

  it('pre-checks up to the limit on a multiple selection', async () => {
    const p = await open(contract({
      labels: { approve: 'Confirm selection', reject: 'Request changes' },
      selection: { mode: 'multiple', min: 1, max: 2, required_for: ['approve'], options: ['a', 'b', 'c'].map((id) => option(id, id.toUpperCase(), { recommended: true })) },
    }));
    const pressed = Array.from(p.doc.querySelectorAll('.opt[data-action="toggle-option"]'), (b) => b.getAttribute('aria-pressed'));
    expect(pressed).toEqual(['true', 'true', 'false']);
    expect(p.footer().getAttribute('primary-label')).toBe('Go with these 2');
  });
});

describe('several questions, one at a time', () => {
  const questions = {
    fields: [
      { id: 'tone', step_title: 'Launch', type: 'single_select', label: 'Which tone?', description: null, placeholder: null, required: true, min_select: null, max_select: null, max_length: 2000,
        options: [{ id: 'calm', label: 'Calm', description: null, recommended: true }, { id: 'bold', label: 'Bold', description: null, recommended: false }] },
      { id: 'channels', step_title: null, type: 'multi_select', label: 'Where does it go?', description: null, placeholder: null, required: true, min_select: 1, max_select: 2, max_length: 2000,
        options: ['x', 'li', 'blog'].map((id) => ({ id, label: id.toUpperCase(), description: null, recommended: false })) },
      { id: 'avoid', step_title: null, type: 'text', label: 'Anything to avoid?', description: null, placeholder: 'Optional', required: false, min_select: null, max_select: null, max_length: 2000, options: [] },
    ],
  };

  it('steps through each question, then reviews, then sends answers by field id', async () => {
    const p = await open(contract({ labels: { approve: 'Send answers', reject: 'Send back' }, questions }));
    expect(p.doc.querySelector('.fq-where')!.textContent).toContain('Question 1 of 3');
    expect(p.doc.querySelectorAll('.fq-seg').length).toBe(4);
    // The recommendation starts picked, so Next is live.
    expect(p.doc.querySelector('[data-action="q-pick"][data-value="calm"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(p.footer().getAttribute('primary-label')).toBe('Next');
    p.press();
    expect(p.doc.querySelector('.fq-where')!.textContent).toContain('Question 2 of 3');
    expect(p.footer().hasAttribute('disabled')).toBe(true);
    expect(p.footer().getAttribute('detail')).toBe('answer to continue');
    p.click('[data-action="q-pick"][data-value="x"]');
    p.click('[data-action="q-pick"][data-value="li"]');
    p.click('[data-action="q-pick"][data-value="blog"]');
    expect(p.doc.querySelector('.fq .opts-limit')!.textContent).toBe('You can pick 2. Uncheck one to add “BLOG”.');
    p.press();
    // An optional question offers Skip until it has an answer.
    expect(p.footer().getAttribute('primary-label')).toBe('Review answers');
    expect(p.doc.querySelector('.fq-hint')!.textContent).toBe('Enter to continue');
    p.type('textarea[data-qfield="avoid"]', '  Numbers we cannot back  ');
    const enter = new p.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    p.doc.querySelector('textarea[data-qfield="avoid"]')!.dispatchEvent(enter);
    expect(p.doc.querySelector('.fq-review')).not.toBeNull();
    expect(Array.from(p.doc.querySelectorAll('.fq-row dd'), (d) => d.textContent)).toEqual(['Calm', 'X, LI', 'Numbers we cannot back']);
    expect(p.footer().getAttribute('primary-label')).toBe('Send answers');
    // Change goes back to that question; Back steps one at a time.
    p.click('[data-action="q-goto"][data-step="0"]');
    expect(p.doc.querySelector('.fq-where')!.textContent).toContain('Question 1 of 3');
    expect(p.doc.querySelector('.fq-body')!.getAttribute('data-dir')).toBe('back');
    p.click('[data-action="q-pick"][data-value="bold"]');
    await p.wait(400);
    expect(p.doc.querySelector('.fq-where')!.textContent).toContain('Question 2 of 3');
    p.click('[data-action="q-back"]');
    expect(p.doc.querySelector('.fq-where')!.textContent).toContain('Question 1 of 3');
    p.press(); p.press(); p.press();
    expect(decided(p.calls)).toEqual([]);
    p.press();
    await p.settle();
    expect(decided(p.calls)[0]!.arguments).toEqual({
      decision_id: D1, action: 'approve', approval_token: 'tok-1', kind: 'decision',
      answers: { tone: 'bold', channels: ['x', 'li'], avoid: 'Numbers we cannot back' },
    });
  });

  it('marks the row as a draft once answers are started', async () => {
    const p = await open(contract({ labels: { approve: 'Send answers', reject: 'Send back' }, questions }));
    p.press();
    p.click('[data-action="q-pick"][data-value="x"]');
    expect(p.doc.body.textContent).toContain('Draft · ');
  });
});

describe('outputs reviewed one by one', () => {
  const items = {
    note_required_for_send_back: true,
    items: [
      { id: 'p1', label: 'Post 1', description: 'Teaser', url: 'https://useorgx.com/a/p1', flagged: false, flag_note: null },
      { id: 'p2', label: 'Post 2', description: null, url: null, flagged: true, flag_note: 'Claims a number we cannot back' },
      { id: 'p3', label: 'Post 3', description: null, url: null, flagged: false, flag_note: null },
      { id: 'p4', label: 'Post 4', description: null, url: null, flagged: false, flag_note: null },
    ],
  };
  const review = () => contract({ labels: { approve: 'Keep all', reject: 'Send all back' }, reject_requires_reason: false, items });

  it('starts flagged ones going back with the flag as the note, and names the split on the primary', async () => {
    const p = await open(review());
    expect(p.doc.querySelector('[data-action="item-verdict"][data-item="p2"][data-verdict="send_back"]')!.getAttribute('aria-pressed')).toBe('true');
    expect((p.doc.querySelector('textarea[data-item-note="p2"]') as HTMLTextAreaElement).value).toBe('Claims a number we cannot back');
    expect(p.footer().getAttribute('primary-label')).toBe('Keep 3 · send back 1');
    // Each output carries its own verdict: no separate Send back.
    expect(p.doc.querySelector('.packet [data-action="sendback"]')).toBeNull();
  });

  it('asks for a note on each one going back, jumps to the first missing, and copies only into empty notes', async () => {
    const p = await open(review());
    p.click('[data-action="item-verdict"][data-item="p3"][data-verdict="send_back"]');
    p.click('[data-action="item-verdict"][data-item="p4"][data-verdict="send_back"]');
    expect(p.footer().getAttribute('primary-label')).toBe('Add 2 notes to continue');
    p.press();
    expect(p.doc.activeElement!.getAttribute('data-item-note')).toBe('p3');
    expect(decided(p.calls)).toEqual([]);
    p.click('.fi-copy');
    expect((p.doc.querySelector('textarea[data-item-note="p3"]') as HTMLTextAreaElement).value).toBe('Claims a number we cannot back');
    p.type('textarea[data-item-note="p4"]', 'Too long for X');
    expect(p.footer().getAttribute('primary-label')).toBe('Keep 1 · send back 3');
    p.press();
    await p.settle();
    expect(decided(p.calls)[0]!.arguments).toMatchObject({
      action: 'approve',
      item_reviews: [
        { id: 'p1', verdict: 'keep' },
        { id: 'p2', verdict: 'send_back', note: 'Claims a number we cannot back' },
        { id: 'p3', verdict: 'send_back', note: 'Claims a number we cannot back' },
        { id: 'p4', verdict: 'send_back', note: 'Too long for X' },
      ],
    });
  });

  it('sends everything back as a reject when nothing is kept', async () => {
    const p = await open(review());
    for (const id of ['p1', 'p3', 'p4']) {
      p.click(`[data-action="item-verdict"][data-item="${id}"][data-verdict="send_back"]`);
      p.type(`textarea[data-item-note="${id}"]`, `Fix ${id}`);
    }
    expect(p.footer().getAttribute('primary-label')).toBe('Send all 4 back');
    p.press();
    await p.settle();
    expect(decided(p.calls)[0]!.arguments).toMatchObject({ action: 'reject' });
  });
});

describe('a typed answer saved for next time', () => {
  it('sends remember only when the box is ticked', async () => {
    const p = await open(contract({
      labels: { approve: 'Send answer', reject: 'Decline' }, reject_requires_reason: false,
      answer: { required_for: ['approve'], max_length: 2000, save_as_precedent: true },
    }));
    expect(p.doc.querySelector('.remember')!.textContent).toContain('Save as an approved answer');
    p.type(`textarea[data-field="answer"][data-id="${D1}"]`, 'Use the staging bucket');
    p.click('input[data-action="remember"]');
    p.press();
    await p.settle();
    expect(decided(p.calls)[0]!.arguments).toMatchObject({ answer: 'Use the staging bucket', remember: true });
  });
});
