// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, mountWidget, readSharedScript } from './fixtures/live';

type ArtifactRow = Record<string, unknown>;
const scope = window as unknown as {
  OrgXPulseWidgetModel: { normalizePulse(value: unknown): { recent_artifacts: ArtifactRow[] } };
  togglePulsePanel(panel: string): void;
};
const current = {
  id: 'proof-current', title: 'Verified receipt', status: 'in_review',
  artifact_type: 'eng.test_report', version: 3,
  created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T16:20:00Z',
  primary_url: 'https://useorgx.com/artifacts/proof-current',
  task_url: 'https://useorgx.com/tasks/task-1',
  context: { initiative: { id: 'initiative-1', title: 'Living Work Memory' },
    workstream: { id: 'workstream-1', title: 'Engineering' },
    milestone: { id: 'milestone-1', title: 'Phase 1' },
    task: { id: 'task-1', title: 'Capture receipts' } },
  description: 'Full proof', content: { checks: ['scope'] },
  verification: { eval: { score: 0.93 } },
};
function pulse(overrides: Record<string, unknown> = {}) {
  return { initiative_id: 'initiative-1', name: 'Living Work Memory', status: 'active',
    continuity: { progress: { completed: 4, total: 36, pct: 11 } },
    recent_artifacts: [current], artifact_summary: { total: 39, in_review: 26, eval_passed: 13 },
    ...overrides };
}
async function render(payload: unknown) {
  mountWidget('initiative-pulse', { payload });
  await vi.advanceTimersByTimeAsync(400);
  const selector = '[data-panel-key="artifacts"]';
  const output = document.querySelector<HTMLButtonElement>(selector);
  expect(output).not.toBeNull();
  if (output!.getAttribute('aria-pressed') !== 'true') scope.togglePulsePanel('artifacts');
  expect(document.querySelector(selector)?.getAttribute('aria-pressed')).toBe('true');
  await vi.advanceTimersByTimeAsync(400);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T16:30:00Z'));
  FakeEventSource.reset();
  window.eval(readSharedScript('kit/ox-elements-core.js'));
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
  }
});
afterEach(() => vi.useRealTimers());

describe('initiative pulse current proof rendering', () => {
  it('renders full format, revision age, wrapping hierarchy breadcrumb, and the actual task link', async () => {
    await render(pulse());
    const row = document.querySelector('.pulse-artifact-row')!;
    expect(row.textContent).toContain('Engineering / Test Report');
    expect(row.textContent).toContain('v3');
    expect(row.textContent).toContain('Updated');
    expect(row.textContent).not.toContain('Created');
    expect(row.querySelector('.pulse-artifact-breadcrumb')?.textContent)
      .toBe('Engineering / Phase 1 / Capture receipts');
    expect(row.querySelector('.pulse-row-link')?.getAttribute('href')).toBe(current.primary_url);
    expect(row.querySelector('.pulse-artifact-task')?.getAttribute('href')).toBe(current.task_url);
    expect(document.querySelector('.pulse-quality')?.textContent).toContain('1 shown · 39 tracked in OrgX');
    expect(document.querySelector('.pulse-progress')?.textContent).toContain('4 of 36');
  });

  it('keeps the current revision when a stale priority card has the same artifact ID', async () => {
    const payload = pulse({ proof_cards: [{ ...current, title: 'Stale receipt', version: 1,
      updated_at: '2026-10-10T00:23:00Z', status: 'draft', description: 'Stale proof' }] });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts).toHaveLength(1);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts[0]).toMatchObject({
      title: current.title, version: 3, description: current.description,
      content: current.content, verification: current.verification, context: current.context,
    });
    expect(document.querySelector('.pulse-artifact-row')?.textContent).toContain('Verified receipt');
    expect(document.querySelector('.pulse-artifact-row')?.textContent).not.toContain('Stale receipt');
  });

  it.each([[4, current.updated_at], [3, '2026-10-10T16:25:00Z']])(
    'keeps omitted evidence unknown for version %s updated at %s in the actual widget', async (version, updatedAt) => {
    const compact = { id: current.id, title: 'Current revision', status: 'in_review', version,
      updated_at: updatedAt, primary_url: current.primary_url };
    const payload = pulse({ recent_artifacts: [compact], proof_cards: [{ ...current,
      metadata: { review_notes: ['Previous version review'] } }] });
    await render(payload);
    const row = scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts[0];
    expect(row).toMatchObject({ title: 'Current revision', version });
    expect(row).not.toHaveProperty('content');
    expect(row).not.toHaveProperty('verification');
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('metadata');
    expect(document.querySelector('.pulse-artifact-row')?.textContent).toContain('v' + version);
  });

  it('unions compact and rich widget projections when their exact update and version match', async () => {
    const payload = pulse({ recent_artifacts: [{ id: current.id, title: current.title,
      status: current.status, version: current.version, updated_at: current.updated_at,
      metadata: { format: 'markdown' } }], proof_cards: [{ ...current, metadata: { review_notes: ['Current revision review'] } }] });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts[0]).toMatchObject({
      content: current.content, verification: current.verification, description: current.description, context: current.context,
      metadata: { format: 'markdown', review_notes: ['Current revision review'] },
    });
  });

  it('renders the later same-version native update within one millisecond and leaves old evidence unknown', async () => {
    const newer = { id: current.id, title: 'Current receipt', status: current.status, version: 3,
      primary_url: current.primary_url, updated_at: '2026-10-10T16:20:00.000002Z' };
    const payload = pulse({ recent_artifacts: [{ ...current, title: 'Old receipt', updated_at: '2026-10-10T16:20:00.000001Z' }],
      proof_cards: [newer] });
    await render(payload);
    const row = scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts[0];
    expect(row).toMatchObject({ title: 'Current receipt', updated_at: newer.updated_at, version: 3 });
    expect(row).not.toHaveProperty('content');
    expect(row).not.toHaveProperty('verification');
    expect(document.querySelector('.pulse-artifact-row .pulse-list-title')?.textContent).toBe('Current receipt');
  });

  it('renders native timestamp fractions across statuses before using deterministic ID ties', async () => {
    const payload = pulse({ recent_artifacts: [
      { ...current, id: 'a-older-review', title: 'Older review', updated_at: '2026-10-10T16:20:00.000001Z' },
      { ...current, id: 'z-newer-accepted', title: 'Newer accepted', status: 'approved', updated_at: '2026-10-10T16:20:00.000002Z' },
    ] });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts.map((row) => row.id))
      .toEqual(['z-newer-accepted', 'a-older-review']);
    expect(Array.from(document.querySelectorAll('.pulse-artifact-row .pulse-list-title')).map((row) => row.textContent))
      .toEqual(['Newer accepted', 'Older review']);
  });

  it('treats equal instants with equivalent offsets and fraction padding as an ID tie', async () => {
    const payload = pulse({ recent_artifacts: [
      { ...current, id: 'z-equal', title: 'UTC proof', updated_at: '2026-10-10T16:20:00.000002Z' },
      { ...current, id: 'a-equal', title: 'Offset proof', updated_at: '2026-10-10T18:20:00.000002000+02:00' },
    ] });
    await render(payload);
    expect(scope.OrgXPulseWidgetModel.normalizePulse(payload).recent_artifacts.map((row) => row.id)).toEqual(['a-equal', 'z-equal']);
    expect(Array.from(document.querySelectorAll('.pulse-artifact-row .pulse-list-title')).map((row) => row.textContent))
      .toEqual(['Offset proof', 'UTC proof']);
  });

  it.each([
    ['eval_passed', 'Eval passed', 'needs_you', 'amber'],
    ['eval_failed', 'Eval failed', 'failed_step', 'red'],
    ['archived', 'Archived', 'view_only', 'mute'],
    ['superseded', 'Superseded', 'superseded', 'mute'],
  ])('renders the actual custom chip for %s without an acceptance claim', async (status, label, state, tone) => {
    await render(pulse({ recent_artifacts: [{ ...current, status }] }));
    const chip = document.querySelector('.pulse-artifact-row ox-state-chip') as HTMLElement;
    expect(chip.shadowRoot).not.toBeNull();
    expect(chip.getAttribute('aria-label')).toBe(label);
    expect(chip.dataset.state).toBe(state);
    expect(chip.dataset.tone).toBe(tone);
    expect(chip.shadowRoot?.querySelector('.l > span:not(.g)')?.textContent).toBe(label);
    expect(chip.getAttribute('aria-label')).not.toBe('Accepted');
  });

  it('shows the latest of 13 machine-verified proofs without presenting them as human accepted', async () => {
    await render(pulse({ recent_artifacts: Array.from({ length: 13 }, (_, i) => ({
      ...current, id: `evaluated-${i}`, title: `Machine proof ${i}`, status: 'eval_passed',
      updated_at: new Date(Date.UTC(2026, 9, 10, 16, 10, i)).toISOString(),
    })) }));
    expect(document.querySelectorAll('.pulse-artifact-row')).toHaveLength(6);
    expect(document.querySelector('.pulse-artifact-row .pulse-list-title')?.textContent).toBe('Machine proof 12');
    expect(document.querySelector('.pulse-quality')?.textContent).toContain('6 shown · 39 tracked in OrgX');
    expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
    for (const chip of document.querySelectorAll('.pulse-artifact-row ox-state-chip')) {
      expect(chip.getAttribute('aria-label')).toBe('Eval passed');
      expect(chip.shadowRoot?.querySelector('.l > span:not(.g)')?.textContent).toBe('Eval passed');
    }
  });

  it('shows the latest proof revisions across statuses, including newly accepted work', async () => {
    await render(pulse({ recent_artifacts: [
      { ...current, id: 'approved-new', title: 'Approved newest', status: 'approved', updated_at: '2026-10-10T16:25:00Z' },
      { ...current, id: 'review-old', title: 'Older review', updated_at: '2026-10-10T00:23:00Z' },
      current,
      { ...current, id: 'changes-old', title: 'Changes requested', status: 'changes_requested', updated_at: '2026-10-10T00:23:00Z' },
    ] }));
    expect(Array.from(document.querySelectorAll('.pulse-artifact-row .pulse-list-title')).map((row) => row.textContent))
      .toEqual(['Approved newest', 'Verified receipt', 'Changes requested', 'Older review']);
  });

  it('counts only displayed rows and labels bounded available counts', async () => {
    await render(pulse({ recent_artifacts: Array.from({ length: 8 }, (_, i) => ({ ...current, id: `proof-${i}` })),
      artifact_summary: { total: 8, in_review: 8, unit: 'available_artifact' } }));
    expect(document.querySelectorAll('.pulse-artifact-row')).toHaveLength(6);
    expect(document.querySelector('.pulse-quality')?.textContent).toContain('6 shown · 8 available');
    expect(document.querySelector('.pulse-quality')?.textContent).toContain('6 waiting for your review');
  });

  it('shows tracked proofs honestly when the display window is empty', async () => {
    await render(pulse({ recent_artifacts: [] }));
    expect(document.querySelector('.pulse-empty')?.textContent)
      .toBe('39 artifacts are tracked in OrgX. Open the live view to inspect them.');
    expect(document.body.textContent).not.toContain('Nothing has been delivered');
  });

  it('renders hierarchy titles as text', async () => {
    await render(pulse({ recent_artifacts: [{ ...current, context: { ...current.context,
      task: { id: 'task-1', title: '<img src=x onerror=alert(1)>' } } }] }));
    expect(document.querySelector('.pulse-artifact-breadcrumb')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('.pulse-artifact-breadcrumb img')).toBeNull();
  });
});
