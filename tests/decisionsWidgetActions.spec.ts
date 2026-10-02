// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountWidget } from './fixtures/live';

/**
 * The decisions widget renders what the server says the person can do:
 * Approve and Send back for any decision that carries an approval token,
 * one button per option when the decision has options, toggles plus
 * Confirm when it allows several, and widget_actions over all of that.
 * Approving is a single click.
 */

const D1 = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const D2 = '1c8d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e';

function decision(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    urgency: 'high',
    agent_name: 'Eli - Engineering',
    type: 'decision_queue',
    summary: `Decision ${id.slice(0, 4)}?`,
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    recommendation: 'Go with the first one.',
    ...extra,
  };
}

function mount(decisions: unknown[], tokens: Record<string, string>) {
  const callTool = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name === 'orgx_widget_decide') {
      return Promise.resolve({ structuredContent: { decision_id: args.decision_id, action: 'approved' } });
    }
    return Promise.resolve({
      structuredContent: { kind: 'decision', id: args.id, state: 'succeeded', outcome: 'Eli continues', next_poll_after_ms: null },
    });
  });
  // jsdom has no CSS.escape; the widget uses it to find its own nodes.
  const scope = window as unknown as { CSS?: { escape?: (value: string) => string } };
  if (!scope.CSS?.escape) scope.CSS = { ...(scope.CSS ?? {}), escape: (value: string) => value.replace(/["\\\]]/g, '\\$&') };
  mountWidget('decisions', { payload: { decisions }, callTool });
  (window as unknown as { openai: Record<string, unknown> }).openai.toolResponseMetadata = {
    'orgx/widgetApproval': { approval_tokens: tokens },
  };
  return callTool;
}

const footer = () => document.querySelector('ox-footer.dq-footer') as HTMLElement | null;
const press = () => footer()!.dispatchEvent(new CustomEvent('ox-primary', { bubbles: true, composed: true }));

afterEach(() => {
  vi.useRealTimers();
});

describe('decisions widget actions', () => {
  it('approves in one click, whatever the urgency or type, and follows the status', async () => {
    const callTool = mount([decision(D1, { urgency: 'critical', type: 'Launch approval' })], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(footer()!.hasAttribute('hold')).toBe(false);
    expect(footer()!.getAttribute('primary-label')).toBe('Approve');
    expect(footer()!.getAttribute('detail')).toBe('recorded in OrgX');
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Send back');
    expect(document.querySelector('.decide-in-orgx')).toBeNull();

    press();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledWith('orgx_command_status', { kind: 'decision', id: D1 }));
    expect(callTool.mock.calls[0]).toEqual(['orgx_widget_decide', { decision_id: D1, action: 'approve', approval_token: 'tok-1' }]);
  });

  it('offers Decide in OrgX only when there is no token', async () => {
    mount([decision(D1, { decide_in_orgx_reason: 'critical' })], {});
    await vi.waitFor(() => expect(document.querySelector('.decide-in-orgx')).not.toBeNull());
    expect(footer()).toBeNull();
  });

  it('renders one button per option and records the chosen one with a single click', async () => {
    const options = [
      { id: 'opt-a', label: 'Tuesday', description: 'recommended' },
      { id: 'opt-b', label: 'Wednesday' },
      { id: 'opt-c', label: 'Thursday' },
    ];
    const callTool = mount([decision(D1, { options })], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(document.querySelectorAll('.dq-opt')).toHaveLength(3));
    expect(footer()!.getAttribute('primary-label')).toBe('');
    expect(footer()!.getAttribute('heading')).toBe('Choose one');
    expect(Array.from(document.querySelectorAll('.dq-opt-label'), (n) => n.textContent)).toEqual(['Tuesday', 'Wednesday', 'Thursday']);

    (document.querySelector('.dq-opt[data-option-id="opt-b"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        action: 'approve',
        option_id: 'opt-b',
        approval_token: 'tok-1',
      })
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('You chose Wednesday'));
  });

  it('turns a multiselect decision into toggles plus Confirm N with option_ids', async () => {
    const options = [
      { id: 'eu', label: 'EU' },
      { id: 'us', label: 'US' },
      { id: 'apac', label: 'APAC' },
    ];
    const callTool = mount([decision(D1, { options, selection: 'multi' })], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(document.querySelectorAll('.dq-opt[aria-pressed]')).toHaveLength(3));
    expect(footer()!.hasAttribute('disabled')).toBe(true);

    (document.querySelector('.dq-opt[data-option-id="us"]') as HTMLButtonElement).click();
    (document.querySelector('.dq-opt[data-option-id="eu"]') as HTMLButtonElement).click();
    expect(callTool).not.toHaveBeenCalled();
    expect(document.querySelector('.dq-opt[data-option-id="eu"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(footer()!.getAttribute('primary-label')).toBe('Confirm 2');
    expect(footer()!.hasAttribute('disabled')).toBe(false);

    press();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        action: 'approve',
        option_ids: ['eu', 'us'],
        approval_token: 'tok-1',
      })
    );
  });

  it('prefers widget_actions from the server over options', async () => {
    const callTool = mount(
      [
        decision(D1, {
          options: [
            { id: 'x', label: 'Ignored' },
            { id: 'y', label: 'Also ignored' },
          ],
          widget_actions: [
            { action: 'approve', option_id: 'ship', label: 'Ship it' },
            { action: 'approve', option_id: 'wait', label: 'Wait a week' },
            { action: 'reject', label: 'Push back' },
          ],
        }),
        decision(D2, { widget_actions: [{ action: 'approve', label: 'Accept the plan' }] }),
      ],
      { [D1]: 'tok-1', [D2]: 'tok-2' }
    );
    await vi.waitFor(() => expect(document.querySelectorAll('.dq-opt')).toHaveLength(2));
    expect(Array.from(document.querySelectorAll('.dq-opt-label'), (n) => n.textContent)).toEqual(['Ship it', 'Wait a week']);
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Push back');
    (document.querySelector('.dq-opt[data-option-id="wait"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', expect.objectContaining({ decision_id: D1, option_id: 'wait' }))
    );
  });

  it('keeps the note flow for Send back', async () => {
    const callTool = mount([decision(D1)], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    // The harness cannot run inline handlers; call what the Send back button calls.
    const trigger = document.querySelector('[data-action="toggle-reject"]') as HTMLButtonElement;
    expect(trigger.getAttribute('onclick')).toContain('toggleRejectComposer');
    (window as unknown as { toggleRejectComposer(id: string, el: HTMLElement): void }).toggleRejectComposer(D1, trigger);
    await vi.waitFor(() => expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull());
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    const note = document.getElementById(`reject-note-${D1}`) as HTMLTextAreaElement;
    note.value = 'Use the staging keys first.';
    (window as unknown as { syncRejectDraft(id: string, el: HTMLTextAreaElement): void }).syncRejectDraft(D1, note);
    expect(footer()!.hasAttribute('disabled')).toBe(false);
    press();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        action: 'reject',
        reason: 'Use the staging keys first.',
        approval_token: 'tok-1',
      })
    );
  });
});
