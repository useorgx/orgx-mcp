import { describe, expect, it } from 'vitest';

import {
  WIDGET_APPROVAL_META_KEY,
  WIDGET_APPROVAL_SOURCE_TOOLS,
  splitWidgetApprovalMeta,
  widgetDecideFailure,
} from '../src/widgetApprovalMeta';

describe('widget approval metadata', () => {
  it('lifts approval tokens out of the model-visible payload', () => {
    const payload = {
      decisions: [{ id: 'dec-1', widget_actionable: true }],
      _widget_meta: { approval_tokens: { 'dec-1': 'tok' }, token_ttl_seconds: 900 },
    };
    const { data, meta } = splitWidgetApprovalMeta(payload);
    expect(data).toEqual({ decisions: [{ id: 'dec-1', widget_actionable: true }] });
    expect(JSON.stringify(data)).not.toContain('tok');
    expect(meta).toEqual({ approval_tokens: { 'dec-1': 'tok' }, token_ttl_seconds: 900 });
  });

  it('drops a malformed _widget_meta instead of passing it through', () => {
    const { data, meta } = splitWidgetApprovalMeta({ ok: 1, _widget_meta: 'tok' });
    expect(data).toEqual({ ok: 1 });
    expect(meta).toBeNull();
  });

  it('leaves payloads without widget metadata untouched', () => {
    const payload = { decisions: [] };
    expect(splitWidgetApprovalMeta(payload)).toEqual({ data: payload, meta: null });
  });

  it('only asks the app for tokens on the pending-decisions widget tool', () => {
    expect([...WIDGET_APPROVAL_SOURCE_TOOLS]).toEqual(['get_pending_decisions']);
    expect(WIDGET_APPROVAL_META_KEY).toBe('orgx/widgetApproval');
  });
});

describe('widget decide refusals', () => {
  const actions = {
    kind: 'decision',
    actions: ['approve', 'reject'],
    labels: { approve: 'Send answer', reject: 'Decline' },
    reject_requires_reason: false,
    answer: { required_for: ['approve'], max_length: 2000 },
    selection: null,
  };

  it('keeps the app code and the details the widget re-renders from', () => {
    expect(widgetDecideFailure('Type an answer to send.', { code: 'answer_required', widget_actions: actions })).toEqual({
      code: 'answer_required',
      details: { widget_actions: actions },
    });
    expect(
      widgetDecideFailure('This decision has to be made in OrgX.', { code: 'widget_approval_ineligible', reason: 'credential_required' })
    ).toEqual({ code: 'widget_approval_ineligible', details: { reason: 'credential_required' } });
    expect(widgetDecideFailure('This decision was already settled.', { code: 'decision_already_resolved', status: 'approved' })).toEqual({
      code: 'decision_already_resolved',
      details: { status: 'approved' },
    });
  });

  it('reads the code from the app message when the app sends no data', () => {
    const cases: Array<[string, string]> = [
      ['This view is out of date. Refresh it to decide.', 'widget_view_out_of_date'],
      ['This decision was already settled.', 'decision_already_resolved'],
      ['Deciding from chat is switched off for this workspace.', 'widget_approval_disabled'],
      ['This decision has to be made in OrgX.', 'widget_decision_lifecycle_required'],
      ['Decision not found or inaccessible.', 'widget_decision_not_found'],
      ['Type an answer to send.', 'answer_required'],
      ['This decision does not take an answer.', 'answer_not_accepted'],
      ['Choose an option first.', 'option_required'],
      ['Choose one option (option_id).', 'options_not_accepted'],
      ['That option is no longer available.', 'option_unavailable'],
      ['"Wait" can only be chosen to reject.', 'option_action_mismatch'],
      ['Choose between 1 and 2 options.', 'selection_out_of_range'],
      ['Say what should change when sending this back.', 'reason_required'],
      ['Say why you chose "Other".', 'reason_required'],
      ['OrgX is unavailable. Try again shortly.', 'tool_execution_failed'],
    ];
    for (const [message, code] of cases) expect(widgetDecideFailure(message, undefined)).toEqual({ code });
  });
});
