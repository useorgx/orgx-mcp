// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The proof-receipt widget (canvas Q5): the orgx_submit_receipt result as
 * the proof, the gap and the next move. Read-only; its only actions open
 * evidence and the anchored work through the host.
 */

const TASK_ID = '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99';

const payload = (overrides: Record<string, unknown> = {}, proof: Record<string, unknown> = {}) => ({
  _v2_tool: 'orgx_submit_receipt',
  path: 'v1',
  ok: true,
  receipt_id: '3f9c1d2e-8a7b-4c6d-9e0f-1a2b3c4d5e6f',
  idempotent: false,
  imported_at: '2026-10-02T14:00:00Z',
  summary: 'Merged PR 2291.',
  verification_status: 'passed',
  proof: {
    receipt_type: 'proof',
    status: 'completed',
    anchor: { entity_type: 'task', entity_id: TASK_ID, artifact_id: null },
    artifact_type: 'pull_request',
    agent_type: 'engineering',
    business_outcome: 'Checkout completes in under a second.',
    model_tier: 'standard',
    evidence: [
      { kind: 'pr', label: 'PR 2291 · acme/checkout', url: 'https://github.com/acme/checkout/pull/2291', value: null },
      { kind: 'deploy', label: 'Deploy · preview', url: 'https://checkout-git-2291.vercel.app/', value: null },
      { kind: 'metric', label: 'p95 latency', url: null, value: '812 ms' },
    ],
    evidence_total: 3,
    ...proof,
  },
  loop_validation: { rung: null, applies: false, promotable: true, missing: [], warnings: [], next_required_action: null },
  ...overrides,
});

async function mount(data: unknown) {
  const { mountWidget } = await import('./fixtures/live');
  mountWidget('proof-receipt', { payload: data });
  const openExternal = vi.fn();
  (window as unknown as { openai: Record<string, unknown> }).openai.openExternal = openExternal;
  await vi.waitFor(() => expect(document.querySelector('.rc[aria-label="OrgX receipt"], .rc .empty')).not.toBeNull());
  return { openExternal };
}

const text = (selector: string) => document.querySelector(selector)?.textContent ?? '';
const rail = () =>
  Array.from(document.querySelectorAll('.rail li')).map((step) => step.getAttribute('data-tone') ?? '');

describe('proof receipt widget', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('reads a verified, promotable receipt as proof and opens only allowed evidence', async () => {
    await mount(payload());
    expect(text('.pk-q')).toBe('Verified, with 3 pieces of evidence.');
    expect(rail()).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(document.querySelector('.rc')!.getAttribute('data-edge')).toBe('teal');
    const rows = Array.from(document.querySelectorAll('.sec ox-receipt-row'));
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      'https://github.com/acme/checkout/pull/2291',
      null,
      null,
    ]);
    // A host the sandbox cannot open stays visible as text.
    expect(rows[1]!.getAttribute('detail')).toBe('checkout-git-2291.vercel.app');
    expect(rows[2]!.getAttribute('value')).toBe('812 ms');
    expect(text('.next')).toContain('Checkout completes in under a second.');
    expect(document.body.textContent).not.toContain('Next:');
  });

  it('names the gap and the next move instead of the missing field ids', async () => {
    await mount(
      payload(
        {
          loop_validation: {
            rung: null,
            applies: false,
            promotable: false,
            missing: ['business_outcome', 'artifact_type'],
            warnings: ['evidence should include a verifiable URL or artifact_id'],
            next_required_action: 'Add missing loop receipt fields: business_outcome, artifact_type.',
          },
        },
        { business_outcome: null, artifact_type: null }
      )
    );
    expect(text('.pk-q')).toBe('Verified, with 3 gaps before it counts as proof.');
    expect(rail()).toEqual(['ok', 'ok', 'ok', '']);
    const gaps = Array.from(document.querySelectorAll('.sec'))[1]!.querySelectorAll('ox-receipt-row');
    expect(Array.from(gaps).map((row) => row.getAttribute('label'))).toEqual([
      'No business outcome is stated',
      'The artifact type is not stated',
      'No evidence links to something you can check',
    ]);
    expect(document.body.textContent).toContain(
      'Next: The agent submits a receipt with the business outcome and the artifact type.'
    );
    expect(document.body.textContent).not.toContain('business_outcome');
  });

  it('says a failed verification and a failed run plainly', async () => {
    await mount(payload({ verification_status: 'failed', loop_validation: { rung: null, applies: false, promotable: false, missing: [], warnings: [], next_required_action: 'Submit a passed verification receipt before promotion.' } }));
    expect(text('.pk-q')).toBe('Proof recorded. Verification failed.');
    expect(rail()[2]).toBe('fail');
    expect(document.querySelector('ox-receipt-row[status="fail"]')!.getAttribute('label')).toBe('Verification failed');
    expect(document.body.textContent).toContain('Next: The agent fixes what failed and submits a passing verification.');

    document.documentElement.innerHTML = '<head></head><body></body>';
    await mount(payload({ verification_status: 'not_run' }, { status: 'failed', evidence: [], evidence_total: 0 }));
    expect(text('.pk-q')).toBe('Recorded as failed. It does not claim the work shipped.');
    expect(document.querySelector('.rc')!.getAttribute('data-edge')).toBe('red');
    expect(document.body.textContent).not.toContain('Next:');
  });

  it('opens the anchored work and other evidence through the host', async () => {
    const { openExternal } = await mount(payload());
    const footer = document.querySelector('ox-footer')!;
    expect(footer.getAttribute('detail')).toBe('hash-chained · receipt 3f9c1d2e');
    footer.dispatchEvent(new CustomEvent('ox-action', { bubbles: true, composed: true }));
    expect(openExternal).toHaveBeenCalledWith({
      url: `https://useorgx.com/live?view=mission-control&task=${TASK_ID}`,
    });
    const pr = document.querySelector('ox-receipt-row[href]')!;
    pr.dispatchEvent(new CustomEvent('ox-open', { bubbles: true, composed: true, cancelable: true, detail: { href: pr.getAttribute('href') } }));
    expect(openExternal).toHaveBeenLastCalledWith({ url: 'https://github.com/acme/checkout/pull/2291' });
  });

  it('keeps four evidence rows inline and opens the rest in place', async () => {
    const evidence = Array.from({ length: 12 }, (_, i) => ({
      kind: 'pr',
      label: `PR ${i}`,
      url: `https://github.com/acme/app/pull/${i}`,
      value: null,
    }));
    await mount(payload({}, { evidence, evidence_total: 19 }));
    expect(text('.pk-q')).toBe('Verified, with 19 pieces of evidence.');
    expect(document.querySelectorAll('.sec ox-receipt-row')).toHaveLength(4);
    (document.querySelector('[data-evidence]') as HTMLElement).click();
    expect(document.querySelectorAll('.sec ox-receipt-row')).toHaveLength(12);
    expect(text('.more')).toBe('+7 more pieces of evidence in OrgX');
  });

  it('claims nothing when no receipt came back', async () => {
    await mount({ ok: true });
    expect(text('.empty b')).toBe('No receipt recorded');
  });
});
