import { describe, expect, it } from 'vitest';

import { listAwaitingAcceptance, PANEL_AWAITING_LIMIT } from '../src/panelSurface';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('artifacts awaiting acceptance', () => {
  it('lists finished outputs a person can accept, newest first', () => {
    const list = listAwaitingAcceptance([
      { id: id(1), title: 'Launch post', status: 'in_review', updated_at: '2026-10-10T00:00:00Z' },
      { id: id(2), title: 'Pricing page', status: 'eval_passed', updated_at: '2026-10-12T00:00:00Z' },
      { id: id(3), title: 'Accepted', status: 'approved', updated_at: '2026-10-13T00:00:00Z' },
      { id: id(4), title: 'Old draft', status: 'in_review', superseded_by: id(1) },
      { id: 'not-a-uuid', title: 'Bad id', status: 'in_review' },
    ]);
    expect(list.map((a) => [a.title, a.status])).toEqual([
      ['Pricing page', 'eval_passed'],
      ['Launch post', 'in_review'],
    ]);
    expect(list[0].url).toContain(id(2));
  });

  it('caps the list and tolerates an unreadable artifact source', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: id(i + 10), title: `A${i}`, status: 'in_review' }));
    expect(listAwaitingAcceptance(many)).toHaveLength(PANEL_AWAITING_LIMIT);
    expect(listAwaitingAcceptance(null)).toEqual([]);
  });
});
