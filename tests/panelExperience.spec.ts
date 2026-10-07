// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountPanel, snapshot, D1 } from './fixtures/panel';

const mounted: Awaited<ReturnType<typeof mountPanel>>[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
async function open() {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'synthetic-token' } } } });
  await m.flush();
  return m;
}
function approve(m: Awaited<ReturnType<typeof mountPanel>>) {
  m.dom.window.document.querySelector('ox-footer[data-id]')!.dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true }));
}
const footer = (m: Awaited<ReturnType<typeof mountPanel>>) => m.dom.window.document.querySelector('ox-footer[data-id]');

describe('panel experience lifetime and recovery', () => {
  it('does not transfer drafts into another workspace, even with an older timestamp', async () => {
    const m = await open();
    const doc = m.dom.window.document;
    (doc.querySelector('[data-action="sendback"]') as HTMLButtonElement).click();
    const area = doc.querySelector('textarea[data-reason]') as HTMLTextAreaElement;
    area.value = 'Private workspace A note';
    area.dispatchEvent(new m.dom.window.Event('input', { bubbles: true }));
    m.app().ontoolresult({ structuredContent: snapshot({ workspace: { id: 'workspace-b', name: 'Workspace B' }, generated_at: '2026-10-01T12:00:00Z' }) });
    await m.flush();
    expect(doc.body.textContent).toContain('Workspace B');
    expect(doc.querySelector('textarea')).toBeNull();
    expect(doc.body.textContent).not.toContain('Private workspace A note');
    expect(doc.querySelector('ox-footer[data-id]')).toBeNull();
  });
  it('ignores an approval completion from the previous workspace and blocks double activation', async () => {
    const m = await open();
    let finish!: (value: unknown) => void;
    m.calls.callServerTool.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    approve(m); approve(m);
    await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);
    m.app().ontoolresult({ structuredContent: snapshot({ workspace: { id: 'workspace-b', name: 'Workspace B' } }) });
    finish({ structuredContent: { action: 'approved' } });
    await m.flush();
    expect(footer(m)?.getAttribute('state')).not.toBe('confirmed');
    expect(m.dom.window.document.getElementById('panel')!.textContent).not.toContain('Approved by you');
  });
  it.each(['failed', 'cancelled', 'not_found'])('unwraps %s status without displaying a confirmed receipt', async (state) => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'approved' } }
      : { structuredContent: { kind: 'decision', id: D1, state, next_poll_after_ms: null } });
    approve(m);
    await m.flush(); await m.flush();
    expect(footer(m)?.getAttribute('state')).not.toBe('confirmed');
    expect(footer(m)?.getAttribute('heading')).toBe(state === 'not_found' ? 'Decision recorded' : 'Could not continue');
  });
  it('shows a quiet recorded receipt after a status read fails', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'orgx_widget_decide') return { structuredContent: { action: 'approved' } };
      throw new Error('Status unavailable');
    });
    approve(m);
    await m.flush(); await m.flush();
    expect(footer(m)?.getAttribute('state')).toBe('stale');
    expect(footer(m)?.getAttribute('heading')).toBe('Decision recorded');
    expect(footer(m)?.getAttribute('detail')).toContain('Check the receipt');
  });
  it.each([undefined, null, 'expired'])('does not confirm a succeeded status with outcome %s', async (outcome) => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'approved' } }
      : { structuredContent: { kind: 'decision', id: D1, state: 'succeeded', outcome, next_poll_after_ms: null } });
    approve(m); await m.flush(); await m.flush();
    expect(footer(m)?.getAttribute('state')).toBe('stale');
    expect(footer(m)?.getAttribute('heading')).toBe('Decision recorded');
  });
  it.each([
    { winner: 0, outcome: 'approved', heading: 'Approved by you' },
    { winner: 1, outcome: 'approved', heading: 'Approved by you' },
    { winner: 0, outcome: 'declined', heading: 'Already declined in OrgX' },
    { winner: 1, outcome: 'declined', heading: 'Already declined in OrgX' },
  ])('keeps $outcome final when status read $winner wins the race', async ({ winner, outcome, heading }) => {
    const m = await open();
    const finish: ((value: unknown) => void)[] = [];
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'orgx_widget_decide') return { structuredContent: { action: 'approved' } };
      return new Promise((resolve) => finish.push(resolve));
    });
    approve(m); await m.flush();
    footer(m)!.dispatchEvent(new m.dom.window.CustomEvent('ox-action', { bubbles: true, detail: { action: 'check_now' } }));
    await m.flush();
    expect(finish).toHaveLength(2);
    finish[winner]!({ structuredContent: { kind: 'decision', id: D1, state: 'succeeded', outcome, next_poll_after_ms: null } });
    await m.flush();
    expect(footer(m)?.getAttribute('heading')).toBe(heading);
    finish[1 - winner]!({ structuredContent: { kind: 'decision', id: D1, state: 'held', next_poll_after_ms: null } });
    await m.flush();
    expect(footer(m)?.getAttribute('heading')).toBe(heading);
  });
  it('recovers from a malformed refresh instead of spinning forever', async () => {
    const m = await mountPanel({}, {}); mounted.push(m);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: { schema: 'orgx.panel.v1' } });
    m.app().ontoolresult({ isError: true, structuredContent: { error: { code: 'network', message: 'No response' } } });
    await m.flush();
    (m.dom.window.document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await m.flush();
    expect(m.dom.window.document.getElementById('panel')!.getAttribute('aria-busy')).toBe('false');
    expect(m.dom.window.document.body.textContent).toContain('could not load');
  });
  it.each(['network', 'tool_failed'])('reads the outcome after %s without repeating the ruling', async (code) => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'orgx_widget_decide') throw Object.assign(new Error('{'), { code });
      return { structuredContent: snapshot() };
    });
    approve(m);
    await m.flush(); await m.flush();
    const recovery = m.dom.window.document.querySelector('.error-line [data-action="refresh"]') as HTMLButtonElement;
    expect(recovery).not.toBeNull();
    expect(m.dom.window.document.querySelector('.error-line')!.textContent).not.toContain('Nothing changed');
    recovery.click(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_widget_decide')).toHaveLength(1);
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_panel_snapshot')).toHaveLength(2);
  });
  it('ends exhausted polling in an unconfirmed receipt with no spinner', async () => {
    const m = await open();
    const timeout = m.dom.window.setTimeout.bind(m.dom.window);
    m.dom.window.setTimeout = ((fn: TimerHandler, ms?: number) => timeout(fn, ms && ms >= 400 ? 0 : ms)) as typeof m.dom.window.setTimeout;
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? { structuredContent: { action: 'approved' } }
      : { structuredContent: { kind: 'decision', id: D1, state: 'held', next_poll_after_ms: 400 } });
    approve(m);
    await vi.waitFor(() => expect(footer(m)?.getAttribute('state')).toBe('stale'));
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_command_status')).toHaveLength(13);
  });
  it('auth resume accepts an earlier timestamp and drops authority from the prior result', async () => {
    const m = await open();
    m.app().ontoolresult({ isError: true, structuredContent: { error: { code: 'authentication_required', message: 'Sign in' } } });
    await m.flush();
    expect(m.dom.window.document.getElementById('panel')!.textContent).toContain('Sign in');
    m.app().ontoolresult({ structuredContent: snapshot({ generated_at: '2026-10-01T12:00:00Z' }) });
    await m.flush();
    expect(m.dom.window.document.getElementById('panel')!.textContent).toContain('Ship release');
    expect(footer(m)).toBeNull();
  });
  it('reopening a cached page reads state without replaying its pending approval', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => name === 'orgx_widget_decide'
      ? new Promise(() => {}) : { structuredContent: snapshot() });
    approve(m); await m.flush();
    m.dom.window.dispatchEvent(new m.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    m.dom.window.dispatchEvent(new m.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await m.flush();
    expect(m.calls.callServerTool.mock.calls.filter(([p]) => p.name === 'orgx_widget_decide')).toHaveLength(1);
    expect(m.calls.callServerTool.mock.calls.at(-1)![0].name).toBe('orgx_panel_snapshot');
    expect(footer(m)?.getAttribute('state')).toBe('stale');
  });
  it('makes duplicate queue headlines reviewable before allowing a ruling', async () => {
    const m = await open();
    const data = snapshot();
    data.queue[1]!.title = data.queue[0]!.title;
    m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(data.queue.map((item) => [item.id, 'fixture-token'])) } } });
    await m.flush();
    const row = m.dom.window.document.querySelector('.row')!;
    expect(row.querySelector('[data-action="approve"]')).toBeNull();
    expect(row.querySelector('.mini')!.textContent).toBe('Review');
  });
});
