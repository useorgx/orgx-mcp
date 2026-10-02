// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { directHumanDecisionReviewResult } from '../src/directHumanDecisionAction';
import { mountWidget } from './fixtures/live';

/**
 * A model's orgx_decide / approve_agent_work approve|reject returns
 * status "needs_human" (live-QA A4). The decisions template renders it, so the
 * card must send the person to OrgX with the review link, and must never read
 * as an empty queue ("All caught up").
 */
const DECISION = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

async function renderPayload(payload: unknown) {
  mountWidget('decisions', { payload });
  await vi.waitFor(() => expect(document.querySelector('[data-needs-human]')).not.toBeNull(), {
    timeout: 3000,
  });
  return document.querySelector('[data-needs-human]') as HTMLElement;
}

describe('decisions widget: needs_human result', () => {
  it.each(['approve', 'reject'] as const)(
    'renders "Decide in OrgX" with the review link for %s, never "All caught up"',
    async (action) => {
      const payload = directHumanDecisionReviewResult(DECISION, action);
      const card = await renderPayload(payload);

      expect(card.querySelector('.dq-calm-title')?.textContent).toBe('Decide in OrgX');
      const copy = card.querySelector('.dq-calm-copy')?.textContent ?? '';
      expect(copy).toContain(`Only a person can ${action} this decision`);
      expect(copy).toContain('Nothing was approved or rejected from this chat');
      expect(copy).not.toContain('https://');

      const link = card.querySelector('a[data-needs-human-link]') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(payload.review_url);
      expect(link.textContent).toContain(action === 'reject' ? 'Send back in OrgX' : 'Open the decision in OrgX');

      expect(document.body.textContent).not.toContain('All caught up');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
  );

  it('falls back to the decisions page and its own copy when the payload is thin', async () => {
    const card = await renderPayload({ status: 'needs_human', review_url: 'javascript:alert(1)' });
    const link = card.querySelector('a[data-needs-human-link]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    expect(card.querySelector('.dq-calm-copy')?.textContent).toContain('Only a person can approve');
  });
});
