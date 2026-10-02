// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const widgetPath = join(
  process.cwd(),
  'public',
  'widgets',
  'plan-session-live.html'
);
const widgetHtml = readFileSync(widgetPath, 'utf8');
const scriptSource =
  Array.from(
    new JSDOM(widgetHtml).window.document.querySelectorAll('script')
  ).find((script) => script.textContent?.includes('function installPlanWidget'))
    ?.textContent ?? '';

type PlanWidgetModel = {
  normalizePlanPayload: (payload: unknown) => {
    id: string;
    title: string;
    status: string;
    sections: Array<{ heading: string; body: string }>;
    edits: Array<{ note: string }>;
  };
  renderMarkdownBody: (value: string) => string;
};

function createWidget(url = 'https://example.test/widgets/plan-session-live.html') {
  const dom = new JSDOM(widgetHtml, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => 'standalone',
      reportSize: () => undefined,
      callTool: async () => ({}),
      openWidgetLink: () => false,
      initWidget: () => undefined,
    },
  });
  dom.window.eval(scriptSource);
  return dom;
}

function getModel(dom: JSDOM): PlanWidgetModel {
  return (
    dom.window as unknown as { OrgXPlanWidgetModel: PlanWidgetModel }
  ).OrgXPlanWidgetModel;
}

describe('plan session widget', () => {
  it('renders the live current_plan contract instead of requiring synthetic steps', () => {
    const model = getModel(createWidget());
    const plan = model.normalizePlanPayload({
      id: '06bc7c7d-2778-4e2f-ab10-28f4b3e16554',
      feature_name: 'Fallback title',
      current_plan:
        '# Live plan title\n\n## Outcome\nMake proof visible.\n\n## Gates\n- CI\n- Deploy\n- Live proof',
      status: 'active',
      plan_version: 4,
      edits: [{ edit_summary: 'Keep states separate.' }],
    });

    expect(plan.id).toBe('06bc7c7d-2778-4e2f-ab10-28f4b3e16554');
    expect(plan.title).toBe('Live plan title');
    expect(plan.status).toBe('active');
    expect(plan.sections.map((section) => section.heading)).toEqual([
      'Outcome',
      'Gates',
    ]);
    expect(plan.sections[1].body).toContain('CI');
    expect(plan.edits[0].note).toBe('Keep states separate.');
  });

  it('normalizes selected_session wrappers and preserves legacy steps', () => {
    const model = getModel(createWidget());
    const plan = model.normalizePlanPayload({
      selected_session: {
        session_id: 'legacy-session',
        title: 'Legacy plan',
        status: 'completed',
        steps: [
          { title: 'Discover', detail: 'Read the source.' },
          { title: 'Verify', detail: 'Capture evidence.' },
        ],
      },
    });

    expect(plan.id).toBe('legacy-session');
    expect(plan.status).toBe('complete');
    expect(plan.sections).toMatchObject([
      { heading: 'Discover', body: 'Read the source.' },
      { heading: 'Verify', body: 'Capture evidence.' },
    ]);
  });

  it('escapes plan content before applying supported inline markdown', () => {
    const model = getModel(createWidget());
    const rendered = model.renderMarkdownBody(
      '<img src=x onerror=alert(1)> **evidence**'
    );

    expect(rendered).toContain('&lt;img');
    expect(rendered).toContain('<strong>evidence</strong>');
    expect(rendered).not.toContain('<img');
  });

  it('uses one H1, accessible interaction geometry, the official runtime, and the v2 edit action', () => {
    const dom = createWidget(
      'https://example.test/widgets/plan-session-live.html?demo=true&theme=dark'
    );
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    expect(dom.window.document.querySelectorAll('h1')).toHaveLength(1);
    expect(widgetHtml).toContain('min-height: 44px');
    expect(widgetHtml).toContain('shared/widget-runtime.js');
    expect(widgetHtml).toContain(
      "window.OrgXWidgetRuntime.callTool('orgx_plan'"
    );
    expect(widgetHtml).toContain("action: 'record_edit'");
    expect(widgetHtml).toContain('edit_summary: summary');
    expect(widgetHtml).toContain(
      'https://useorgx.com/planning/sessions/'
    );
  });

  it('sends guidance from the kit footer with the same orgx_plan call and keeps the note on failure', async () => {
    const dom = new JSDOM(widgetHtml, {
      url: 'https://example.test/widgets/plan-session-live.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const calls: Array<[string, unknown]> = [];
    let fail = true;
    Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
      configurable: true,
      value: {
        detectProtocol: () => 'chatgpt',
        reportSize: () => undefined,
        openWidgetLink: () => false,
        callTool: async (name: string, args: unknown) => {
          calls.push([name, args]);
          if (fail) throw new Error('host refused');
          return { structuredContent: { ok: true } };
        },
        initWidget: (options: { render: (payload: unknown) => void }) =>
          options.render({
            id: 'plan-1',
            current_plan: '# Ship it\n\n## Outcome\nMake proof visible.',
            status: 'active',
          }),
      },
    });
    dom.window.eval(scriptSource);
    const doc = dom.window.document;
    doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const footer = () => doc.getElementById('planFooter') as HTMLElement;
    const press = () => footer().dispatchEvent(new dom.window.CustomEvent('ox-primary'));

    expect(footer().getAttribute('primary-label')).toBe('Guide this plan');
    expect(doc.querySelector('[data-open-plan]')?.getAttribute('href')).toBe(
      'https://useorgx.com/planning/sessions/plan-1'
    );
    press();
    const input = doc.querySelector('[data-guidance-input]') as HTMLTextAreaElement;
    input.value = 'Name the reviewer.';
    input.dispatchEvent(new dom.window.Event('input'));
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls[0]).toEqual([
      'orgx_plan',
      { action: 'record_edit', session_id: 'plan-1', edit_summary: 'Outcome: Name the reviewer.' },
    ]);
    expect(footer().getAttribute('state')).toBe('failed');
    expect((doc.querySelector('[data-guidance-input]') as HTMLTextAreaElement).value).toBe('Name the reviewer.');

    fail = false;
    press();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);
    expect(footer().getAttribute('heading')).toBe('Guidance recorded');
  });
});
