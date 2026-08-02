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
