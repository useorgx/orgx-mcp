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
};

function createWidget() {
  const dom = new JSDOM(widgetHtml, {
    url: 'https://example.test/widgets/artifact-review.html?demo=true',
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
    expect(widget.scoreText(model.contract.quality as Record<string, unknown>)).toEqual({
      value: 'unscored',
      detail: '0.99 / 0.85 bar',
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
  });

  it('uses the purpose-built review mutation and renders only returned canonical state', () => {
    expect(widgetHtml).toContain(
      "window.OrgXWidgetRuntime.callTool('submit_artifact_review'"
    );
    expect(widgetHtml).toContain('render(refreshed.raw)');
    expect(widgetHtml).not.toContain("callTool('orgx_act'");
    expect(widgetHtml).not.toContain("callTool('orgx_decide'");
    expect(widgetHtml).not.toContain('Object.assign({}, artifact');
  });

  it('renders one dominant ruling, one primary action, and accessible geometry', () => {
    const dom = createWidget();
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

    expect(dom.window.document.querySelectorAll('h1')).toHaveLength(1);
    expect(dom.window.document.querySelectorAll('[data-primary-action]')).toHaveLength(1);
    expect(widgetHtml).toContain('min-height: 46px');
    expect(widgetHtml).toContain('prefers-reduced-motion');
    expect(widgetHtml).toContain('shared/widget-runtime.js');
  });
});
