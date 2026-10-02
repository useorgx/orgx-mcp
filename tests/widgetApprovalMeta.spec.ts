import { describe, expect, it } from 'vitest';

import {
  WIDGET_APPROVAL_META_KEY,
  WIDGET_APPROVAL_SOURCE_TOOLS,
  splitWidgetApprovalMeta,
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
