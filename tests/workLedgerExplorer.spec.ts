// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Work Ledger explorer (canvas K2, M2 at phone width): every entry in the
 * window, worst first, read from the chronicle's own proofState. The card
 * asks the host for fullscreen; nothing here writes.
 */

const event = (
  id: string,
  kind: string,
  proofState: string,
  title: string,
  url: string | null,
  occurredAt: string
) => ({ id, kind, proofState, title, url, occurredAt, sourceLabel: 'Claude Code', status: 'recorded' });

const PAYLOAD = {
  chronicle: {
    workspaceName: 'Atina Labs',
    period: 'week',
    generatedAt: '2026-09-24T19:02:00Z',
    attentionState: 'needs_you',
    headline: 'Launch work moved.',
    metrics: { pendingDecisions: 1 },
    continuity: {
      clients: [],
      events: [
        event('pull-request:1', 'pull_request', 'verified', 'Proration PR', 'https://github.com/acme/checkout/pull/1', '2026-09-24T14:00:00Z'),
        event('decision:1', 'decision', 'needs_review', 'Ship annual pricing', '/decisions/6d0c2b1e-0f6b-4a8e-9b1c-2f5d7a9e3c11', '2026-09-24T16:00:00Z'),
        event('run:1', 'run', 'failed', 'Migration dry run', '/console/runs/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', '2026-09-23T15:00:00Z'),
        event('artifact:1', 'artifact', 'recorded', 'Pricing copy v3', 'javascript:alert(1)', '2026-09-23T12:00:00Z'),
        event('run:2', 'run', 'verified', 'Pricing build', '/console/runs/2b3c4d5e-6f70-4182-9a3b-4c5d6e7f8091', '2026-09-22T12:00:00Z'),
      ],
    },
  },
};

async function mount() {
  const { mountWidget } = await import('./fixtures/live');
  mountWidget('work-ledger', { payload: PAYLOAD });
  const requestDisplayMode = vi.fn().mockResolvedValue({ mode: 'fullscreen' });
  (window as unknown as { openai: Record<string, unknown> }).openai.requestDisplayMode = requestDisplayMode;
  await vi.waitFor(() => expect(document.querySelector('.wl-explore')).not.toBeNull());
  return { requestDisplayMode };
}

const click = (selector: string) => {
  const target = document.querySelector(selector) as HTMLElement | null;
  if (!target) throw new Error(`nothing matches ${selector}`);
  target.click();
};

const rowLabels = () =>
  Array.from(document.querySelectorAll('.kx-entry')).map((row) => row.getAttribute('label'));

describe('work ledger explorer', () => {
  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('states each entry by the proof the chronicle reports and links it through the host', async () => {
    await mount();
    const rows = Array.from(document.querySelectorAll('.wl-entry'));
    expect(rows.map((row) => row.getAttribute('status'))).toEqual(['met', 'yours', 'fail']);
    expect(rows[1]!.getAttribute('href')).toBe(
      'https://useorgx.com/decisions/6d0c2b1e-0f6b-4a8e-9b1c-2f5d7a9e3c11'
    );
    expect(document.querySelector('.wl-explore')!.textContent).toContain('Explore all 5 entries');
    expect(document.querySelector('.wl-explore')!.textContent).toContain('3 need attention');
  });

  it('opens fullscreen with every entry worst first and only the filters that have entries', async () => {
    const { requestDisplayMode } = await mount();
    click('.wl-explore');

    await vi.waitFor(() => expect(requestDisplayMode).toHaveBeenCalledWith({ mode: 'fullscreen' }));
    expect(document.querySelector('.wl')!.getAttribute('data-view')).toBe('explore');
    expect(document.querySelector('.kx-h')!.textContent).toBe(
      '2 of 5 verified. 1 failed, 1 waits on your review, 1 has no proof yet.'
    );
    const chips = Array.from(document.querySelectorAll('.kx-chip')).map((chip) => chip.getAttribute('data-filter'));
    expect(chips).toEqual(['open', 'fail', 'yours', 'unverified', 'met', 'all']);
    // Needs attention by default: the failed run first, verified entries folded.
    expect(rowLabels()).toEqual(['Migration dry run', 'Ship annual pricing', 'Pricing copy v3']);
    // A link off the declared origins (or not https) is never offered.
    const copy = Array.from(document.querySelectorAll('.kx-entry')).find((row) => row.getAttribute('label') === 'Pricing copy v3');
    expect(copy!.hasAttribute('href')).toBe(false);

    click('[data-fold="Runs"]');
    expect(rowLabels()).toEqual(['Migration dry run', 'Pricing build', 'Ship annual pricing', 'Pricing copy v3']);
  });

  it('filters by proof, focuses one kind, and returns to the summary inline', async () => {
    const { requestDisplayMode } = await mount();
    click('.wl-explore');

    click('[data-filter="met"]');
    expect(rowLabels()).toEqual(['Pricing build', 'Proration PR']);
    click('[data-kind="Runs"]');
    expect(rowLabels()).toEqual(['Pricing build']);
    expect(document.querySelector('[data-kind="Decisions"]')!.hasAttribute('data-dim')).toBe(true);
    click('[data-kind="Runs"]');
    expect(rowLabels()).toHaveLength(2);

    click('[data-explore="close"]');
    await vi.waitFor(() => expect(requestDisplayMode).toHaveBeenLastCalledWith({ mode: 'inline' }));
    expect(document.querySelector('.wl')!.getAttribute('data-view')).toBeNull();
    expect(document.querySelector('.wl-explore')).not.toBeNull();
  });

  it('drops zero-count filters and says when nothing needs attention', async () => {
    const { mountWidget } = await import('./fixtures/live');
    mountWidget('work-ledger', {
      payload: {
        chronicle: {
          ...PAYLOAD.chronicle,
          continuity: {
            clients: [],
            events: [0, 1, 2, 3].map((n) =>
              event(`pull-request:${n}`, 'pull_request', 'verified', `PR ${n}`, null, `2026-09-2${n}T10:00:00Z`)
            ),
          },
        },
      },
    });
    await vi.waitFor(() => expect(document.querySelector('.wl-explore')).not.toBeNull());
    click('.wl-explore');
    expect(document.querySelector('.kx-h')!.textContent).toBe('4 of 4 verified. Nothing needs attention.');
    expect(Array.from(document.querySelectorAll('.kx-chip')).map((chip) => chip.getAttribute('data-filter'))).toEqual(['met', 'all']);
    expect(rowLabels()).toEqual(['PR 3', 'PR 2', 'PR 1', 'PR 0']);
    // One kind: no category bar to focus.
    expect(document.querySelector('.kx-cats')).toBeNull();
  });

  it('keeps three or fewer entries on the card without an explorer', async () => {
    const { mountWidget } = await import('./fixtures/live');
    mountWidget('work-ledger', {
      payload: {
        chronicle: {
          ...PAYLOAD.chronicle,
          continuity: { clients: [], events: PAYLOAD.chronicle.continuity.events.slice(0, 3) },
        },
      },
    });
    await vi.waitFor(() => expect(document.querySelectorAll('.wl-entry')).toHaveLength(3));
    expect(document.querySelector('.wl-explore')).toBeNull();
  });
});
