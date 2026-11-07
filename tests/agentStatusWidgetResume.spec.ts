// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEventSource, mountWidget, readSharedScript } from './fixtures/live';

/**
 * Resume on a stalled run reads what resume_agent_run answered and what the
 * run status says afterwards, and never offers a press that cannot succeed.
 */

const RUN = '3f2b9c1e-7a4d-4e6b-9c8a-1d2e3f4a5b6c';
type Args = Record<string, unknown>;

function stalledPayload() {
  return {
    agents: [{
      agent_id: 'engineering-agent', agent_name: 'Eli', role: 'Engineering',
      status: 'stalled', run_id: RUN, stalled_minutes: 45,
      current_task: 'Inspect the retained source',
      updated_at: '2026-10-10T15:40:00Z',
    }],
  };
}

let mountedListeners: Array<[string, EventListener]> = [];
function unmount() {
  for (const [type, listener] of mountedListeners) document.removeEventListener(type, listener);
  mountedListeners = [];
}

function mount(handlers: { resume?: () => unknown; status?: (call: number) => unknown }) {
  unmount();
  let statusCalls = 0;
  const callTool = vi.fn((name: string, _args: Args) => {
    if (name === 'resume_agent_run') {
      return Promise.resolve(handlers.resume ? handlers.resume() : { structuredContent: { ok: true, run_id: RUN, status: 'running', prior_status: 'paused' } });
    }
    if (name === 'orgx_get_operation_status') {
      statusCalls += 1;
      return Promise.resolve(handlers.status ? handlers.status(statusCalls) : { structuredContent: { kind: 'run', id: RUN, state: 'running', next_poll_after_ms: 2000 } });
    }
    return Promise.resolve({ structuredContent: {} });
  });
  const scope = window as unknown as { CSS?: { escape?: (value: string) => string } };
  if (!scope.CSS?.escape) scope.CSS = { ...(scope.CSS ?? {}), escape: (value: string) => value.replace(/["\\\]]/g, '\\$&') };
  // Document listeners outlive a mount; drop the previous widget's so only
  // the mounted widget answers a press.
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
    mountedListeners.push([type, listener]);
    return realAdd(type, listener, options as AddEventListenerOptions);
  }) as typeof document.addEventListener;
  try {
    mountWidget('agent-status', { payload: stalledPayload(), callTool });
  } finally {
    document.addEventListener = realAdd;
  }
  return callTool;
}

const footer = () => document.querySelector('ox-footer.agent-footer') as HTMLElement | null;
const press = () => footer()!.dispatchEvent(new CustomEvent('ox-primary', { bubbles: true, composed: true }));
const resumeCalls = (callTool: ReturnType<typeof mount>) => callTool.mock.calls.filter(([name]) => name === 'resume_agent_run');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T16:30:00Z'));
  FakeEventSource.reset();
  window.eval(readSharedScript('kit/ox-elements-core.js'));
  window.eval(readSharedScript('widget-state.js'));
  if (typeof window.matchMedia !== 'function')
    window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe('agent status resume', () => {
  it('says a run that was already running did not restart and hands off to OrgX', async () => {
    const callTool = mount({
      resume: () => ({
        content: [{ type: 'text', text: `Run ${RUN} is already running.` }],
        structuredContent: { ok: true, noop: true, run_id: RUN, status: 'running', message: 'Run is already running' },
      }),
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(footer()?.getAttribute('data-role')).toBe('resume');
    expect(footer()?.getAttribute('primary-label')).toBe('Resume');

    press();
    await vi.advanceTimersByTimeAsync(5000);

    expect(resumeCalls(callTool)).toHaveLength(1);
    expect(callTool.mock.calls.some(([name]) => name === 'orgx_get_operation_status')).toBe(false);
    expect(footer()!.getAttribute('heading')).toBe('Already running');
    expect(footer()!.getAttribute('heading')).not.toContain('running again');
    expect(footer()!.getAttribute('detail')).toContain('no recent heartbeat');
    expect(footer()!.getAttribute('primary-label')).toBe('Open in OrgX ↗');
    expect(footer()!.getAttribute('data-role')).toBe('handoff');
    expect(footer()!.getAttribute('data-url')).toContain(RUN);

    // Pressing it again opens OrgX instead of resuming a second time.
    press();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumeCalls(callTool)).toHaveLength(1);
  });

  it('hands a failed or cancelled run off to OrgX instead of offering Retry', async () => {
    for (const state of ['failed', 'cancelled']) {
      const callTool = mount({
        status: () => ({ structuredContent: { kind: 'run', id: RUN, state, outcome: 'tests failed', next_poll_after_ms: null } }),
      });
      await vi.advanceTimersByTimeAsync(400);
      press();
      await vi.advanceTimersByTimeAsync(5000);

      expect(footer()!.getAttribute('state')).toBe('failed');
      expect(footer()!.getAttribute('heading')).toBe(state === 'cancelled' ? 'Run cancelled' : 'Run failed');
      expect(footer()!.getAttribute('primary-label')).toBe('Open in OrgX ↗');
      expect(footer()!.getAttribute('primary-label')).not.toBe('Retry');
      expect(footer()!.getAttribute('data-role')).toBe('handoff');

      press();
      await vi.advanceTimersByTimeAsync(1000);
      expect(resumeCalls(callTool)).toHaveLength(1);
    }
  });

  it('keeps the confirmed running state when the poll window ends', async () => {
    const callTool = mount({});
    await vi.advanceTimersByTimeAsync(400);
    press();
    await vi.advanceTimersByTimeAsync(130000);

    const polls = callTool.mock.calls.filter(([name]) => name === 'orgx_get_operation_status').length;
    expect(polls).toBeGreaterThan(1);
    expect(footer()!.getAttribute('state')).toBe('running');
    expect(footer()!.getAttribute('heading')).toBe('Eli is running again');
    expect(footer()!.getAttribute('heading')).not.toBe('Resume sent');

    // Polling has stopped.
    await vi.advanceTimersByTimeAsync(60000);
    expect(callTool.mock.calls.filter(([name]) => name === 'orgx_get_operation_status').length).toBe(polls);
  });

  it('keeps a confirmed queued state at the deadline and lets the person check again', async () => {
    const callTool = mount({
      status: () => ({ structuredContent: { kind: 'run', id: RUN, state: 'queued', next_poll_after_ms: 5000 } }),
    });
    await vi.advanceTimersByTimeAsync(400);
    press();
    await vi.advanceTimersByTimeAsync(130000);

    expect(footer()!.getAttribute('state')).toBe('queued');
    expect(footer()!.getAttribute('heading')).toBe('Waiting to start');
    expect(footer()!.getAttribute('action-label')).toBe('Check now');

    const polls = callTool.mock.calls.filter(([name]) => name === 'orgx_get_operation_status').length;
    footer()!.dispatchEvent(new CustomEvent('ox-action', { bubbles: true, composed: true, detail: {} }));
    await vi.advanceTimersByTimeAsync(100);
    expect(callTool.mock.calls.filter(([name]) => name === 'orgx_get_operation_status').length).toBe(polls + 1);
    expect(resumeCalls(callTool)).toHaveLength(1);
  });

  it('still says the resume is unconfirmed when no status was ever read', async () => {
    mount({ status: () => ({ structuredContent: { unexpected: true } }) });
    await vi.advanceTimersByTimeAsync(400);
    press();
    await vi.advanceTimersByTimeAsync(5000);
    expect(footer()!.getAttribute('heading')).toBe('Resume sent');
    expect(footer()!.getAttribute('action-label')).toBe('Check now');
  });
});
