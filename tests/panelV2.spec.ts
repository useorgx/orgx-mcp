// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountPanel, snapshot, D1, D2 } from './fixtures/panel';

type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

const wait = (m: Mounted, ms: number) => new Promise((r) => m.dom.window.setTimeout(r, ms));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

async function open(data = snapshot(), tokens: Record<string, string> = { [D1]: 'synthetic-token' }) {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: tokens } } });
  await m.flush();
  return m;
}

describe('panel v2 tabs', () => {
  it('shows Needs you, In progress and Done with honest counts', async () => {
    const m = await open();
    const tabs = Array.from(doc(m).querySelectorAll('.pn-tab')).map((t) => t.textContent);
    expect(tabs).toEqual(['Needs you2', 'In progress', 'Done', 'Start']); // Done counts only once something was settled here
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
  });

  it('reads In progress only when it is opened, with view "work"', async () => {
    const m = await open();
    expect(m.calls.callServerTool).not.toHaveBeenCalled();
    m.calls.callServerTool.mockResolvedValueOnce({
      structuredContent: snapshot({
        generated_at: '2026-10-02T12:05:00.000Z',
        work: { status: 'ok', total: 2, items: [
          { id: 'w1', agent: 'Dana', title: 'Design plan', state: 'blocked', url: 'https://useorgx.com/live' },
          { id: 'w2', agent: 'Eli', title: 'Reconcile telemetry', state: 'running', url: 'https://useorgx.com/live' },
        ] },
      }),
    });
    click(m, '[data-tab="work"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);
    expect(m.calls.callServerTool.mock.calls[0]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: { view: 'work' } });
    const rows = Array.from(doc(m).querySelectorAll('.pn-work .wk-t')).map((n) => n.textContent);
    expect(rows).toEqual(['Design plan', 'Reconcile telemetry']);
    expect(doc(m).querySelector('#pn-tab-work .pn-tab-n')!.textContent).toBe('2');
    expect(doc(m).querySelector('#pn-tab-work .pn-tab-n')!.getAttribute('data-tone')).toBe('red');
  });

  it('says agent status is unavailable instead of showing an empty list when the read fails', async () => {
    const m = await open();
    m.calls.callServerTool.mockRejectedValueOnce(new Error('down'));
    click(m, '[data-tab="work"]');
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-work')!.textContent).toContain('could not be read');
    expect(doc(m).querySelector('.pn-work')!.textContent).not.toContain('Nothing is running');
    expect(doc(m).querySelector('[data-action="work-retry"]')).not.toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    const m = await open();
    const needs = doc(m).querySelector('#pn-tab-needs') as HTMLElement;
    needs.focus();
    needs.dispatchEvent(new m.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await m.flush();
    // Left from the first tab wraps to the last: Start.
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('start');
    expect(doc(m).activeElement!.id).toBe('pn-tab-start');
  });

  it('keeps a receipt in Done for a decision settled in this panel', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'approved' } }
      : { structuredContent: { kind: 'decision', id: D1, state: 'succeeded', outcome: 'approved', next_poll_after_ms: null } });
    doc(m).querySelector('ox-footer[data-id]')!.dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true }));
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('#pn-tab-done .pn-tab-n')!.textContent).toBe('1');
    // Done opens on Work; the decisions this panel settled are one press away.
    click(m, '[data-tab="done"]');
    await m.flush();
    click(m, '[data-action="done-lens"][data-id="decisions"]');
    await m.flush();
    const done = doc(m).querySelector('.pn-done')!;
    expect(done.textContent).toContain('Ship release 4.2?');
    expect(done.textContent).toContain('Approved by you');
    click(m, `[data-action="receipt"][data-id="${D1}"]`);
    await m.flush();
    // The receipt opens in the detail pane beside the list.
    expect(doc(m).querySelector(`[data-action="receipt"][data-id="${D1}"]`)!.getAttribute('aria-pressed')).toBe('true');
    // The lightweight receipt: decided and recorded proven, the outcome named as missing.
    const lines = Array.from(doc(m).querySelectorAll('.pn-md-detail .rt-line')).map((l) => [l.getAttribute('data-s'), l.textContent]);
    expect(lines.map((l) => l[0])).toEqual(['pass', 'pass', 'none']);
    expect(lines[1]![1]).toContain('Recorded in OrgX');
    expect(lines[2]![1]).toContain('not on this receipt yet');
    expect(doc(m).querySelector(`[data-action="receipt"][data-id="${D1}"] .rt`)!.getAttribute('aria-label')).toBe('Decided: proven. Recorded: proven. Outcome: no proof');
    expect(done.textContent).toContain('Decision history');
  });
});

describe('panel lightweight receipt after a decision', () => {
  it('confirms in one line with the receipt marks, then leaves Done to hold the full receipt', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'orgx_widget_decide') return { structuredContent: { action: 'approved' } };
      if (name === 'orgx_get_operation_status') return { structuredContent: { kind: 'decision', id: D1, state: 'succeeded', outcome: 'approved', next_poll_after_ms: null } };
      // The re-read after the ruling: D1 has left the queue.
      const base = snapshot();
      return { structuredContent: snapshot({
        generated_at: '2026-10-02T12:09:00.000Z',
        attention: { pending: 1, oldest_at: '2026-09-30T10:00:00.000Z', blocking: false },
        queue: (base.queue as Array<{ id: string }>).filter((q) => q.id !== D1),
        focus: null,
      }) };
    });
    doc(m).querySelector('ox-footer[data-id]')!.dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true }));
    await wait(m, 1300);
    const receipt = doc(m).querySelector('.notice.receipt')!;
    expect(receipt).not.toBeNull();
    expect(receipt.textContent).toContain('Approved by you');
    expect(receipt.querySelector('.rt')!.getAttribute('aria-label')).toBe('Decided: proven. Recorded: proven. Outcome: no proof');
    // Done holds the receipt; the one-line notice does not repeat it there.
    click(m, '[data-action="done-decisions"]');
    await m.flush();
    expect(doc(m).querySelector('.notice.receipt')).toBeNull();
    expect(doc(m).querySelector('.pn-done-sum')!.textContent).toContain('1 decision settled');
  });
});

describe('panel v2 start work in chat', () => {
  // Calm: one way to Start; the sentence is composed there and sent as a user message.
  async function composeInStart(m: Mounted, text: string) {
    // Calm: the empty state's prompt opens Start with the cursor in the composer.
    click(m, '[data-action="start-open"]');
    await m.flush();
    expect(doc(m).activeElement!.id).toBe('st-text');
    const ta = doc(m).querySelector('#st-text') as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
  }

  it('posts the exact sentence as a user message', async () => {
    const m = await open(snapshot({ queue: [], focus: null, attention: { pending: 0, oldest_at: null, blocking: false }, proof: { last_accepted: null, completed_unaccepted: 1 } }), {});
    await composeInStart(m, 'Launch the pricing page');
    click(m, '[data-action="start-send"]');
    await m.flush(); await m.flush();
    expect(m.calls.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'Start a new initiative in OrgX: Launch the pricing page.' }] });
    expect(doc(m).querySelector('.st-status')!.getAttribute('data-outcome')).toBe('sent');
  });

  it('never shows launch prompts above a pending decision', async () => {
    const m = await open();
    expect(doc(m).querySelector('.pn-launch')).toBeNull();
    expect(doc(m).querySelector('.pn-tip')).toBeNull();
    // The decision itself offers to ask ChatGPT about it.
    expect(Array.from(doc(m).querySelectorAll('.pn-asks .pn-ask')).map((b) => b.textContent)).toEqual(['Explain the risk', 'What breaks if I wait?']);
  });

  it('copies the sentence and says so when the host cannot post a message', async () => {
    const m = await open(snapshot({ queue: [], focus: null, attention: { pending: 0, oldest_at: null, blocking: false }, proof: { last_accepted: null, completed_unaccepted: 1 } }), {});
    m.calls.sendMessage.mockRejectedValueOnce(new Error('not supported'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(m.dom.window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    await composeInStart(m, 'Launch the pricing page');
    click(m, '[data-action="start-send"]');
    await m.flush(); await m.flush();
    expect(writeText).toHaveBeenCalledWith('Start a new initiative in OrgX: Launch the pricing page.');
    expect(doc(m).querySelector('.st-status')!.textContent).toContain('Paste it into the chat');
    // Copied, not sent: the text stays so the person can still edit it.
    expect((doc(m).querySelector('#st-text') as HTMLTextAreaElement).value).toBe('Launch the pricing page');
  });

  it('offers one next prompt when calm, not a prompt and a tip', async () => {
    const calm = snapshot({ queue: [], focus: null, attention: { pending: 0, oldest_at: null, blocking: false }, proof: { last_accepted: null, completed_unaccepted: 1 } });
    const m = await open(calm, {});
    expect(doc(m).querySelectorAll('[data-action="start-open"]')).toHaveLength(1);
    expect(doc(m).querySelector('.pn-tip')).toBeNull();
    // In progress has not been read: the empty state claims nothing about it.
    expect(doc(m).querySelector('.cm-sub')!.textContent!.trim()).toBe('Nothing needs your decision.');
  });
});

describe('panel v2 identity and tour', () => {
  it('shows who is asking on the decision and on queue rows', async () => {
    const base = snapshot();
    const m = await open(snapshot({
      focus: { ...base.focus, asker: 'Eli - Engineering' },
      queue: base.queue.map((q, i) => ({ ...q, asker: i === 1 ? 'Pace - Product' : 'Eli - Engineering' })),
    }));
    expect(doc(m).querySelector('.packet .meta')!.textContent).toContain('Eli - Engineering asks');
    expect(doc(m).querySelector('.packet .pn-asker ox-avatar')).not.toBeNull();
    expect(doc(m).querySelector(`[data-row="${D2}"] .row-av ox-avatar`)).not.toBeNull();
  });

  it('never sends a ruling while the tour is open; the practice press reverts', async () => {
    const m = await open();
    click(m, '[data-action="tour"]');
    await wait(m, 60);
    const next = () => (doc(m).querySelector('[data-tour="next"]') as HTMLButtonElement).click();
    next(); await wait(m, 60);
    next(); await wait(m, 60);
    expect(doc(m).querySelector('.pn-coach-t')!.textContent).toContain('Decide in one press');
    const footer = doc(m).querySelector('ox-footer[data-id]')!;
    footer.dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true }));
    await m.flush();
    expect(footer.getAttribute('heading')).toContain('Practice');
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_widget_decide')).toHaveLength(0);
    await wait(m, 2300);
    expect(doc(m).querySelector('.pn-try')!.className).toContain('is-ok');
    (doc(m).querySelector('[data-tour="skip"]') as HTMLButtonElement).click();
    expect(doc(m).querySelector('.pn-tour')).toBeNull();
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_widget_decide')).toHaveLength(0);
  });

  it('does not start the tour by itself without layout (headless or hidden frames)', async () => {
    const m = await open();
    await wait(m, 700);
    expect(doc(m).querySelector('.pn-tour')).toBeNull();
  });
});

describe('panel v2 review fixes', () => {
  it('recovers In progress after a page-cache restore drops the work read', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementationOnce(() => new Promise(() => {}));
    click(m, '[data-tab="work"]');
    await m.flush();
    expect(doc(m).querySelector('.pn-work')!.getAttribute('aria-busy')).toBe('true');
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ generated_at: '2026-10-02T12:09:00.000Z', work: { status: 'ok', total: 0, items: [] } }) });
    m.dom.window.dispatchEvent(new m.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    m.dom.window.dispatchEvent(new m.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-work')!.textContent).toContain('Nothing is running right now');
  });

  it('does not open send-back or pick options while the tour is open', async () => {
    const m = await open();
    click(m, '[data-action="tour"]');
    await wait(m, 60);
    click(m, '[data-action="sendback"]');
    await m.flush();
    expect(doc(m).querySelector('textarea[data-reason]')).toBeNull();
  });
});
