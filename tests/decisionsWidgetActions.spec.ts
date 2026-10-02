// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountWidget } from './fixtures/live';

/**
 * The decisions widget renders what the server says the person can do. Each
 * pending item's `widget_actions` (the app's per-item contract) sets the two
 * buttons and their labels, the options (one or several, an option that
 * implies approve or reject, an option that asks why), a typed answer, and
 * whether sending back needs a reason. The widget always sends the item's
 * kind, keeps approvals to one click, follows the status after success and
 * says something specific for every refusal code.
 *
 * Older payloads still render: the provisional list of actions, and options
 * without widget_actions.
 */

const D1 = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const D2 = '1c8d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e';
const A1 = '2d9e3f40-5162-4c7d-8e9f-0a1b2c3d4e5f';

type Args = Record<string, unknown>;
type Decide = (args: Args) => unknown;

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

function contract(extra: Record<string, unknown> = {}) {
  return {
    kind: 'decision',
    actions: ['approve', 'reject'],
    labels: { approve: 'Approve', reject: 'Send back' },
    reject_requires_reason: true,
    answer: null,
    selection: null,
    ...extra,
  };
}

/** What the worker returns when the app refuses a click. */
function refusal(code: string, message: string, details?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: { code, message, ...(details ? { details } : {}) } },
  };
}

function mount(
  decisions: unknown[],
  tokens: Record<string, string>,
  opts: { decide?: Decide; refresh?: () => unknown } = {}
) {
  const callTool = vi.fn((name: string, args: Args) => {
    if (name === 'orgx_widget_decide') {
      if (opts.decide) return Promise.resolve(opts.decide(args));
      return Promise.resolve({ structuredContent: { decision_id: args.decision_id, kind: args.kind, action: 'approved', status: 'approved' } });
    }
    // The runtime rewrites the widget's get_pending_decisions refresh to the
    // canonical orgx_decide list_pending the connection lists.
    if (name === 'orgx_decide' && args.action === 'list_pending') {
      return Promise.resolve(opts.refresh ? opts.refresh() : { structuredContent: { decisions: [] } });
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
const pressAction = () => footer()!.dispatchEvent(new CustomEvent('ox-action', { bubbles: true, composed: true, detail: {} }));
const option = (id: string, forAction = 'approve') =>
  document.querySelector(`.dq-opt[data-option-id="${id}"][data-for="${forAction}"]`) as HTMLButtonElement | null;
const type = (fieldId: string, value: string) => {
  const field = document.getElementById(fieldId) as HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
const openSendBack = (id: string) => {
  // The harness cannot run inline handlers; call what the Send back button calls.
  const trigger = document.querySelector('[data-action="toggle-reject"]') as HTMLButtonElement;
  expect(trigger.getAttribute('onclick')).toContain('toggleRejectComposer');
  (window as unknown as { toggleRejectComposer(id: string, el: HTMLElement): void }).toggleRejectComposer(id, trigger);
};
const decideCalls = (callTool: ReturnType<typeof mount>) => callTool.mock.calls.filter(([name]) => name === 'orgx_widget_decide');
const fieldError = () => document.querySelector('.dq-field-error')?.textContent ?? null;

afterEach(() => {
  vi.useRealTimers();
});

describe('decisions widget actions', () => {
  it('approves in one click, whatever the urgency or type, sends the kind and follows the status', async () => {
    const callTool = mount([decision(D1, { urgency: 'critical', type: 'Launch approval' })], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(footer()!.hasAttribute('hold')).toBe(false);
    expect(footer()!.getAttribute('primary-label')).toBe('Approve');
    expect(footer()!.getAttribute('detail')).toBe('recorded in OrgX');
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Send back');
    expect(document.querySelector('.decide-in-orgx')).toBeNull();

    press();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledWith('orgx_command_status', { kind: 'decision', id: D1 }));
    expect(callTool.mock.calls[0]).toEqual([
      'orgx_widget_decide',
      { decision_id: D1, kind: 'decision', action: 'approve', approval_token: 'tok-1' },
    ]);
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

    option('opt-b')!.click();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        kind: 'decision',
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

    option('us')!.click();
    option('eu')!.click();
    expect(callTool).not.toHaveBeenCalled();
    expect(option('eu')!.getAttribute('aria-pressed')).toBe('true');
    expect(footer()!.getAttribute('primary-label')).toBe('Confirm 2');
    expect(footer()!.hasAttribute('disabled')).toBe(false);

    press();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        kind: 'decision',
        action: 'approve',
        option_ids: ['eu', 'us'],
        approval_token: 'tok-1',
      })
    );
  });

  it('still reads the provisional list of actions over options', async () => {
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
    option('wait')!.click();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', expect.objectContaining({ decision_id: D1, option_id: 'wait', kind: 'decision' }))
    );
  });

  it('keeps the note flow for Send back', async () => {
    const callTool = mount([decision(D1)], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    openSendBack(D1);
    await vi.waitFor(() => expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull());
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    expect(footer()!.getAttribute('detail')).toBe('write a note first');
    const note = document.getElementById(`reject-note-${D1}`) as HTMLTextAreaElement;
    note.value = 'Use the staging keys first.';
    (window as unknown as { syncRejectDraft(id: string, el: HTMLTextAreaElement): void }).syncRejectDraft(D1, note);
    expect(footer()!.hasAttribute('disabled')).toBe(false);
    press();
    await vi.waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('orgx_widget_decide', {
        decision_id: D1,
        kind: 'decision',
        action: 'reject',
        reason: 'Use the staging keys first.',
        approval_token: 'tok-1',
      })
    );
  });
});

describe('decisions widget: the per-item contract', () => {
  it('asks for a typed answer on an external question, with the server labels', async () => {
    const callTool = mount(
      [
        decision(D1, {
          summary: 'Which staging database should the migration use?',
          widget_actions: contract({
            labels: { approve: 'Send answer', reject: 'Decline' },
            reject_requires_reason: false,
            answer: { required_for: ['approve'], max_length: 2000 },
          }),
        }),
      ],
      { [D1]: 'tok-1' }
    );
    await vi.waitFor(() => expect(document.getElementById(`answer-${D1}`)).not.toBeNull());
    const answer = document.getElementById(`answer-${D1}`) as HTMLTextAreaElement;
    expect(answer.getAttribute('maxlength')).toBe('2000');
    expect(document.querySelector(`label[for="answer-${D1}"]`)!.textContent).toBe('Your answer · required');
    expect(footer()!.getAttribute('primary-label')).toBe('Send answer');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    expect(footer()!.getAttribute('detail')).toBe('type your answer first');
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Decline');

    type(`answer-${D1}`, '  staging-eu-2  ');
    expect(footer()!.hasAttribute('disabled')).toBe(false);
    press();
    await vi.waitFor(() =>
      expect(decideCalls(callTool)[0]).toEqual([
        'orgx_widget_decide',
        { decision_id: D1, kind: 'decision', action: 'approve', answer: 'staging-eu-2', approval_token: 'tok-1' },
      ])
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('done'));
    expect(footer()!.getAttribute('heading')).toBe('Answer sent by you');
  });

  it('declines without a note when the server does not require one', async () => {
    const callTool = mount(
      [
        decision(D1, {
          summary: 'Grant Mara edit access to the billing workspace?',
          widget_actions: contract({ labels: { approve: 'Grant access', reject: 'Deny' }, reject_requires_reason: false }),
        }),
      ],
      { [D1]: 'tok-1' }
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('primary-label')).toBe('Grant access'));
    openSendBack(D1);
    await vi.waitFor(() => expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull());
    expect(document.querySelector(`label[for="reject-note-${D1}"]`)!.textContent).toContain('optional');
    expect(footer()!.getAttribute('primary-label')).toBe('Deny');
    expect(footer()!.hasAttribute('disabled')).toBe(false);
    press();
    await vi.waitFor(() =>
      expect(decideCalls(callTool)[0]).toEqual([
        'orgx_widget_decide',
        { decision_id: D1, kind: 'decision', action: 'reject', approval_token: 'tok-1' },
      ])
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('Denied by you'));
  });

  it('requires a note to request changes on an artifact review', async () => {
    const callTool = mount(
      [decision(D1, { widget_actions: contract({ labels: { approve: 'Approve', reject: 'Request changes' }, reject_requires_reason: true }) })],
      { [D1]: 'tok-1' }
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    openSendBack(D1);
    await vi.waitFor(() => expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull());
    expect(document.querySelector(`label[for="reject-note-${D1}"]`)!.textContent).toContain('required');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    press();
    expect(decideCalls(callTool)).toHaveLength(0);
    type(`reject-note-${D1}`, 'The pricing table is out of date.');
    expect(footer()!.hasAttribute('disabled')).toBe(false);
    press();
    await vi.waitFor(() =>
      expect(decideCalls(callTool)[0]![1]).toEqual({
        decision_id: D1,
        kind: 'decision',
        action: 'reject',
        reason: 'The pricing table is out of date.',
        approval_token: 'tok-1',
      })
    );
  });

  it('honours a multiple selection: min, max, and the options a send-back is about', async () => {
    const selection = {
      mode: 'multiple',
      options: [
        { id: 'eu', label: 'EU', description: null, implied_action: null, requires_reason: false },
        { id: 'us', label: 'US', description: null, implied_action: null, requires_reason: false },
        { id: 'apac', label: 'APAC', description: null, implied_action: null, requires_reason: false },
      ],
      min: 1,
      max: 2,
      required_for: ['approve', 'reject'],
    };
    const callTool = mount(
      [decision(D1, { widget_actions: contract({ labels: { approve: 'Confirm selection', reject: 'Request changes' }, selection }) })],
      { [D1]: 'tok-1' }
    );
    await vi.waitFor(() => expect(document.querySelectorAll('.dq-opt[aria-pressed]')).toHaveLength(3));
    expect(footer()!.getAttribute('heading')).toBe('Choose 1–2');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    option('eu')!.click();
    option('us')!.click();
    option('apac')!.click();
    expect(option('apac')!.getAttribute('aria-pressed')).toBe('false');
    expect(footer()!.getAttribute('heading')).toBe('2 chosen');
    expect(footer()!.getAttribute('primary-label')).toBe('Confirm selection');

    openSendBack(D1);
    await vi.waitFor(() => expect(option('eu', 'reject')).not.toBeNull());
    expect(option('eu', 'reject')!.getAttribute('aria-pressed')).toBe('true');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    type(`reject-note-${D1}`, 'US needs the data residency review first.');
    press();
    await vi.waitFor(() =>
      expect(decideCalls(callTool)[0]![1]).toEqual({
        decision_id: D1,
        kind: 'decision',
        action: 'reject',
        option_ids: ['eu', 'us'],
        reason: 'US needs the data residency review first.',
        approval_token: 'tok-1',
      })
    );
  });

  it('lets implied_action decide what an option click does, and asks why when an option requires it', async () => {
    const selection = {
      mode: 'single',
      options: [
        { id: 'ship', label: 'Ship tonight', description: null, implied_action: 'approve', requires_reason: false },
        { id: 'other', label: 'Something else', description: 'Say what', implied_action: null, requires_reason: true },
        { id: 'stop', label: 'Stop the launch', description: null, implied_action: 'reject', requires_reason: false },
      ],
      min: 1,
      max: 1,
      required_for: ['approve'],
    };
    const decide = vi.fn((args: Args) => ({ structuredContent: { decision_id: args.decision_id, action: 'approved' } }));
    mount(
      [decision(D1, { widget_actions: contract({ reject_requires_reason: false, selection }) }), decision(D2, { widget_actions: contract({ selection }) })],
      { [D1]: 'tok-1', [D2]: 'tok-2' },
      { decide }
    );
    await vi.waitFor(() => expect(option('stop')).not.toBeNull());
    expect(option('stop')!.querySelector('.dq-opt-tag')!.textContent).toBe('Send back');
    expect(option('other')!.querySelector('.dq-opt-tag')!.textContent).toBe('Asks why');

    // A reject-implied option sends back in one click when no note is required.
    option('stop')!.click();
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith({ decision_id: D1, kind: 'decision', action: 'reject', option_id: 'stop', approval_token: 'tok-1' })
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('done'));

    (window as unknown as { selectDecision(id: string): void }).selectDecision(D2);
    await vi.waitFor(() => expect(footer()?.getAttribute('data-decision-id')).toBe(D2));
    // An option that requires a reason is picked, and the card asks why before approving.
    option('other')!.click();
    await vi.waitFor(() => expect(document.getElementById(`approve-note-${D2}`)).not.toBeNull());
    expect(decide).toHaveBeenCalledTimes(1);
    expect(footer()!.getAttribute('heading')).toBe('You picked Something else');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
    type(`approve-note-${D2}`, 'Ship Thursday after the webinar.');
    press();
    await vi.waitFor(() =>
      expect(decide).toHaveBeenLastCalledWith({
        decision_id: D2,
        kind: 'decision',
        action: 'approve',
        option_id: 'other',
        reason: 'Ship Thursday after the webinar.',
        approval_token: 'tok-2',
      })
    );
  });

  it('opens the send-back note for a reject-implied option when a note is required', async () => {
    const selection = {
      mode: 'single',
      options: [
        { id: 'go', label: 'Go', description: null, implied_action: 'approve', requires_reason: false },
        { id: 'hold', label: 'Hold', description: null, implied_action: 'reject', requires_reason: false },
      ],
      min: 1,
      max: 1,
      required_for: ['approve'],
    };
    const callTool = mount([decision(D1, { widget_actions: contract({ selection }) })], { [D1]: 'tok-1' });
    await vi.waitFor(() => expect(option('hold')).not.toBeNull());
    option('hold')!.click();
    await vi.waitFor(() => expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull());
    expect(option('hold', 'reject')!.getAttribute('aria-pressed')).toBe('true');
    expect(decideCalls(callTool)).toHaveLength(0);
    type(`reject-note-${D1}`, 'Wait for legal.');
    press();
    await vi.waitFor(() =>
      expect(decideCalls(callTool)[0]![1]).toEqual({
        decision_id: D1,
        kind: 'decision',
        action: 'reject',
        option_id: 'hold',
        reason: 'Wait for legal.',
        approval_token: 'tok-1',
      })
    );
  });

  it('settles a gateway action with kind action and no decision status poll', async () => {
    const callTool = mount(
      [
        {
          id: A1,
          short_id: A1.replace(/-/g, '').slice(0, 8),
          type: 'action',
          agent_name: 'Mark',
          summary: 'send_email (gmail.send)',
          urgency: 'high',
          created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          context: { mission_id: 'm-1' },
          options: [],
          widget_actionable: true,
          widget_actions: contract({ kind: 'action', labels: { approve: 'Approve', reject: 'Deny' }, reject_requires_reason: false }),
        },
      ],
      { [A1]: 'tok-a' }
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(document.querySelector('.dq-q')!.textContent).toBe('send_email (gmail.send)');
    expect(document.querySelector('.dq-status')!.textContent).toContain('Action approval');
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Deny');
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('done'));
    expect(decideCalls(callTool)[0]![1]).toEqual({ decision_id: A1, kind: 'action', action: 'approve', approval_token: 'tok-a' });
    expect(callTool.mock.calls.some(([name]) => name === 'orgx_command_status')).toBe(false);
    expect(footer()!.getAttribute('detail')).toBe('the action can run');
  });

  it('sends kind approval for an agent-run approval, even without widget_actions', async () => {
    const callTool = mount(
      [decision(D1, { type: 'approval', agent_name: 'Agent', context: { run_id: D2 }, summary: 'Run the migration on staging?' })],
      { [D1]: 'tok-1' }
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(document.querySelector('.dq-status')!.textContent).toContain('Agent run approval');
    expect(document.querySelector('.dq-q a')!.getAttribute('href')).toBe(`https://useorgx.com/agents/runs/${D2}`);
    expect(document.body.textContent).not.toContain('Run id');
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('done'));
    expect(decideCalls(callTool)[0]![1]).toEqual({ decision_id: D1, kind: 'approval', action: 'approve', approval_token: 'tok-1' });
  });
});

describe('decisions widget: refusals', () => {
  it('says the view is out of date and refreshes it with fresh tokens', async () => {
    let decided = 0;
    const callTool = mount([decision(D1)], { [D1]: 'tok-old' }, {
      decide: (args) => {
        decided += 1;
        return decided === 1
          ? refusal('widget_approval_token_expired', 'This view is out of date. Refresh it to decide.')
          : { structuredContent: { decision_id: args.decision_id, action: 'approved' } };
      },
      refresh: () => ({
        structuredContent: { decisions: [decision(D1, { summary: 'Decision fresh?' })] },
        _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'tok-new' } } },
      }),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('stale'));
    expect(footer()!.getAttribute('variant')).toBe('reads');
    expect(footer()!.getAttribute('heading')).toBe('This view is out of date');
    expect(footer()!.getAttribute('detail')).toBe('Refresh to decide');
    expect(footer()!.getAttribute('action-label')).toBe('Refresh');

    pressAction();
    await vi.waitFor(() => expect(document.querySelector('.dq-q')!.textContent).toBe('Decision fresh?'));
    expect(callTool.mock.calls.filter(([name, args]) => name === 'orgx_decide' && args.action === 'list_pending')).toHaveLength(1);
    expect(footer()!.getAttribute('state')).toBe('needs-you');
    press();
    await vi.waitFor(() => expect(decideCalls(callTool)).toHaveLength(2));
    expect(decideCalls(callTool)[1]![1]).toMatchObject({ approval_token: 'tok-new' });
  });

  it('shows a decision settled elsewhere as settled and refreshes the queue', async () => {
    const callTool = mount([decision(D1), decision(D2)], { [D1]: 'tok-1', [D2]: 'tok-2' }, {
      decide: () => refusal('decision_already_resolved', 'This decision was already settled.', { status: 'approved' }),
      refresh: () => ({
        structuredContent: { decisions: [decision(D2)] },
        _meta: { 'orgx/widgetApproval': { approval_tokens: { [D2]: 'tok-2b' } } },
      }),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(callTool.mock.calls.some(([name, args]) => name === 'orgx_decide' && args.action === 'list_pending')).toBe(true));
    await vi.waitFor(() => expect(footer()?.getAttribute('data-decision-id')).toBe(D2));
    const history = document.querySelector('.dq-history ox-receipt-row') as HTMLElement;
    expect(history.getAttribute('label')).toBe(`Settled in OrgX · Decision ${D1.slice(0, 4)}?`);
    expect(history.getAttribute('value')).toBe('not by you');
  });

  it('shows the already-approved state on the card itself', async () => {
    mount([decision(D1)], { [D1]: 'tok-1' }, {
      decide: () => refusal('decision_already_resolved', 'This decision was already settled.', { status: 'approved' }),
      refresh: () => new Promise(() => undefined),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('Already approved in OrgX'));
    expect(footer()!.getAttribute('detail')).toBe('nothing of yours was applied');
    expect(document.querySelector('.dq-status')!.textContent).toContain('Settled in OrgX');
  });

  it('says what changed when someone else ruled first', async () => {
    mount([decision(D1)], { [D1]: 'tok-1' }, {
      decide: () => refusal('widget_decision_conflict', 'This view is out of date. Refresh it to decide.'),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('Changed since you opened it'));
    expect(footer()!.getAttribute('action-label')).toBe('Refresh');
  });

  it('says a missing item is no longer open here', async () => {
    mount([decision(D1)], { [D1]: 'tok-1' }, {
      decide: () => refusal('widget_decision_not_found', 'Decision not found or inaccessible.'),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('No longer open here'));
  });

  it('puts a validation refusal on the field and re-renders from the returned widget_actions', async () => {
    const current = contract({
      labels: { approve: 'Send answer', reject: 'Decline' },
      reject_requires_reason: false,
      answer: { required_for: ['approve'], max_length: 500 },
    });
    const callTool = mount([decision(D1, { widget_actions: contract() })], { [D1]: 'tok-1' }, {
      decide: () => refusal('answer_required', 'Type an answer to send.', { widget_actions: current }),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('primary-label')).toBe('Approve'));
    press();
    await vi.waitFor(() => expect(document.getElementById(`answer-${D1}`)).not.toBeNull());
    expect(fieldError()).toBe('Type an answer to send.');
    expect(document.getElementById(`answer-${D1}`)!.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(`answer-${D1}`)!.getAttribute('maxlength')).toBe('500');
    expect(footer()!.getAttribute('state')).toBe('needs-you');
    expect(footer()!.getAttribute('primary-label')).toBe('Send answer');
    expect(document.querySelector('[data-action="toggle-reject"]')!.textContent).toBe('Decline');
    type(`answer-${D1}`, 'staging-eu-2');
    expect(fieldError()).toBeNull();
    expect(decideCalls(callTool)).toHaveLength(1);
  });

  it('drops an option that is no longer available and says so under the options', async () => {
    const options = [
      { id: 'a', label: 'Option A', description: null, implied_action: null, requires_reason: false },
      { id: 'b', label: 'Option B', description: null, implied_action: null, requires_reason: false },
    ];
    const selection = (list: typeof options) => ({ mode: 'single', options: list, min: 1, max: 1, required_for: ['approve'] });
    mount([decision(D1, { widget_actions: contract({ selection: selection(options) }) })], { [D1]: 'tok-1' }, {
      decide: () =>
        refusal('option_unavailable', 'That option is no longer available.', {
          widget_actions: contract({ selection: selection([options[0]!, { ...options[1]!, id: 'c', label: 'Option C' }]) }),
        }),
    });
    await vi.waitFor(() => expect(option('b')).not.toBeNull());
    option('b')!.click();
    await vi.waitFor(() => expect(fieldError()).toBe('That option is no longer available.'));
    expect(option('b')).toBeNull();
    expect(option('c')).not.toBeNull();
    expect(document.querySelector('.dq-options .dq-field-error')).not.toBeNull();
    expect(footer()!.getAttribute('heading')).toBe('Choose one');
  });

  it('opens the note with the message when sending back needs a reason', async () => {
    mount([decision(D1, { widget_actions: contract({ reject_requires_reason: false }) })], { [D1]: 'tok-1' }, {
      decide: () =>
        refusal('reason_required', 'Say what should change when sending this back.', {
          widget_actions: contract({ reject_requires_reason: true }),
        }),
    });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    openSendBack(D1);
    await vi.waitFor(() => expect(footer()?.getAttribute('primary-label')).toBe('Send back'));
    press();
    await vi.waitFor(() => expect(fieldError()).toBe('Say what should change when sending this back.'));
    expect(document.getElementById(`reject-note-${D1}`)).not.toBeNull();
    expect(document.querySelector(`label[for="reject-note-${D1}"]`)!.textContent).toContain('required');
    expect(footer()!.hasAttribute('disabled')).toBe(true);
  });

  it('turns ineligible, disabled and authority refusals into Decide in OrgX with the reason', async () => {
    const cases: Array<[ReturnType<typeof refusal>, string]> = [
      [
        refusal('widget_approval_ineligible', 'This decision has to be made in OrgX.', { reason: 'credential_required' }),
        'It needs a credential, and credentials are entered only in OrgX.',
      ],
      [refusal('widget_approval_disabled', 'Deciding from chat is switched off for this workspace.'), 'Deciding from chat is off for this workspace.'],
      [refusal('action_authority_denied', 'This decision has to be made in OrgX.'), 'Your role can’t approve this from chat. OrgX shows who can.'],
      [refusal('widget_decision_lifecycle_required', 'This decision has to be made in OrgX.'), 'This one finishes in OrgX.'],
    ];
    for (const [result, copy] of cases) {
      mount([decision(D1)], { [D1]: 'tok-1' }, { decide: () => result });
      await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
      press();
      await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('Decide in OrgX'));
      expect(footer()!.getAttribute('detail')).toBe(copy);
      expect(footer()!.getAttribute('primary-label')).toBe('Decide in OrgX ↗');
    }
  });

  it('keeps Retry for a failure that is not a refusal', async () => {
    mount([decision(D1)], { [D1]: 'tok-1' }, { decide: () => Promise.reject(new Error('Network down')) });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    press();
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('failed'));
    expect(footer()!.getAttribute('primary-label')).toBe('Retry');
  });
});

describe('decisions widget: decide in OrgX reasons', () => {
  const reasons: Array<[string, string]> = [
    ['credential_required', 'It needs a credential, and credentials are entered only in OrgX.'],
    ['integration_connection_required', 'It settles when you connect the integration in OrgX.'],
    ['form_input_required', 'It asks for several answers. Fill them in OrgX.'],
    ['options_unavailable', 'Its options could not be read here. Choose in OrgX.'],
    ['artifact_reference_invalid', 'The artifact under review could not be opened here. Review it in OrgX.'],
    ['specialized_lifecycle', 'This type runs its own review in OrgX.'],
    ['requester_cannot_approve', 'You requested this action, so another approver decides it.'],
    ['widget_approvals_disabled', 'Deciding from chat is off for this workspace.'],
  ];
  it.each(reasons)('says why %s is decided in OrgX', async (reason, copy) => {
    mount([decision(D1, { widget_actionable: false, widget_actions: null, decide_in_orgx_reason: reason })], {});
    await vi.waitFor(() => expect(document.querySelector('.decide-in-orgx')).not.toBeNull());
    expect(document.querySelector('.decide-in-orgx .d')!.textContent).toBe(copy);
    expect(document.querySelector('.decide-in-orgx .t')!.textContent).toBe(
      reason === 'requester_cannot_approve' ? 'Open in OrgX' : 'Decide in OrgX'
    );
    expect(footer()).toBeNull();
  });
});

describe('decisions widget: approve the ready ones together', () => {
  const D3 = '3e0f4051-6273-4d8e-9fa0-1b2c3d4e5f60';
  const batchButton = () => document.querySelector('[data-action="approve-ready"]') as HTMLButtonElement | null;
  const rows = () =>
    Array.from(document.querySelectorAll('.dq-batch ox-receipt-row'), (row) => ({
      label: row.getAttribute('label'),
      status: row.getAttribute('status'),
      value: row.getAttribute('value'),
      detail: row.getAttribute('detail'),
    }));

  it('offers Approve N ready only for plain approvals, and only when there are two or more', async () => {
    mount(
      [
        decision(D1),
        decision(D2, { widget_actions: contract({ answer: { required_for: ['approve'], max_length: 2000 } }) }),
        decision(D3, { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ],
      { [D1]: 'tok-1', [D2]: 'tok-2', [D3]: 'tok-3' }
    );
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(batchButton()).toBeNull();

    mount([decision(D1), decision(D2), decision(D3, { decide_in_orgx_reason: 'credential_required' })], { [D1]: 'tok-1', [D2]: 'tok-2' });
    await vi.waitFor(() => expect(batchButton()?.textContent).toBe('Approve 2 ready'));
  });

  it('approves each ready item in turn with its own token and kind, and reports each result', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined;
    const decide = vi.fn((args: Args) => {
      if (args.decision_id === D1) return new Promise((resolve) => { releaseFirst = resolve; });
      if (args.decision_id === A1) return refusal('widget_decision_conflict', 'This view is out of date. Refresh it to decide.');
      return { structuredContent: { decision_id: args.decision_id, action: 'approved' } };
    });
    const callTool = mount(
      [
        decision(D1),
        { ...decision(A1, { type: 'action', summary: 'send_email (gmail.send)' }), widget_actions: contract({ kind: 'action', labels: { approve: 'Approve', reject: 'Deny' } }) },
        decision(D2, { type: 'approval', summary: 'Resume the import run?' }),
        decision(D3, { widget_actions: contract({ answer: { required_for: ['approve'], max_length: 2000 } }) }),
      ],
      { [D1]: 'tok-1', [A1]: 'tok-a', [D2]: 'tok-2', [D3]: 'tok-3' },
      { decide }
    );
    await vi.waitFor(() => expect(batchButton()?.textContent).toBe('Approve 3 ready'));
    batchButton()!.click();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    // One at a time: the second call waits for the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.dq-batch-copy')!.textContent).toBe('Approving 1 of 3');
    releaseFirst({ structuredContent: { decision_id: D1, action: 'approved' } });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(3));
    expect(decide.mock.calls.map(([args]) => args)).toEqual([
      { decision_id: D1, kind: 'decision', action: 'approve', approval_token: 'tok-1' },
      { decision_id: A1, kind: 'action', action: 'approve', approval_token: 'tok-a' },
      { decision_id: D2, kind: 'approval', action: 'approve', approval_token: 'tok-2' },
    ]);
    await vi.waitFor(() => expect(document.querySelector('.dq-batch-copy')!.textContent).toBe('2 approved · 1 changed since you opened it'));
    expect(rows()).toEqual([
      { label: `Decision ${D1.slice(0, 4)}?`, status: 'met', value: 'Approved', detail: 'Approved by you' },
      { label: 'send_email (gmail.send)', status: 'yours', value: 'Changed', detail: 'Changed since you opened it' },
      { label: 'Resume the import run?', status: 'met', value: 'Approved', detail: 'Approved by you' },
    ]);
    expect(document.querySelector('.dq-batch-copy')!.textContent).not.toMatch(/all/i);
    // The question that needs a typed answer stays for the person.
    expect(callTool.mock.calls.some(([, args]) => (args as Args).decision_id === D3)).toBe(false);
    expect(document.body.textContent).not.toMatch(/undo/i);
  });

  it('says which item was not sent and why', async () => {
    mount([decision(D1), decision(D2)], { [D1]: 'tok-1', [D2]: 'tok-2' }, {
      decide: (args) =>
        args.decision_id === D2
          ? refusal('widget_approval_ineligible', 'This decision has to be made in OrgX.', { reason: 'specialized_lifecycle' })
          : { structuredContent: { decision_id: args.decision_id, action: 'approved' } },
    });
    await vi.waitFor(() => expect(batchButton()).not.toBeNull());
    batchButton()!.click();
    await vi.waitFor(() => expect(document.querySelector('.dq-batch-copy')!.textContent).toBe('1 approved · 1 to decide in OrgX'));
    expect(rows()[1]).toMatchObject({ status: 'yours', value: 'In OrgX', detail: 'This type runs its own review in OrgX.' });
  });
});
