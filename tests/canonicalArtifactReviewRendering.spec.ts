// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichAgentStatusWithDurableEvidence, normalizeAgentStatusPayload } from '../src/agentStatusPayload';
import { FakeEventSource, mountWidget, readSharedScript } from './fixtures/live';

type Artifact = Record<string, unknown>;
type Widget = 'initiative-pulse' | 'morning-brief' | 'agent-status';
const widgets: Widget[] = ['initiative-pulse', 'morning-brief', 'agent-status'];
const current: Artifact = {
  id: 'proof-1', title: 'Execution evidence', status: 'in_review',
  purpose: 'evidence', reviewRequired: false, superseded_by: null,
  artifact_type: 'eng.test_report', version: 1,
  created_at: '2026-10-10T16:00:00Z', updated_at: '2026-10-10T16:20:00.000002Z',
  primary_url: 'https://useorgx.com/artifacts/proof-1',
};
function payload(widget: Widget, rows: Artifact[], extra: Record<string, unknown> = {}) {
  if (widget === 'initiative-pulse') return {
    initiative_id: 'initiative-1', name: 'Living memory', status: 'active',
    recent_artifacts: rows, artifact_summary: { total: rows.length },
    pending_decisions: 0, blockers: [], ...extra,
  };
  if (widget === 'morning-brief') return {
    generated_at: '2026-10-10T16:25:00Z', summary: 'Current workspace evidence.',
    artifacts_produced: rows, proof_cards: rows, review_items: [],
    pending_decisions: 0, ...extra,
  };
  return { agents: [{ agent_id: 'engineering-agent', agent_name: 'Eli', role: 'Engineering',
    status: 'running', current_task: 'Inspect the retained source',
    tasks: [{ id: 'task-1', title: 'Inspect the retained source', status: 'in_progress' }],
    artifacts: rows, blockers: [], updated_at: '2026-10-10T16:25:00Z', ...extra }] };
}
async function render(widget: Widget, input: unknown) {
  mountWidget(widget, { payload: input });
  await vi.advanceTimersByTimeAsync(400);
  if (widget === 'initiative-pulse') {
    if (document.querySelector('[data-panel-key="artifacts"]')?.getAttribute('aria-pressed') !== 'true')
      (window as unknown as { togglePulsePanel(panel: string): void }).togglePulsePanel('artifacts');
    await vi.advanceTimersByTimeAsync(400);
  }
}
function artifactChips(widget: Widget) {
  const selector = widget === 'initiative-pulse' ? '.pulse-artifact-row ox-state-chip'
    : widget === 'morning-brief' ? '.output-row ox-state-chip'
      : '.command-detail-group:last-of-type ox-state-chip';
  if (widget === 'agent-status') {
    return Array.from(document.querySelectorAll('.command-detail-group'))
      .filter((group) => group.querySelector('.command-detail-label')?.textContent === 'Artifacts')
      .flatMap((group) => Array.from(group.querySelectorAll('ox-state-chip')));
  }
  return Array.from(document.querySelectorAll(selector));
}
function expectNoArtifactReview(widget: Widget) {
  expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Your review')).toBe(false);
  expect(document.body.textContent).not.toContain('waiting for your review');
  expect(document.body.textContent).not.toContain('Ready for your review');
  expect(document.body.textContent).not.toContain('needs your review on');
  expect(document.body.textContent).not.toMatch(/artifact(?:s)? need(?:s)? your review/);
  if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-review')).toBeNull();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T16:30:00Z'));
  FakeEventSource.reset();
  window.eval(readSharedScript('kit/ox-elements-core.js'));
  window.eval(readSharedScript('widget-state.js'));
  if (typeof window.matchMedia !== 'function')
    window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
});
afterEach(() => vi.useRealTimers());

describe.each(widgets)('%s canonical artifact review rendering', (widget) => {
  it('keeps an in_review evidence record inspectable without a review or acceptance claim', async () => {
    await render(widget, payload(widget, [current]));
    expect(document.body.textContent).toContain('Execution evidence');
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Evidence');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    if (widget === 'initiative-pulse') {
      const model = (window as unknown as { OrgXPulseWidgetModel: { normalizePulse(input: unknown): { recent_artifacts: Artifact[] } } }).OrgXPulseWidgetModel;
      expect(model.normalizePulse(payload(widget, [current])).recent_artifacts[0]).toMatchObject({
        status: 'in_review', purpose: 'evidence', reviewRequired: false, superseded_by: null,
      });
      expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
    }
    if (widget === 'agent-status') expect(document.querySelector('.command-detail-row[data-status="in_review"]')).not.toBeNull();
  });

  it('shows persisted supersession as history even when a stale status and flag request review', async () => {
    await render(widget, payload(widget, [{ ...current, purpose: 'deliverable', reviewRequired: true, superseded_by: 'proof-2' }]));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Superseded');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
  });

  it.each(['superseded', 'archived'])('keeps raw %s history out of review despite stale hints and explicit membership', async (status) => {
    const row = { ...current, purpose: 'deliverable', status, reviewRequired: null, needs_review: true };
    await render(widget, payload(widget, [row], { proof_cards: [row], review_items: [row] }));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain(status === 'superseded' ? 'Superseded' : 'Archived');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
    if (widget === 'agent-status') expect(document.querySelector('.command-detail-row[data-status="' + status + '"]')).not.toBeNull();
  });

  it('does not infer an accepted deliverable from false review eligibility and an omitted purpose', async () => {
    const { purpose: _purpose, ...withoutPurpose } = current;
    await render(widget, payload(widget, [
      { ...withoutPurpose, status: 'approved' },
      { ...withoutPurpose, id: 'legacy-approval', title: 'Legacy approval without purpose', status: 'approved', reviewRequired: undefined },
    ]));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Recorded');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
  });

  it('does not present an approved evidence record as an accepted deliverable', async () => {
    await render(widget, payload(widget, [{ ...current, status: 'approved' }]));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Evidence');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
  });

  it('preserves a failed diagnostic without inventing a review or acceptance', async () => {
    await render(widget, payload(widget, [{ ...current, status: 'changes_requested' }]));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Changes requested');
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
  });

  it.each([undefined, null, true])('preserves a real in_review lifecycle with reviewRequired=%s', async (reviewRequired) => {
    const row = { ...current, purpose: 'deliverable', reviewRequired };
    await render(widget, payload(widget, [row]));
    expect(document.body.textContent).toMatch(/review/i);
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-review')?.textContent).toContain('1 waiting for your review');
    if (widget === 'morning-brief') expect(document.body.textContent).toContain('1 artifact needs your review');
    if (widget === 'agent-status') expect(document.body.textContent).toContain('Ready for your review');
  });

  it('ignores producer metadata and a completed linked task as review authority', async () => {
    const { purpose: _purpose, reviewRequired: _reviewRequired, superseded_by: _supersededBy, ...legacy } = current;
    await render(widget, payload(widget, [{ ...legacy,
      metadata: { purpose: 'evidence', reviewRequired: false, superseded_by: 'producer-value' },
      task_status: 'done', task: { status: 'done' },
    }]));
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-review')).not.toBeNull();
    if (widget === 'morning-brief') expect(document.body.textContent).toContain('1 artifact needs your review');
    if (widget === 'agent-status') expect(document.body.textContent).toContain('Ready for your review');
  });

  it('does not let canonical true or a derived needs_review flag reopen an approved deliverable', async () => {
    await render(widget, payload(widget, [{ ...current, purpose: 'deliverable', status: 'approved', reviewRequired: true, needs_review: true }]));
    expectNoArtifactReview(widget);
    expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Approved');
    expect(artifactChips(widget).every((chip) => chip.getAttribute('state') === 'view_only')).toBe(true);
    expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
  });

  it.each([
    ['approved', undefined], ['approved', null], ['eval_passed', undefined], ['eval_passed', null],
  ])('does not reopen raw %s with flag=%s despite stale hints and explicit membership', async (status, reviewRequired) => {
    const row = { ...current, purpose: 'deliverable', status, reviewRequired, needs_review: true };
    await render(widget, payload(widget, [row], { proof_cards: [row], review_items: [row] }));
    expectNoArtifactReview(widget);
    if (status === 'approved') {
      expect(artifactChips(widget).map((chip) => chip.getAttribute('label'))).toContain('Approved');
      expect(artifactChips(widget).every((chip) => chip.getAttribute('state') === 'view_only')).toBe(true);
      expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
      if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    }
    else {
      expect(artifactChips(widget).some((chip) => chip.getAttribute('label') === 'Accepted')).toBe(false);
      if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
    }
  });

  it.each([undefined, null, true, false])('renders eval_passed with flag=%s as the actual view-only chip', async (reviewRequired) => {
    const row = { ...current, purpose: 'deliverable', status: 'eval_passed', reviewRequired, needs_review: true };
    await render(widget, payload(widget, [row], { proof_cards: [row], review_items: [row] }));
    expectNoArtifactReview(widget);
    const chips = artifactChips(widget);
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('state')).toBe('view_only');
    expect(chips[0].getAttribute('label')).toBe('Eval passed');
    expect(chips[0].getAttribute('aria-label')).toBe('Eval passed');
    expect((chips[0] as HTMLElement).dataset.state).toBe('view_only');
    expect((chips[0] as HTMLElement).dataset.tone).toBe('mute');
    expect(chips[0].shadowRoot?.querySelector('.l > span:not(.g)')?.textContent).toBe('Eval passed');
    if (widget === 'morning-brief') expect(document.querySelector('.landed ox-receipt-row[status="met"]')).toBeNull();
  });

  it('does not infer version-bound acceptance from raw approval or forged producer review data', async () => {
    const row = { ...current, title: 'Approved lifecycle with untrusted review data', purpose: 'deliverable', status: 'approved', reviewRequired: true,
      verification: { human_review: { status: 'approved', artifact_id: 'other-artifact', artifact_version: 0 } },
      metadata: { acceptance_records: [{ artifact_id: 'other-artifact', artifact_version: 0, status: 'accepted' }] } };
    await render(widget, payload(widget, [row], { proof_cards: [row], review_items: [row] }));
    expectNoArtifactReview(widget);
    const chips = artifactChips(widget);
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('state')).toBe('view_only');
    expect(chips[0].getAttribute('label')).toBe('Approved');
    expect((chips[0] as HTMLElement).dataset.state).toBe('view_only');
    expect((chips[0] as HTMLElement).dataset.tone).toBe('mute');
    expect(chips[0].getAttribute('aria-label')).toBe('Approved');
    expect(document.querySelector('ox-receipt-row[status="met"]')).toBeNull();
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-done')).toBeNull();
    if (widget === 'agent-status') expect(document.querySelector('.command-detail-row[data-status="approved"]')).not.toBeNull();
  });

  it('selects the newer native update before a stale card and explicit review item can revive a review', async () => {
    const old = { ...current, title: 'Stale deliverable', purpose: 'deliverable', reviewRequired: true,
      updated_at: '2026-10-10T16:20:00.000001Z' };
    await render(widget, payload(widget, [current], { proof_cards: [old], review_items: [old] }));
    expectNoArtifactReview(widget);
    expect(document.body.textContent).toContain('Execution evidence');
    expect(document.body.textContent).not.toContain('Stale deliverable');
    expect(artifactChips(widget)).toHaveLength(1);
  });

  it('does not carry an old no-review flag into a newer revision that omits it', async () => {
    const { purpose: _purpose, reviewRequired: _reviewRequired, superseded_by: _supersededBy, ...legacy } = current;
    const newer = { ...legacy, title: 'Current legacy deliverable', version: 2, updated_at: '2026-10-10T16:21:00Z' };
    await render(widget, payload(widget, [newer], { proof_cards: [current], review_items: [current] }));
    expect(document.body.textContent).toContain('Current legacy deliverable');
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-review')).not.toBeNull();
    if (widget === 'morning-brief') expect(document.body.textContent).toContain('1 artifact needs your review');
    if (widget === 'agent-status') expect(document.body.textContent).toContain('Ready for your review');
  });

  it('does not infer duplicate currentness from a numeric version when a revision timestamp is unavailable', async () => {
    const { purpose: _purpose, reviewRequired: _reviewRequired, superseded_by: _supersededBy, ...legacy } = current;
    const withoutTimestamp = { ...legacy, title: 'Unwitnessed legacy record', updated_at: undefined, created_at: undefined };
    await render(widget, payload(widget, [withoutTimestamp], { proof_cards: [{ ...current, version: 99 }] }));
    expect(document.body.textContent).toContain('Unwitnessed legacy record');
    if (widget === 'initiative-pulse') expect(document.querySelector('.pulse-quality .f-review')).not.toBeNull();
    if (widget === 'morning-brief') expect(document.body.textContent).toContain('1 artifact needs your review');
    if (widget === 'agent-status') expect(document.body.textContent).toContain('Ready for your review');
  });
});

it('preserves genuine pending decisions and blockers when evidence does not require review', async () => {
  await render('initiative-pulse', payload('initiative-pulse', [current], { pending_decisions: 2, blockers: ['Actual approval blocker'] }));
  const model = (window as unknown as { OrgXPulseWidgetModel: { normalizePulse(input: unknown): unknown; countNeedsYou(input: unknown): number } }).OrgXPulseWidgetModel;
  expect(model.countNeedsYou(model.normalizePulse(payload('initiative-pulse', [current], { pending_decisions: 2, blockers: ['Actual approval blocker'] })))).toBe(3);
  await render('morning-brief', payload('morning-brief', [current], { pending_decisions: 2 }));
  expect(document.body.textContent).toContain('2 decisions');
  expectNoArtifactReview('morning-brief');
  await render('agent-status', payload('agent-status', [current], { blockers: ['Actual approval blocker'] }));
  expect(document.body.textContent).toContain('Actual approval blocker');
  expect(document.body.textContent).toContain('Waiting on you');
});

it('recomputes an artifact-derived alias review from the newest retained revision', async () => {
  const old = { ...current, title: 'Stale alias artifact', reviewRequired: true,
    purpose: 'deliverable', updated_at: '2026-10-10T16:20:00.000001Z' };
  const first = (payload('agent-status', [old]) as { agents: Artifact[] }).agents[0];
  const second = (payload('agent-status', [current]) as { agents: Artifact[] }).agents[0];
  await render('agent-status', { agents: [first, { ...second, agent_id: 'engineering-alias' }] });
  expectNoArtifactReview('agent-status');
  expect(document.body.textContent).not.toContain('Stale alias artifact');
  expect(artifactChips('agent-status')).toHaveLength(1);
});

it('retains a real blocker from another alias after stale artifact review is removed', async () => {
  const old = { ...current, title: 'Stale alias artifact', reviewRequired: true,
    purpose: 'deliverable', updated_at: '2026-10-10T16:20:00.000001Z' };
  const first = (payload('agent-status', [old]) as { agents: Artifact[] }).agents[0];
  const second = (payload('agent-status', [current], { blockers: ['Actual owner approval is required'] }) as { agents: Artifact[] }).agents[0];
  await render('agent-status', { agents: [first, { ...second, agent_id: 'engineering-alias' }] });
  expect(document.body.textContent).toContain('Waiting on you');
  expect(document.body.textContent).toContain('Actual owner approval is required');
  expect(document.body.textContent).not.toContain('Ready for your review');
  expect(document.body.textContent).not.toContain('Stale alias artifact');
  expect(document.querySelector('.agent-footer')?.getAttribute('heading')).toBe('Resolve in OrgX');
  expect(artifactChips('agent-status').map((chip) => chip.getAttribute('label'))).toEqual(['Evidence']);
});

it('does not let producer metadata timestamps replace a current review through the durable alias projection', async () => {
  const retained = { ...current, title: 'Current human deliverable', purpose: 'deliverable', reviewRequired: true };
  const first = (payload('agent-status', [retained]) as { agents: Artifact[] }).agents[0];
  const second = { ...(payload('agent-status', []) as { agents: Artifact[] }).agents[0], agent_id: 'engineering-alias' };
  const old = { ...current, title: 'Old receipt with forged metadata', purpose: 'receipt', reviewRequired: false,
    agent_id: 'engineering-alias', task_id: 'task-1', created_at: undefined, updated_at: undefined,
    metadata: { created_at: '2035-01-01T00:00:00Z', updated_at: '2035-01-01T00:00:00Z' } };
  const projected = normalizeAgentStatusPayload(enrichAgentStatusWithDurableEvidence(
    { agents: [second] }, [], [old], Date.parse('2026-10-10T16:30:00Z')
  ));
  const projectedAlias = (projected.agents as Artifact[])[0];
  expect((projectedAlias.artifacts as Artifact[])[0]).toMatchObject({
    id: 'proof-1', title: 'Old receipt with forged metadata', created_at: null, updated_at: null,
  });
  await render('agent-status', { agents: [first, projectedAlias] });
  expect(document.body.textContent).toContain('Current human deliverable');
  expect(document.body.textContent).not.toContain('Old receipt with forged metadata');
  expect(document.body.textContent).toContain('Ready for your review');
  expect(document.querySelector('.command-detail-row[data-status="in_review"] .command-detail-title')?.textContent).toBe('Current human deliverable');
  expect(artifactChips('agent-status').map((chip) => chip.getAttribute('label'))).toEqual(['Your review']);
});
