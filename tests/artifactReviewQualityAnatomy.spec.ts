// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const widgetPath = join(
  process.cwd(),
  'public',
  'widgets',
  'artifact-review.html',
);
const widgetHtml = readFileSync(widgetPath, 'utf8');
const parsedWidget = new JSDOM(widgetHtml).window.document;
const scriptSource =
  Array.from(parsedWidget.querySelectorAll('script')).find((script) =>
    script.textContent?.includes('buildQualityAnatomy'),
  )?.textContent ?? '';

function createWidget(
  query: string,
  toolOutput?: Record<string, unknown>,
) {
  const dom = new JSDOM(widgetHtml, {
    url: `https://example.test/widgets/artifact-review.html?${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => 'standalone',
      reportSize: vi.fn(),
      callTool: vi.fn().mockResolvedValue({}),
      openWidgetLink: vi.fn(),
      initWidget: vi.fn(),
    },
  });
  if (toolOutput) {
    Object.defineProperty(dom.window, 'openai', {
      configurable: true,
      value: { toolOutput },
    });
  }
  dom.window.eval(scriptSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

function canonicalToolOutput(options: {
  reviewRequired?: boolean;
  canReview?: boolean;
  omitAuthority?: boolean;
  qualityState?: string;
  qualityBlocksAdvance?: boolean;
  modalityBlocksAdvance?: boolean;
} = {}) {
  const authority = options.omitAuthority
    ? undefined
    : { canReview: options.canReview ?? true };
  return {
    artifact: {
      id: 'artifact-canonical-actions',
      name: 'Canonical action fixture',
      version: 2,
      status: 'in_review',
    },
    reviewContractSource: 'canonical',
    reviewContract: {
      schemaVersion: 'artifact_review_contract.v1',
      purpose: { reviewRequired: options.reviewRequired ?? true },
      quality: {
        state: options.qualityState ?? 'unscored',
        score: null,
        previousScore: null,
        threshold: 0.85,
        blocksAdvance: options.qualityBlocksAdvance ?? false,
        reason: 'Canonical quality policy.',
        thresholdSource: { kind: 'system_default' },
        anatomy: null,
      },
      ruling: { state: 'pending' },
      modalityGate: {
        state: 'not_required',
        blocksAdvance: options.modalityBlocksAdvance ?? false,
      },
      ...(authority ? { authority } : {}),
      workflow: {
        headline: 'Awaiting decision',
        reason: 'Canonical evidence is ready for review.',
      },
      lineage: { version: 2 },
      counts: { evidenceRefs: 0 },
      evidence: {
        relationships: [],
        layers: [],
        measured: [],
        observations: [],
      },
    },
  };
}

describe('artifact review quality anatomy', () => {
  it('keeps the quality bar visible and the ready anatomy compact by default', () => {
    const dom = createWidget('state=ready&theme=dark');
    const gauge = dom.window.document.querySelector('[data-quality-gauge]');
    const anatomy = dom.window.document.querySelector<HTMLDetailsElement>(
      '[data-quality-anatomy]',
    );

    expect(gauge?.getAttribute('aria-label')).toBe(
      'Current quality score 94 out of 100. Quality bar 85.',
    );
    expect(gauge?.textContent).toContain('Current 94');
    expect(gauge?.textContent).toContain('Enterprise launch package v4 · workspace');
    expect(anatomy?.open).toBe(false);
    expect(anatomy?.querySelector('summary')?.textContent).toContain(
      'How 94 cleared the bar',
    );
    expect(anatomy?.querySelectorAll('.quality-anatomy__flow-step')).toHaveLength(4);
  });

  it('expands the failed score into inputs, judged criteria, measures, and observation', () => {
    const dom = createWidget('state=failed&anatomy=expanded&theme=dark');
    const anatomy = dom.window.document.querySelector<HTMLDetailsElement>(
      '[data-quality-anatomy]',
    );
    const stages = anatomy?.querySelectorAll('[role="listitem"]');

    expect(anatomy?.open).toBe(true);
    expect(anatomy?.querySelector('summary')?.getAttribute('aria-label')).toBe(
      'How 74 became held: 3 inputs, 4 judged, 3 measured, and 1 observed.',
    );
    expect(stages).toHaveLength(4);
    expect(stages?.[0]?.textContent).toContain('1 artifact · 2 linked refs');
    expect(stages?.[1]?.textContent).toContain('4 criteria · 2 below bar');
    expect(stages?.[1]?.textContent).toContain('Theoretical contribution 59');
    expect(stages?.[2]?.textContent).toContain('3 checks · 2 clear · 1 held');
    expect(stages?.[3]?.textContent).toContain('1 inspection');
    expect(anatomy?.textContent).toContain('neither substitutes for the human ruling');
    expect(
      dom.window.document.querySelector<HTMLButtonElement>('[data-action="approve"]')
        ?.disabled,
    ).toBe(true);
  });

  it('does not promote an errored score or fabricate missing evidence', () => {
    const dom = createWidget('', {
      artifact: {
        id: 'artifact-error',
        name: 'Errored verification fixture',
        version: 9,
        status: 'in_review',
        verification: {
          eval: {
            status: 'error',
            score: 0.99,
            previous_score: 0.91,
            threshold: 0.85,
          },
        },
      },
    });
    const gauge = dom.window.document.querySelector('[data-quality-gauge]');
    const anatomy = dom.window.document.querySelector('[data-quality-anatomy]');

    expect(gauge?.getAttribute('aria-label')).toBe(
      'No current quality score. Historical score 91. Quality bar 85.',
    );
    expect(gauge?.innerHTML).not.toContain('width:99%');
    expect(anatomy?.textContent).toContain('Context only');
    expect(anatomy?.textContent).toContain('No current score');
    expect(anatomy?.textContent).not.toContain('99 vs 85');
    expect(anatomy?.textContent).toContain('No judged criteria');
    expect(anatomy?.textContent).toContain('No measured checks');
    expect(anatomy?.textContent).toContain('No direct observations');
  });

  it('uses the canonical current-run anatomy over contradictory artifact metadata', () => {
    const dom = createWidget('anatomy=expanded', {
      artifact: {
        id: 'artifact-canonical-held',
        name: 'Canonical held artifact',
        version: 4,
        status: 'in_review',
        verification: {
          eval: { status: 'passed', score: 0.99, threshold: 0.85 },
        },
      },
      reviewContractSource: 'canonical',
      reviewContract: {
        schemaVersion: 'artifact_review_contract.v1',
        purpose: { reviewRequired: true },
        quality: {
          state: 'failed',
          score: 0.74,
          previousScore: 0.94,
          threshold: 0.85,
          blocksAdvance: true,
          reason: 'The current quality evaluation failed.',
          thresholdSource: {
            kind: 'eval_profile',
            profileName: 'Sequel chapter quality',
            profileVersion: 1,
            profileScope: 'workspace',
          },
          anatomy: {
            schemaVersion: 'artifact_evaluation_anatomy.v1',
            source: 'recorded_snapshot',
            runId: 'eval-current-v4',
            artifactVersion: 4,
            profile: {
              id: 'profile-1',
              name: 'Sequel chapter quality',
              version: 1,
              scope: 'workspace',
            },
            threshold: 0.85,
            runner: { key: 'openai_eval', label: 'Managed eval' },
            inputSummary: {
              artifactType: 'document.chapter',
              modality: 'document',
              referenceCount: 2,
              contentDigest: 'sha256:fixture',
            },
            criteria: [
              { label: 'Theoretical contribution', score: 0.59, passed: false },
              { label: 'Source support', score: 0.63, passed: false },
              { label: 'Narrative coherence', score: 0.88, passed: true },
              { label: 'Reader relevance', score: 0.86, passed: true },
            ],
            aggregation: { method: 'mean', count: 4 },
            decision: { score: 0.74, status: 'failed' },
          },
        },
        ruling: { state: 'pending' },
        modalityGate: { state: 'not_required', blocksAdvance: false },
        authority: { canReview: true },
        workflow: {
          headline: 'Held below bar',
          reason: 'Two judged inputs remain below the configured bar.',
        },
        lineage: { version: 4 },
        counts: { evidenceRefs: 6 },
        evidence: {
          relationships: [{ label: 'Sequel positioning brief' }],
          layers: [],
          measured: [
            { label: 'Citation coverage', passed: false },
            { label: 'Required sections', passed: true },
          ],
          observations: [{ label: 'Mobile proof inspected' }],
        },
      },
    });
    const gauge = dom.window.document.querySelector('[data-quality-gauge]');
    const anatomy = dom.window.document.querySelector('[data-quality-anatomy]');

    expect(gauge?.textContent).toContain('Current 74');
    expect(gauge?.innerHTML).not.toContain('width:99%');
    expect(anatomy?.textContent).toContain('(59 + 63 + 88 + 86) ÷ 4 = 74');
    expect(anatomy?.textContent).toContain('4 criteria · 2 below bar');
    expect(anatomy?.textContent).toContain('2 checks · 1 clear · 1 held');
    expect(anatomy?.textContent).toContain('1 inspection');
    expect(
      dom.window.document.querySelector<HTMLButtonElement>('[data-action="approve"]')
        ?.disabled,
    ).toBe(true);
  });

  it('keeps accepted lifecycle, unscored quality, blocked visual proof, and authority separate', () => {
    const dom = createWidget('anatomy=expanded', {
      artifact: {
        id: 'artifact-approved-unscored',
        name: 'Approved visual asset',
        version: 1,
        status: 'approved',
      },
      reviewContractSource: 'canonical',
      reviewContract: {
        schemaVersion: 'artifact_review_contract.v1',
        purpose: { reviewRequired: true },
        quality: {
          state: 'unscored',
          score: null,
          previousScore: null,
          threshold: 0.85,
          blocksAdvance: true,
          reason: 'No current scored quality evaluation is recorded.',
          thresholdSource: { kind: 'system_default' },
          anatomy: null,
        },
        ruling: {
          state: 'accepted',
          actorKind: 'human',
          actorLabel: 'Editorial owner',
        },
        modalityGate: {
          state: 'blocked',
          blocksAdvance: true,
        },
        authority: { canReview: true },
        workflow: {
          headline: 'Visual proof incomplete',
          reason: 'Human acceptance is recorded, but visual proof is incomplete.',
        },
        lineage: { version: 1 },
        counts: { evidenceRefs: 1 },
        evidence: {
          relationships: [],
          layers: [
            { label: 'Visual composition', score: 0.88, passed: true },
          ],
          measured: [],
          observations: [],
        },
      },
    });
    const anatomy = dom.window.document.querySelector('[data-quality-anatomy]');

    expect(dom.window.document.querySelector('[data-quality-gauge]')?.textContent)
      .toContain('No current score');
    expect(dom.window.document.body.textContent).toContain('Ruling recorded');
    expect(dom.window.document.body.textContent).toContain(
      'accepted · Editorial owner',
    );
    expect(anatomy?.textContent).toContain(
      'No scored inputs · 1 supporting layer',
    );
    expect(anatomy?.textContent).toContain('not score formula');
    expect(anatomy?.textContent).toContain(
      'Recorded score · formula unavailable',
    );
    expect(
      dom.window.document.querySelector('[data-action="request-changes"]'),
    ).toBeNull();
  });

  it('keeps canonical non-review targets evidence-only even when authority is present', () => {
    const dom = createWidget(
      'theme=dark',
      canonicalToolOutput({ reviewRequired: false, canReview: true }),
    );

    expect(dom.window.document.querySelector('[data-action="approve"]')).toBeNull();
    expect(
      dom.window.document.querySelector('[data-action="request-changes"]'),
    ).toBeNull();
    expect(dom.window.document.body.textContent).toContain(
      'Review controls unavailable',
    );
    expect(
      (dom.window as unknown as {
        OrgXWidgetRuntime: { callTool: ReturnType<typeof vi.fn> };
      }).OrgXWidgetRuntime.callTool,
    ).not.toHaveBeenCalled();
  });

  it('fails canonical review authority closed when the envelope omits authority', () => {
    const dom = createWidget(
      'theme=dark',
      canonicalToolOutput({ omitAuthority: true }),
    );

    expect(dom.window.document.querySelector('[data-action="approve"]')).toBeNull();
    expect(
      dom.window.document.querySelector('[data-action="request-changes"]'),
    ).toBeNull();
  });

  it('honors canonical optional-quality policy instead of re-blocking unscored state', () => {
    const dom = createWidget(
      'theme=dark',
      canonicalToolOutput({
        qualityState: 'unscored',
        qualityBlocksAdvance: false,
        modalityBlocksAdvance: false,
      }),
    );

    expect(
      dom.window.document.querySelector<HTMLButtonElement>(
        '[data-action="approve"]',
      )?.disabled,
    ).toBe(false);
    expect(
      dom.window.document.querySelector('[data-action="request-changes"]'),
    ).not.toBeNull();
  });

  it('preserves the shared theme architecture and responsive evidence geometry', () => {
    expect(widgetHtml).toContain('href="shared/widget-theme.css"');
    expect(widgetHtml.lastIndexOf('href="shared/widget-theme.css"')).toBeGreaterThan(
      widgetHtml.lastIndexOf('</style>'),
    );
    expect(widgetHtml).toContain('@media (max-width: 760px)');
    expect(widgetHtml).toContain('@media (max-width: 520px)');
    expect(widgetHtml).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(widgetHtml).toContain('prefers-reduced-motion');
  });
});
