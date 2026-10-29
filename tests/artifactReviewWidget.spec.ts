// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const widgetPath = join(
  process.cwd(),
  'public',
  'widgets',
  'artifact-review.html'
);
const widgetHtml = readFileSync(widgetPath, 'utf8');
const widgetDocument = new JSDOM(widgetHtml).window.document;
const scriptSource =
  Array.from(widgetDocument.querySelectorAll('script')).find((script) =>
    script.textContent?.includes('installArtifactVerificationWidget')
  )?.textContent ?? '';

type ReviewModel = {
  artifact: Record<string, unknown>;
  contract: Record<string, unknown>;
};

type ArtifactReviewWidgetModel = {
  normalizeReviewResponse(value: unknown): ReviewModel;
  choosePrimaryAction(model: ReviewModel): {
    kind: 'none' | 'open' | 'approved' | 'changes_requested';
    label: string;
    href: string;
  };
  scoreText(quality: Record<string, unknown>): {
    value: string;
    detail: string;
  };
  renderQualityGauge(
    quality: Record<string, unknown>,
    reviewRequired: boolean
  ): string;
  buildQualityAnatomy(model: ReviewModel): {
    inputCount: number;
    judgedCount: number;
    measuredCount: number;
    observedCount: number;
    evidenceIsCurrent: boolean;
    qualityState: string;
    stages: Array<{
      lens: string;
      label: string;
      value: string;
      detail: string;
    }>;
  };
  renderQualityAnatomy(model: ReviewModel): string;
};

function createWidget(state = 'ready') {
  const dom = new JSDOM(widgetHtml, {
    url: `https://example.test/widgets/artifact-review.html?demo=true&state=${state}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => 'standalone',
      reportSize: () => undefined,
      callTool: vi.fn().mockResolvedValue({}),
      openWidgetLink: vi.fn(),
      initWidget: () => undefined,
    },
  });
  dom.window.eval(scriptSource);
  return dom;
}

function modelFor(
  widget: ArtifactReviewWidgetModel,
  overrides: {
    purpose?: Record<string, unknown>;
    quality?: Record<string, unknown>;
    ruling?: Record<string, unknown>;
    authority?: Record<string, unknown>;
    modalityGate?: Record<string, unknown>;
  } = {}
) {
  return widget.normalizeReviewResponse({
    artifact: { id: 'artifact-123', name: 'Proofed launch asset' },
    reviewContract: {
      schemaVersion: 'artifact_review_contract.v1',
      purpose: {
        kind: 'deliverable',
        label: 'Deliverable',
        reviewRequired: true,
        ...overrides.purpose,
      },
      quality: {
        state: 'cleared',
        score: 0.91,
        threshold: 0.85,
        ...overrides.quality,
      },
      ruling: {
        state: 'pending',
        label: 'Pending human ruling',
        ...overrides.ruling,
      },
      modalityGate: {
        state: 'not_required',
        blocksAdvance: false,
        ...overrides.modalityGate,
      },
      authority: { canReview: true, ...overrides.authority },
    },
  });
}

describe('artifact verification widget', () => {
  it('normalizes canonical tool wrappers and never derives quality state from score', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;
    const model = widget.normalizeReviewResponse({
      structuredContent: {
        artifact: { id: 'artifact-123' },
        reviewContract: {
          schemaVersion: 'artifact_review_contract.v1',
          quality: { state: 'unscored', score: 0.99, threshold: 0.85 },
        },
      },
    });

    expect(model.artifact.id).toBe('artifact-123');
    expect(
      widget.scoreText(model.contract.quality as Record<string, unknown>)
    ).toEqual({
      value: 'unscored',
      detail: '0.99 historical · no current score',
    });
  });

  it('keeps evidence-only records non-reviewable even when a caller has review authority', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;
    const model = modelFor(widget, {
      purpose: { kind: 'evidence', label: 'Evidence', reviewRequired: false },
    });

    expect(widget.choosePrimaryAction(model)).toMatchObject({
      kind: 'open',
      label: 'Inspect evidence in OrgX',
    });
  });

  it('selects exactly one action from canonical state', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;

    expect(widget.choosePrimaryAction(modelFor(widget)).kind).toBe('approved');
    expect(
      widget.choosePrimaryAction(
        modelFor(widget, { quality: { state: 'failed', score: 0.71 } })
      ).kind
    ).toBe('changes_requested');
    expect(
      widget.choosePrimaryAction(
        modelFor(widget, { quality: { state: 'scoring', score: null } })
      ).kind
    ).toBe('open');
    expect(
      widget.choosePrimaryAction(
        modelFor(widget, { ruling: { state: 'accepted' } })
      ).kind
    ).toBe('open');
    expect(
      widget.choosePrimaryAction(
        modelFor(widget, {
          quality: { state: 'error', score: null, previousScore: 0.91 },
          ruling: { state: 'accepted' },
        })
      )
    ).toMatchObject({
      kind: 'open',
      label: 'Inspect current verification error',
    });
  });

  it('uses the purpose-built review mutation and renders only returned canonical state', () => {
    expect(widgetHtml).toContain(
      "window.OrgXWidgetRuntime.callTool('submit_artifact_review'"
    );
    expect(widgetHtml).toContain('render(refreshed.raw)');
    expect(widgetHtml).not.toContain("callTool('orgx_act'");
    expect(widgetHtml).not.toContain("callTool('orgx_decide'");
    expect(widgetHtml).not.toContain('Object.assign({}, artifact');
    expect(widgetHtml).toContain('Hold to accept & advance');
    expect(widgetHtml).not.toContain("state: approved ? 'validated'");
  });

  it('renders one dominant ruling, one primary action, and accessible geometry', () => {
    const dom = createWidget();
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    expect(dom.window.document.querySelectorAll('h1')).toHaveLength(1);
    expect(dom.window.document.querySelectorAll('[data-primary-action]')).toHaveLength(1);
    expect(widgetHtml).toContain('min-height: 46px');
    expect(widgetHtml).toContain('prefers-reduced-motion');
    expect(widgetHtml).toContain('shared/widget-runtime.js');
    expect(widgetHtml).toContain('thresholdSourceText(quality)');
    expect(widgetHtml).toContain('ruling.actorLabel');
    expect(widgetHtml).toContain('outcome.observedAt');
  });

  it('keeps reviewer provenance readable and machine-readable', () => {
    const dom = createWidget('approved');
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    const reviewedAt = dom.window.document.querySelector(
      '[aria-label="Verification signals"] time'
    );
    expect(reviewedAt?.getAttribute('datetime')).toBe(
      '2026-08-01T12:00:00.000Z'
    );
    expect(reviewedAt?.textContent).not.toContain('2026-08-01T');
    expect(widgetHtml).toContain('font-size: 0.6875rem');
    expect(
      dom.window.document
        .querySelector('[data-axis="human"]')
        ?.getAttribute('data-state')
    ).toBe('accepted');
    expect(
      dom.window.document
        .querySelector('[data-axis="outcome"]')
        ?.getAttribute('data-state')
    ).toBe('unobserved');

    const observed = createWidget('observed');
    observed.window.document.dispatchEvent(
      new observed.window.Event('DOMContentLoaded')
    );
    expect(
      observed.window.document
        .querySelector('[data-axis="human"]')
        ?.getAttribute('data-state')
    ).toBe('accepted');
    expect(
      observed.window.document
        .querySelector('[data-axis="outcome"]')
        ?.getAttribute('data-state')
    ).toBe('observed');
    expect(
      observed.window.document.querySelectorAll(
        '[aria-label="Verification signals"] time'
      )
    ).toHaveLength(2);
  });

  it('renders error and visual-proof demo states with fail-closed actions', () => {
    const errored = createWidget('error');
    errored.window.document.dispatchEvent(
      new errored.window.Event('DOMContentLoaded')
    );
    expect(
      errored.window.document
        .querySelector('[data-primary-action]')
        ?.textContent?.trim()
    ).toBe('Inspect current verification error');
    expect(
      errored.window.document
        .querySelector('.quality-gauge')
        ?.getAttribute('aria-label')
    ).toContain('Historical score 91');

    const visualBlocked = createWidget('visual-blocked');
    visualBlocked.window.document.dispatchEvent(
      new visualBlocked.window.Event('DOMContentLoaded')
    );
    expect(
      visualBlocked.window.document
        .querySelector('[data-primary-action]')
        ?.textContent?.trim()
    ).toBe('Request visual proof');
  });

  it('routes a canonically blocked visual artifact to changes instead of approval', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;

    expect(
      widget.choosePrimaryAction(
        modelFor(widget, {
          quality: { state: 'cleared', score: 0.94 },
          ruling: { state: 'pending' },
          modalityGate: {
            state: 'blocked',
            label: 'Runtime and responsive proof incomplete',
            blocksAdvance: true,
          },
        })
      )
    ).toMatchObject({
      kind: 'changes_requested',
      label: 'Request runtime and responsive proof',
    });
  });

  it('preserves the quality bar without promoting historical evidence', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;

    const failed = widget.renderQualityGauge(
      { state: 'failed', score: 0.74, threshold: 0.85 },
      true
    );
    expect(failed).toContain('width:74%');
    expect(failed).toContain('Quality bar 85');
    expect(failed).toContain('Current quality score 74');

    const errored = widget.renderQualityGauge(
      {
        state: 'error',
        score: 0.97,
        previousScore: 0.91,
        threshold: 0.85,
      },
      true
    );
    expect(errored).not.toContain('width:97%');
    expect(errored).toContain('Historical score 91');
    expect(errored).toContain('quality-gauge__historical');

    const currentWithHistory = widget.renderQualityGauge(
      {
        state: 'failed',
        score: 0.74,
        previousScore: 0.91,
        threshold: 0.85,
      },
      true
    );
    expect(currentWithHistory).toContain('Current 74');
    expect(currentWithHistory).toContain('Prior 91');
    expect(currentWithHistory).toContain('Historical score 91');

    expect(
      widget.renderQualityGauge(
        { state: 'skipped', score: null, threshold: 0.85 },
        false
      )
    ).toBe('');
  });

  it('keeps quality anatomy compact, native, and after the primary action', () => {
    const dom = createWidget('failed');
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    const action = dom.window.document.querySelector('[data-primary-action]');
    const details = dom.window.document.querySelector<HTMLDetailsElement>(
      '[data-quality-anatomy]'
    );
    const summary = details?.querySelector('summary');

    expect(details?.open).toBe(false);
    expect(summary?.getAttribute('aria-label')).toBe(
      'Quality anatomy: 3 inputs, 4 judged, 2 measured, and 1 observed.'
    );
    expect(
      summary?.querySelectorAll('.quality-anatomy__flow-step')
    ).toHaveLength(4);
    expect(
      action && details
        ? action.compareDocumentPosition(details) &
            dom.window.Node.DOCUMENT_POSITION_FOLLOWING
        : 0
    ).toBeTruthy();

    summary?.focus();
    expect(dom.window.document.activeElement).toBe(summary);
    summary?.click();
    expect(details?.open).toBe(true);
    expect(details?.querySelectorAll('[role="listitem"]')).toHaveLength(4);
  });

  it('summarizes only canonical evidence and never promotes unknown checks', () => {
    const dom = createWidget();
    const widget = (
      dom.window as unknown as {
        OrgXArtifactReviewWidgetModel: ArtifactReviewWidgetModel;
      }
    ).OrgXArtifactReviewWidgetModel;
    const model = widget.normalizeReviewResponse({
      artifact: { id: 'artifact-123', version: 9 },
      reviewContract: {
        schemaVersion: 'artifact_review_contract.v1',
        quality: { state: 'error', threshold: 0.85 },
        lineage: { version: 9 },
        counts: { evidenceRefs: 11 },
        evidence: {
          confidence: 0.93,
          gradedLayers: 3,
          relationships: [{ label: 'Brief' }, { label: 'Pinned rubric' }],
          layers: [
            { label: 'Correctness' },
            { label: 'Audience fit' },
            { label: 'Third label stays bounded' },
            { label: 'Fourth layer' },
          ],
          measured: [
            { check: 'Schema', passed: true },
            { check: 'Claims', passed: false },
            { check: 'Runtime' },
          ],
          observations: [{ label: 'Rendered output inspected' }],
        },
      },
    });

    const anatomy = widget.buildQualityAnatomy(model);
    expect(anatomy).toMatchObject({
      inputCount: 3,
      judgedCount: 4,
      measuredCount: 3,
      observedCount: 1,
      evidenceIsCurrent: false,
      qualityState: 'error',
    });
    expect(anatomy.stages[0]).toMatchObject({
      value: '1 artifact · 2 linked refs',
    });
    expect(anatomy.stages[0]?.detail).toContain('11 evidence records');
    expect(anatomy.stages[2]?.value).toContain('1 held');
    expect(anatomy.stages[2]?.value).toContain('1 unreported');
    expect(anatomy.stages[2]?.value).not.toContain('all clear');

    const html = widget.renderQualityAnatomy(model);
    expect(html).toContain('Correctness · Audience fit');
    expect(html).not.toContain('Third label stays bounded');
    expect(html).toContain('quality-anatomy__freshness">Context only');
    expect(html).toContain('context only and cannot clear the current version');
    expect(html).toContain('Outcome axis');
  });

  it('uses explicit signal states and supports an expanded demo without changing actions', () => {
    const dom = createWidget('failed&anatomy=expanded');
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    expect(
      dom.window.document.querySelector<HTMLDetailsElement>(
        '[data-quality-anatomy]'
      )?.open
    ).toBe(true);
    expect(
      dom.window.document
        .querySelector('[data-axis="quality"]')
        ?.getAttribute('data-state')
    ).toBe('failed');
    expect(
      dom.window.document
        .querySelector('[data-axis="human"]')
        ?.getAttribute('data-state')
    ).toBe('pending');
    expect(
      dom.window.document
        .querySelector('[data-axis="outcome"]')
        ?.getAttribute('data-state')
    ).toBe('unobserved');
    expect(
      dom.window.document.querySelector('[data-primary-action]')?.textContent
    ).toContain('Request a stronger iteration');
  });
});
