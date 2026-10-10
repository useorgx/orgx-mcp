// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEventSource, mountWidget } from './fixtures/live';

type TaskProgress = {
  completed: number | null;
  total: number | null;
  pct: number | null;
  active?: number | null;
  blocked?: number | null;
};

type PulseModel = {
  normalizePulse(payload: unknown): {
    health_score: number | null;
    task_progress: TaskProgress | null;
  } | null;
};

type PulseWindow = Window & {
  OrgXPulseWidgetModel: PulseModel;
  OrgXWidgetRuntime: { openWidgetLink(url: string, event?: Event): boolean };
  openai: { openExternal?: (value: { url: string }) => void };
  togglePulsePanel(panel: string, trigger?: HTMLElement): void;
};

const scope = window as unknown as PulseWindow;

function pulse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'initiative-task-progress',
    name: 'Living Work Memory',
    status: 'active',
    progress_pct: 64,
    total_workstreams: 4,
    workstreams: [
      { id: 'ws-done', title: 'Repair receipts', status: 'completed', progress_pct: 100 },
      { id: 'ws-active', title: 'Capture work', status: 'active', progress_pct: 50 },
      { id: 'ws-blocked', title: 'Verify proof', status: 'blocked', progress_pct: 0 },
      { id: 'ws-planned', title: 'Ship memory', status: 'planned', progress_pct: 0 },
    ],
    ...overrides,
  };
}

async function render(payload: unknown): Promise<void> {
  mountWidget('initiative-pulse', { payload });
  await vi.advanceTimersByTimeAsync(400);
}

/** Ignore scripts and explicitly hidden subtrees when asserting reader copy. */
function visibleText(node: Node = document.body): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.hidden) return '';
  if (node instanceof HTMLScriptElement || node instanceof HTMLStyleElement) return '';
  return Array.from(node.childNodes).map((child) => visibleText(child)).join('');
}

function progressText(): string {
  const progress = document.querySelector('.pulse-progress');
  expect(progress).not.toBeNull();
  return visibleText(progress!).replace(/\s+/g, ' ').trim();
}

function expectPercent(pct: number): void {
  expect(document.querySelector('.pulse-progress-value')?.textContent?.match(/\b\d+%/g))
    .toEqual([`${pct}%`]);
  const fill = document.querySelector('.pulse-progress-bar > span') as HTMLElement;
  expect(fill.style.width).toBe(`${pct}%`);
  expect(document.querySelector('.pulse-progress-bar')?.getAttribute('aria-label')).toBeTruthy();
}

function railValue(panel: string): string | null {
  return document.querySelector(
    `.pulse-rail-button[data-panel-key="${panel}"] .pulse-rail-value`
  )?.textContent ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  const media = window as unknown as { matchMedia?: unknown };
  if (typeof media.matchMedia !== 'function') {
    media.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initiative pulse: literal task progress normalization', () => {
  it.each(['pulse', 'initiative', 'data', 'result'])(
    'retains literal task counts through the %s envelope',
    async (key) => {
      const record = pulse({
        continuity: { progress: { completed: 5, total: 34, pct: 76, active: 2, blocked: 1 } },
      });
      await render({ [key]: record });
      expect(scope.OrgXPulseWidgetModel.normalizePulse({ [key]: record })?.task_progress)
        .toMatchObject({ completed: 5, total: 34, active: 2, blocked: 1 });
      expect(progressText()).toContain('5 of 34 tasks done');
      expectPercent(15);
    }
  );

  it('recognizes a progress-only record as real evidence without inventing health', async () => {
    const payload = { continuity: { progress: { completed: 0, total: 34, pct: 0 } } };
    await render(payload);
    const normalized = scope.OrgXPulseWidgetModel.normalizePulse(payload);
    expect(normalized).not.toBeNull();
    expect(normalized?.health_score).toBeNull();
    expect(normalized?.task_progress).toMatchObject({ completed: 0, total: 34 });
    expect(progressText()).toContain('0 of 34 tasks done');
    expect(document.querySelector('.pulse-health')).toBeNull();
  });

  it('retains known zero activity independently of the completion tally', async () => {
    const payload = pulse({
      continuity: { progress: { completed: 0, total: 34, pct: 0, active: 0, blocked: 0 } },
    });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress)
      .toMatchObject({ completed: 0, total: 34, active: 0, blocked: 0 });
    expect(progressText()).toContain('0 tasks active');
    expect(progressText()).toContain('0 tasks blocked');
  });

  it('preserves literal task counts when an already normalized result is rendered again', async () => {
    const payload = pulse({
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: 2, blocked: 1 } },
    });
    await render(payload);
    const normalized = scope.OrgXPulseWidgetModel.normalizePulse(payload);
    await render(normalized);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(normalized)?.task_progress)
      .toMatchObject({ completed: 5, total: 34, active: 2, blocked: 1 });
    expect(progressText()).toContain('5 of 34 tasks done');
    expectPercent(15);
  });

  it('rejects a completion count above total without discarding other known counts', async () => {
    const payload = pulse({
      continuity: { progress: { completed: 35, total: 34, pct: 76, active: 2, blocked: 0 } },
    });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress)
      .toMatchObject({ completed: null, total: 34, active: 2, blocked: 0 });
    expect(progressText()).not.toMatch(/\d+ of \d+ tasks done/);
    expect(progressText()).toContain('2 tasks active');
    expect(progressText()).toContain('0 tasks blocked');
    expectPercent(64);
  });

  it('retains a valid tally while omitting individually invalid activity counts', async () => {
    const payload = pulse({
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: '2', blocked: -1 } },
    });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress)
      .toMatchObject({ completed: 5, total: 34, active: null, blocked: null });
    expect(progressText()).toContain('5 of 34 tasks done');
    expect(progressText()).not.toMatch(/\d+ tasks (?:active|blocked)/);
    expectPercent(15);
  });

  it.each([
    ['active', { active: 30, blocked: 2 }, { active: null, blocked: 2 }, '2 tasks blocked'],
    ['blocked', { active: 2, blocked: 30 }, { active: 2, blocked: null }, '2 tasks active'],
  ])('omits an impossible %s count while preserving other known activity', async (_, counts, expected, label) => {
    const payload = pulse({
      continuity: { progress: { completed: 5, total: 34, pct: 76, ...counts } },
    });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress)
      .toMatchObject({ completed: 5, total: 34, ...expected });
    expect(progressText()).toContain('5 of 34 tasks done');
    expect(progressText()).toContain(label);
    expect(progressText()).not.toContain('30 tasks');
    expectPercent(15);
  });

  it('omits contradictory activity counts whose sum exceeds remaining tasks', async () => {
    const payload = pulse({
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: 15, blocked: 15 } },
    });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress)
      .toMatchObject({ completed: 5, total: 34, active: null, blocked: null });
    expect(progressText()).toContain('5 of 34 tasks done');
    expect(progressText()).not.toMatch(/\d+ tasks (?:active|blocked)/);
    expectPercent(15);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['numeric string', '5'],
    ['boolean', true],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('does not turn a %s value into literal task counts', async (_, invalid) => {
    const payload = pulse({
      continuity: {
        progress: { completed: invalid, total: invalid, pct: 59, active: invalid, blocked: invalid },
      },
    });
    await render(payload);
    const normalized = scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress;
    expect(normalized?.completed ?? null).toBeNull();
    expect(normalized?.total ?? null).toBeNull();
    expect(normalized?.active ?? null).toBeNull();
    expect(normalized?.blocked ?? null).toBeNull();
    expect(progressText()).not.toMatch(/\d+ of \d+ tasks done/);
    expect(progressText()).not.toMatch(/\d+ tasks (?:active|blocked)/);
  });
});

describe('initiative pulse: task and workstream units stay separate', () => {
  it('shows a zero-completion ramp-up without converting weighted progress to done tasks', async () => {
    await render(pulse({
      progress_pct: 64,
      continuity: { progress: { completed: 0, total: 34, pct: 41, active: 7 } },
    }));
    expect(progressText()).toContain('0 of 34 tasks done');
    expect(progressText()).toContain('7 tasks active');
    expect(progressText()).not.toMatch(/\d+ tasks blocked/);
    expectPercent(0);
    expect(progressText()).not.toContain('64%');
    expect(progressText()).not.toContain('41%');
  });

  it('uses literal completion for the headline and bar and preserves workstream status facts', async () => {
    await render(pulse({
      progress_pct: 88,
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: 2, blocked: 1 } },
    }));
    const text = progressText();
    expect(text).toContain('5 of 34 tasks done');
    expect(text).toContain('2 tasks active');
    expect(text).toContain('1 task blocked');
    expect(text).toContain('4 workstreams');
    const taskFacts = document.querySelector('.pulse-task-facts');
    expect(taskFacts?.getAttribute('role')).toBe('group');
    expect(taskFacts?.getAttribute('aria-label')).toBe('Task status counts');
    expect(taskFacts?.textContent).not.toContain('workstream');
    const workstreamFacts = document.querySelector('.pulse-progress > .pulse-facts:not(.pulse-task-facts)');
    expect(Array.from(workstreamFacts!.querySelectorAll('span')).map((fact) => fact.textContent))
      .toEqual(['4 workstreams', '1 blocked', '1 active', '1 done', '1 not started']);
    const barLabel = document.querySelector('.pulse-progress-bar')?.getAttribute('aria-label');
    expect(barLabel).toContain('5 of 34 tasks done');
    expect(barLabel).toContain('1 task blocked');
    expect(barLabel).toContain('1 workstream blocked');
    expectPercent(15);
    expect(text).not.toContain('88%');
    expect(text).not.toContain('76%');
  });

  it('does not invent task counts for a legacy payload that only knows workstreams and percent', async () => {
    const payload = pulse();
    await render(payload);
    const normalized = scope.OrgXPulseWidgetModel.normalizePulse(payload)?.task_progress;
    expect(normalized?.completed ?? null).toBeNull();
    expect(normalized?.total ?? null).toBeNull();
    expect(progressText()).not.toMatch(/\d+ of \d+ tasks done/);
    expect(progressText()).not.toMatch(/\d+ tasks (?:active|blocked)/);
    expect(progressText()).toContain('4 workstreams');
    expectPercent(64);
  });

  it('calls 100% weighted progress progress when task completion is unknown', async () => {
    await render(pulse({
      progress_pct: 100,
      continuity: { progress: { completed: null, total: null, pct: 100 } },
    }));
    const headline = document.querySelector('.pulse-progress-value')?.textContent;
    expect(headline?.replace(/\s+/g, '')).toBe('100%progress');
    expect(headline).not.toMatch(/complete|through/i);
    const barLabel = document.querySelector('.pulse-progress-bar')?.getAttribute('aria-label');
    expect(barLabel).toContain('100% progress');
    expect(barLabel).not.toMatch(/complete|through/i);
    expect(progressText()).not.toMatch(/\d+ of \d+ tasks done/);
    expectPercent(100);
  });

  it.each([
    ['null counts', { completed: null, total: null, pct: 83 }],
    ['absent counts', { pct: 83 }],
    ['missing completed count', { total: 34, pct: 83 }],
    ['missing total count', { completed: 5, pct: 83 }],
  ])('keeps the legacy percent fallback with %s and no fabricated tally', async (_, progress) => {
    await render(pulse({ continuity: { progress } }));
    const text = progressText();
    expect(text).not.toMatch(/\d+ of \d+ tasks done/);
    expect(text).not.toMatch(/\d+ tasks (?:active|blocked)/);
    expect(text).toContain('4 workstreams');
    expectPercent(64);
  });

  it('renders known activity even when the completion tally is unknown', async () => {
    await render(pulse({
      continuity: { progress: { completed: null, total: null, pct: 83, active: 3, blocked: 0 } },
    }));
    expect(progressText()).not.toMatch(/\d+ of \d+ tasks done/);
    expect(progressText()).toContain('3 tasks active');
    expect(progressText()).toContain('0 tasks blocked');
    expectPercent(64);
  });

  it('does not replace unknown optional activity counts with zero', async () => {
    await render(pulse({ continuity: { progress: { completed: 5, total: 34, pct: 76 } } }));
    expect(progressText()).toContain('5 of 34 tasks done');
    expect(progressText()).not.toMatch(/\d+ tasks (?:active|blocked)/);
    expectPercent(15);
  });
});

describe('initiative pulse: task progress preserves review and host interactions', () => {
  it('renders the task tally once when the server message repeats the same facts', async () => {
    await render(pulse({
      message: '5 of 34 tasks done (15%); 2 active; 1 blocked.',
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: 2, blocked: 1 } },
    }));
    expect(visibleText().match(/5 of 34 tasks done/g)).toHaveLength(1);
    expect(progressText()).toContain('2 tasks active');
    expect(progressText()).toContain('1 task blocked');
    expectPercent(15);
  });

  it('keeps proof totals, review states, rail focus, and host links intact', async () => {
    await render(pulse({
      continuity: { progress: { completed: 5, total: 34, pct: 76, active: 2, blocked: 1 } },
      pending_decisions: 2,
      recent_artifacts: [
        { id: 'proof-review', title: 'Receipt integrity proof', status: 'in_review', primary_url: 'https://useorgx.com/artifacts/proof-review' },
        { id: 'proof-draft', title: 'Capture draft', status: 'draft' },
        { id: 'proof-accepted', title: 'Delivery proof', status: 'approved' },
      ],
      artifact_summary: { total: 7 },
    }));
    expect(railValue('actions')).toBe('3');
    expect(document.querySelector('ox-attention-line')?.getAttribute('count')).toBe('3');
    expect(railValue('artifacts')).toBe('7');

    const outputButton = document.querySelector(
      '.pulse-rail-button[data-panel-key="artifacts"]'
    ) as HTMLButtonElement;
    scope.togglePulsePanel('artifacts', outputButton);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.activeElement).toBe(outputButton);
    expect(outputButton.getAttribute('aria-expanded')).toBe('true');
    expect(outputButton.getAttribute('aria-pressed')).toBe('true');
    expect(visibleText()).toContain('1 waiting for your review');
    expect(visibleText()).toContain('1 not accepted');
    expect(document.querySelector('.pulse-artifact-row ox-state-chip[label="Draft"]')).not.toBeNull();
    expect(visibleText()).toContain('1 accepted');
    expect(visibleText()).toContain('3 shown · 7 tracked in OrgX');

    const openExternal = vi.fn();
    scope.openai.openExternal = openExternal;
    const reviewLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('.pulse-row-link'))
      .find((link) => link.textContent?.includes('Receipt integrity proof'));
    expect(reviewLink).toBeDefined();
    // The fixture mounts scripts with window.eval; jsdom's separately compiled
    // inline event attributes do not share that global scope. Exercise the real
    // host bridge with the rendered link target rather than replacing it with a
    // stubbed link handler.
    const event = new MouseEvent('click', { cancelable: true });
    expect(scope.OrgXWidgetRuntime.openWidgetLink(reviewLink!.href, event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith({ url: 'https://useorgx.com/artifacts/proof-review' });
    expect(progressText()).toContain('5 of 34 tasks done');
    expectPercent(15);
  });
});
