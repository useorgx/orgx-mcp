// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { installSharedFoundations } from './fixtures/sharedFoundations';

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
  installSharedFoundations(dom.window);
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
  const checks = (dom: JSDOM) =>
    Array.from(dom.window.document.querySelectorAll('.qv-check')).map((row) => ({
      status: row.getAttribute('data-status'),
      text: row.textContent ?? '',
    }));

  it('says the verdict in one sentence, shows the bar it has to clear, and keeps details closed', () => {
    const dom = createWidget('state=ready&theme=dark');
    const gauge = dom.window.document.querySelector('[data-quality-gauge]');
    const toggle = dom.window.document.querySelector('[data-anatomy-toggle]');

    expect(gauge?.querySelector('.qv-title')?.textContent).toBe('Cleared · scored 94 of the 85 needed');
    expect(gauge?.querySelector('.qv-meter')?.getAttribute('aria-label')).toBe('Scored 94 out of 100; 85 needed.');
    expect(gauge?.querySelector('.qv-scale')?.textContent).toBe('Scored 9485 needed');
    expect(checks(dom).map((c) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(gauge?.textContent).toContain('Enterprise launch package v4 (workspace policy)');
    // No cryptic chain, no grid of empty lenses.
    expect(gauge?.textContent).not.toMatch(/→ held|Inputs\s*1|No .* returned/);
  });

  it('explains a held score as a checklist: what failed, what passed, and why', () => {
    const dom = createWidget('state=failed&anatomy=expanded&theme=dark');
    const toggle = dom.window.document.querySelector('[data-anatomy-toggle]');
    const rows = checks(dom);

    expect(dom.window.document.querySelector('.qv-title')?.textContent).toBe('Held · scored 74 of the 85 needed');
    expect(rows[0]).toEqual({ status: 'failed', text: expect.stringContaining('2 of 4 below the bar: Theoretical contribution 59, Source support 63') });
    expect(rows[1]).toEqual({ status: 'failed', text: expect.stringContaining('1 of 3 failed: Citation coverage') });
    expect(rows[2]).toEqual({ status: 'passed', text: expect.stringContaining('1 inspection') });
    expect(rows[3]).toEqual({ status: 'passed', text: expect.stringContaining('2 linked') });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(dom.window.document.querySelector('.qv-more')?.textContent).toContain('your ruling stays separate');
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

    expect(gauge?.querySelector('.qv-title')?.textContent).toBe('The check didn’t produce a score');
    // An errored run shows no bar at all: neither the 99 nor the old 91 reads as current.
    expect(gauge?.querySelector('.qv-meter')).toBeNull();
    expect(gauge?.innerHTML).not.toContain('width:99%');
    expect(anatomy?.textContent).toContain('context only');
    expect(checks(dom).map((c) => c.status)).toEqual(['not-run', 'not-run', 'not-run', 'not-run']);
    expect(gauge?.textContent).not.toContain('NaN');
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

    expect(gauge?.querySelector('.qv-title')?.textContent).toBe('Held · scored 74 of the 85 needed');
    expect(gauge?.innerHTML).not.toContain('width:99%');
    expect(anatomy?.textContent).toContain('Average of 4 criteria: 59 + 63 + 88 + 86 → 74.');
    expect(checks(dom)[0].text).toContain('2 of 4 below the bar');
    expect(checks(dom)[1].text).toContain('1 of 2 failed: Citation coverage');
    expect(checks(dom)[2].text).toContain('1 inspection');
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

    expect(dom.window.document.querySelector('.qv-title')?.textContent).toBe('Not scored yet');
    expect(dom.window.document.querySelector('[data-quality-gauge] .qv-meter')).toBeNull();
    expect(dom.window.document.body.textContent).toContain('Ruling recorded');
    expect(dom.window.document.querySelector('.widget-shell-card')?.textContent).not.toContain('NaN');
    // A supporting layer is shown as such, never as the score's formula.
    expect(checks(dom)[0].text).toContain('Visual composition 88');
    expect(anatomy?.textContent).toContain('Nothing has been scored yet.');
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
      'Your role can read this evidence; the ruling is recorded in OrgX.',
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

  function withPurpose(purpose: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const output = canonicalToolOutput({ reviewRequired: purpose.reviewRequired as boolean | undefined });
    (output.reviewContract as Record<string, unknown>).purpose = purpose;
    Object.assign(output.reviewContract as Record<string, unknown>, extra);
    return output;
  }

  it('resolves a blocker in OrgX: no Approve, no "sign-off", one Resolve control', () => {
    const dom = createWidget('theme=dark', withPurpose({ kind: 'blocker', reviewRequired: false, reviewAction: 'resolve' }));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-action="approve"]')).toBeNull();
    expect(doc.querySelector('[data-action="request-changes"]')).toBeNull();
    expect(doc.querySelector('.widget-shell-card')?.innerHTML).not.toMatch(/sign-off|signature/i);
    expect(doc.querySelector('ox-state-chip')?.getAttribute('label')).toBe('Blocking work');
    expect(doc.querySelector('#handoffFooter')?.getAttribute('primary-label')).toBe('Resolve in OrgX ↗');
    expect(doc.querySelector('.hd .kind')?.textContent).toBe('Blocker');
  });

  it('resolves even when an older contract still says the blocker needs review', () => {
    const dom = createWidget('theme=dark', withPurpose({ kind: 'blocker', reviewRequired: true, reviewAction: 'resolve' }));
    expect(dom.window.document.querySelector('[data-action="approve"]')).toBeNull();
    expect(dom.window.document.querySelector('#handoffFooter')).not.toBeNull();
  });

  it('inspects a record read-only', () => {
    const dom = createWidget('theme=dark', withPurpose({ kind: 'evidence', reviewRequired: false, reviewAction: 'inspect' }));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-action="approve"]')).toBeNull();
    expect(doc.querySelector('ox-state-chip')?.getAttribute('label')).toBe('Read only');
    expect(doc.querySelector('#handoffFooter')?.getAttribute('action-label')).toBe('Open in OrgX ↗');
  });

  it('signs a deliverable with the same controls, and reads a null score and note honestly', () => {
    const dom = createWidget('theme=dark', withPurpose(
      { kind: 'deliverable', reviewRequired: true, reviewAction: 'sign' },
      { ruling: { state: 'pending', note: null } },
    ));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-action="approve"]')).not.toBeNull();
    expect(doc.querySelector('[data-action="request-changes"]')).not.toBeNull();
    expect(doc.querySelector('.qv-title')?.textContent).toBe('Not scored yet');
    expect(doc.querySelector('.ruling-note')).toBeNull();
    expect(doc.querySelector('.widget-shell-card')?.textContent).not.toMatch(/NaN|undefined|null/);
  });

  it('shows the reviewer note when the ruling carries one', () => {
    const dom = createWidget('theme=dark', withPurpose(
      { kind: 'deliverable', reviewRequired: true, reviewAction: 'sign' },
      { ruling: { state: 'changes_requested', note: 'Cite the pricing study.', actorKind: 'human', actorLabel: 'Hope' } },
    ));
    expect(dom.window.document.querySelector('.ruling-note')?.textContent).toBe('Reviewer note · Cite the pricing study.');
  });

  it('preserves the shared theme architecture and responsive evidence geometry', () => {
    expect(widgetHtml).toContain('href="shared/widget-theme.css"');
    expect(widgetHtml.lastIndexOf('href="shared/widget-theme.css"')).toBeGreaterThan(
      widgetHtml.lastIndexOf('</style>'),
    );
    expect(widgetHtml).toContain('@media (max-width: 760px)');
    expect(widgetHtml).toContain('@media (max-width: 520px)');
    expect(widgetHtml).toContain('.qv-check { display: grid;');
    expect(widgetHtml).toContain('prefers-reduced-motion');
  });
});
