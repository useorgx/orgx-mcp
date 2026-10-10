// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEventSource, mountWidget, readWidgetHtml } from './fixtures/live';

/**
 * Regressions from the live ChatGPT conformance pass (2026-10-02) for the
 * initiative pulse, agent status and scaffold cards, driven through the real
 * widget runtime the way the host delivers a tool result.
 */

const GRANT = {
  streamUrl: 'https://mcp.useorgx.com/live-feed/initiative-pulse/init-1/stream?t=tok',
  feedType: 'initiative-pulse',
  refreshTool: 'get_initiative_pulse',
  refreshArgs: { initiative_id: 'init-1' },
  expiresAt: Date.now() + 3_600_000,
};

function qaPulse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '8a7baebd-2da5-4584-9e32-5b081b830d84',
    name: 'PLUGIN QA — disposable conformance fixture',
    status: 'active',
    health_score: 0,
    progress_pct: 0,
    pending_decisions: 0,
    active_workstreams: 1,
    total_workstreams: 1,
    next_steps: [
      'Start the first ready workstream task; no agent run is active yet',
      'Review pending decisions with get_pending_decisions',
    ],
    blockers: [],
    workstreams: [
      { id: 'ws-1', title: 'Conformance checks', status: 'active', progress_pct: 0, agent_name: 'Eli', agent_domain: 'engineering' },
    ],
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function settle(ms = 400): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function pageText(): string {
  return document.body.textContent ?? '';
}

/** Text a reader can see: hidden subtrees are skipped. */
function visibleText(node: Node = document.body): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.hidden) return '';
  if (node instanceof HTMLScriptElement || node instanceof HTMLStyleElement) return '';
  return Array.from(node.childNodes).map((child) => visibleText(child)).join('');
}

function railValue(key: string): string | null {
  const button = document.querySelector(`.pulse-rail-button[data-panel-key="${key}"] .pulse-rail-value`);
  return button ? button.textContent : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  // jsdom has no CSS.escape; the agent board uses it to restore focus.
  const scope = window as unknown as { CSS?: { escape?: (value: string) => string } };
  if (!scope.CSS || !scope.CSS.escape) scope.CSS = { ...(scope.CSS || {}), escape: (value: string) => value };
  const media = window as unknown as { matchMedia?: unknown };
  if (typeof media.matchMedia !== 'function') {
    media.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initiative pulse: live updates degrade quietly (C1)', () => {
  it('prints nothing outside the card while the stream connects or fails', async () => {
    mountWidget('initiative-pulse', { payload: qaPulse({ live: GRANT }) });
    await settle();
    const mount = document.getElementById('liveFlow') as HTMLElement;
    expect(mount).not.toBeNull();
    expect(mount.hidden).toBe(true);
    expect(visibleText()).not.toContain('No workstreams running');
    expect(visibleText()).not.toContain('Connecting');

    // A host that blocks streaming: every attempt errors until the budget is spent.
    for (let i = 0; i < 12; i += 1) {
      FakeEventSource.latest.onerror?.();
      await settle(60_000);
    }
    expect(document.querySelector('#liveFlow .oxlp-conn')!.getAttribute('data-state')).toBe('fatal');
    expect(mount.hidden).toBe(true);
    expect(visibleText()).not.toContain('Disconnected');
    expect(visibleText()).not.toContain('Live updates unavailable');
    expect(visibleText()).not.toContain('Retry');
    expect(document.querySelector('.pulse-shell-card')).not.toBeNull();
  });
});

describe('initiative pulse: needs-you holds only what waits on a person (C2, C3)', () => {
  it('keeps next steps under Next and says nothing needs you', async () => {
    mountWidget('initiative-pulse', { payload: qaPulse() });
    await settle();
    expect(document.querySelector('.pulse-rail-button[data-panel-key="actions"]')).toBeNull();
    expect(railValue('focus')).toBe('2');
    expect(document.querySelector('ox-attention-line')!.getAttribute('count')).toBe('0');
    expect(pageText()).toContain('Nothing needs you');
    expect(document.querySelector('.pulse-attention')).toBeNull();
  });

  it('counts blockers, decisions and reviews the same in the header, rail and button', async () => {
    mountWidget('initiative-pulse', {
      payload: qaPulse({
        pending_decisions: 3,
        blockers: ['Waiting on pricing approval'],
        recent_artifacts: [
          { id: 'a1', name: 'Launch copy', status: 'in_review' },
          { id: 'a2', name: 'Draft notes', status: 'draft' },
        ],
      }),
    });
    await settle();
    // 1 blocker + 3 decisions + 1 review; the draft and the next steps do not count.
    expect(railValue('actions')).toBe('5');
    expect(document.querySelector('ox-attention-line')!.getAttribute('count')).toBe('5');
    expect(document.querySelector('.pulse-attention')!.textContent).toContain('Review 5');
    expect(pageText()).toContain('5 need you');
  });

  it('never shows a tool identifier in next-step copy', async () => {
    mountWidget('initiative-pulse', { payload: qaPulse() });
    await settle();
    (window as unknown as { togglePulsePanel(key: string): void }).togglePulsePanel('focus');
    await settle();
    expect(document.body.innerHTML).not.toContain('get_pending_decisions');
    expect(pageText()).toContain('Review pending decisions');
  });

  it('turns tool names into plain words', () => {
    mountWidget('initiative-pulse', { payload: qaPulse() });
    const plain = (window as unknown as { OrgXPulseWidgetModel: { plainCopy(v: string): string } })
      .OrgXPulseWidgetModel.plainCopy;
    expect(plain('Review pending decisions with get_pending_decisions')).toBe('Review pending decisions');
    expect(plain('Call get_initiative_pulse to refresh the view.')).toBe('Check initiative pulse to refresh the view.');
    expect(plain('Approve via orgx_decide (approve_decision).')).toBe('Approve.');
    expect(plain('Use `get_agent_status()` to watch progress')).toBe('Check agent status to watch progress');
    expect(plain('Start the first ready workstream task')).toBe('Start the first ready workstream task');
  });
});

describe('initiative pulse: health and progress read honestly (C4)', () => {
  it('renders health as one chip and 0% progress as an empty bar with its words', async () => {
    mountWidget('initiative-pulse', { payload: qaPulse() });
    await settle();
    const health = document.querySelector('.pulse-health') as HTMLElement;
    expect(health).not.toBeNull();
    expect(health.getAttribute('data-tone')).toBe('danger');
    expect(health.textContent).toBe('Health 0');
    const fill = document.querySelector('.pulse-progress-bar > span') as HTMLElement;
    expect(fill.getAttribute('style')).toContain('width:0%');
    expect(document.querySelector('.pulse-progress-value')!.textContent).toBe('0%progress');
    // One workstream reads as one, never "1 workstreams".
    const facts = document.querySelector('.pulse-facts')!.textContent!;
    expect(facts).toContain('1 workstream');
    expect(facts).not.toContain('1 workstreams');
    const source = readWidgetHtml('initiative-pulse');
    expect(source).toMatch(/\.pulse-health\[data-tone="good"\]/);
  });

  it('says what the decision count covers when the app sends its scope', async () => {
    mountWidget('initiative-pulse', {
      payload: qaPulse({ pending_decisions: 3, pending_decisions_scope: { level: 'initiative', total: 3, capped: false, kinds: ['decision'], urgency: 'all', includes_system: false, unit: 'review_packet', workspace_id: null, initiative_id: 'init-1' } }),
    });
    await settle();
    (window as unknown as { togglePulsePanel(key: string): void }).togglePulsePanel('actions');
    await settle();
    expect(pageText()).toContain('3 decisions waiting on you');
    expect(pageText()).toContain('Pending in this initiative');
  });

  it('says a fallback decision_record count approximately, without the capped "+"', async () => {
    mountWidget('initiative-pulse', {
      payload: qaPulse({ pending_decisions: 4, pending_decisions_scope: { level: 'initiative', total: 4, capped: true, kinds: ['decision'], urgency: 'all', includes_system: true, unit: 'decision_record', workspace_id: null, initiative_id: 'init-1' } }),
    });
    await settle();
    (window as unknown as { togglePulsePanel(key: string): void }).togglePulsePanel('actions');
    await settle();
    expect(pageText()).toContain('About 4 decisions waiting on you');
    expect(pageText()).toContain('Count may include duplicates');
    expect(pageText()).toContain('About 4 need you');
    expect(pageText()).not.toContain('4+');
    const model = (window as unknown as { OrgXPulseWidgetModel: { decisionCountIsExact(p: unknown): boolean } }).OrgXPulseWidgetModel;
    expect(model.decisionCountIsExact({ pending_decisions_scope: { unit: 'review_packet' } })).toBe(true);
    expect(model.decisionCountIsExact({ pending_decisions_scope: null })).toBe(true);
    expect(model.decisionCountIsExact({ pending_decisions_scope: { unit: 'decision_record' } })).toBe(false);
  });

  it('gives every known stream owner a hover card outside the row link', async () => {
    mountWidget('initiative-pulse', { payload: qaPulse() });
    await settle();
    const row = document.querySelector('.pulse-list-row')!;
    const card = row.querySelector('ox-agent-card')!;
    expect(card.getAttribute('agent')).toBe('eli');
    expect(card.closest('a')).toBeNull();
    expect(row.querySelector('a.pulse-row-link')).not.toBeNull();
  });
});

describe('agent status: kit chips and honest counts (C9)', () => {
  const payload = {
    agents: [
      {
        agent_name: 'Eli', role: 'Engineering', status: 'stalled', stalled_minutes: 6360,
        run_id: '0f6c2a1e-5b7d-4c3e-9a8b-2d1e0f9c8b7a', current_task: 'Run the conformance checks',
        tasks: [
          { id: 't1', title: 'Run the conformance checks', status: 'in_progress' },
          { id: 't2', title: 'Write the run receipt', status: 'queued' },
        ],
      },
      {
        agent_name: 'Pace', role: 'Product', status: 'running', current_task: 'Draft the launch brief',
        last_heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        tasks: [{ id: 't3', title: 'Draft the launch brief', status: 'in_progress' }],
      },
      {
        agent_name: 'Mark', role: 'Marketing', status: 'queued', current_task: 'Prepare the announcement',
        tasks: [{ id: 't4', title: 'Prepare the announcement', status: 'queued' }],
      },
    ],
  };

  it('counts only running agents as working', async () => {
    mountWidget('agent-status', { payload });
    await settle(800);
    const line = document.querySelector('ox-attention-line')!.textContent!;
    expect(line).toContain('1 agent needs you · 1 working · 1 queued');
  });

  it('shows the agent stall on its running task, as kit chips', async () => {
    mountWidget('agent-status', { payload });
    await settle(800);
    (document.querySelector('[data-action="toggle-details"]') as HTMLButtonElement).click();
    await settle(800);
    const rows = Array.from(document.querySelectorAll('.command-detail-row')) as HTMLElement[];
    const byTitle = (title: string) =>
      rows.find((row) => row.querySelector('.command-detail-title')!.textContent === title)!;
    const running = byTitle('Run the conformance checks').querySelector('ox-state-chip')!;
    expect(running.getAttribute('state')).toBe('stale');
    expect(running.getAttribute('label')).toBe('Stalled');
    const queued = byTitle('Write the run receipt').querySelector('ox-state-chip')!;
    expect(queued.getAttribute('state')).toBe('queued');
    expect(document.querySelector('.command-details')!.textContent).not.toContain('Running');
  });
});

describe('scaffolded initiative: one workstream can launch (C10)', () => {
  it('does not hold a single-workstream plan back', async () => {
    const scaffold = {
      initiative: { id: 'INI-QA', title: 'PLUGIN QA', status: 'scaffolded' },
      hierarchy: {
        initiative: { id: 'INI-QA', title: 'PLUGIN QA', status: 'scaffolded' },
        workstreams: [
          { id: 'WS-1', title: 'Conformance checks', milestones: [{ id: 'MS-1', title: 'Checks pass', tasks: [{ id: 'T-1', title: 'Run the checks' }] }] },
        ],
      },
      streams: { items: [{ workstream_id: 'WS-1', status: 'ready', agent_domain: 'engineering', progress_pct: 0 }] },
    };
    mountWidget('scaffolded-initiative', { payload: scaffold });
    await settle(800);
    expect(pageText()).not.toContain('needs at least 2');
    expect(document.querySelector('.gaps')).toBeNull();
    const footer = document.querySelector('ox-footer')!;
    expect(footer.getAttribute('heading')).toBe('Ready to launch');
    expect(footer.getAttribute('primary-label')).toBe('Hold to launch');
  });
});
