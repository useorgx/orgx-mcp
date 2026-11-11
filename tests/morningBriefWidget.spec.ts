import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('morning brief widget', () => {
  const widgetSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/morning-brief.html'),
    'utf8'
  );
  const tokenSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/shared/tokens.css'),
    'utf8'
  );
  const iconSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/shared/orgx-icons.js'),
    'utf8'
  );

  it('uses the shared token and icon system for the benchmark-style shell', () => {
    // Shared tokens must be pulled via a top-level <link> tag — `@import`
    // inside a <style> block does not survive Claude's MCP Apps sandbox.
    expect(widgetSource).toMatch(/<link[^>]+href=("|')shared\/tokens\.css\1/);
    expect(widgetSource).not.toContain("@import url('./shared/tokens.css');");
    expect(widgetSource).toContain('<script src="shared/orgx-icons.js"></script>');
    expect(widgetSource).toContain('window.OrgXIcons.icon(name, { size })');
    expect(widgetSource).not.toContain('<script src="shared/icons.js"></script>');
    expect(widgetSource).not.toContain("from './shared/utils.js'");
    expect(widgetSource).toContain('class="action-strip app-action-stack"');
    // One way into each section (no tab rail duplicating the section rows).
    expect(widgetSource).not.toContain('class="metric-rail app-metric-rail"');
    expect(widgetSource).toContain('class="brief-section app-accordion-section');
    expect(widgetSource).toContain('class="app-accordion-panel ox-collapse"');
    expect(widgetSource).toContain('class="output-list app-list-stack"');
  });

  it('ships the interactive morning brief drilldown model', () => {
    expect(widgetSource).toContain("const dataAction = action.url ? 'open-link' : 'open-section';");
    expect(widgetSource).toContain('data-action="toggle-section"');
    expect(widgetSource).toContain('data-action="open-link"');
    expect(widgetSource).toContain('function setActiveSection(section, options = {})');
    expect(widgetSource).toContain('aria-controls="panel-${section}"');
    expect(widgetSource).toContain('class="priorities" role="list"');
    expect(widgetSource).not.toContain(
      'The team completed the mission and prepped the next one.'
    );
    expect(widgetSource).toContain(
      "protocol === 'chatgpt' && payload === null"
    );
  });

  it('extends shared primitives for richer action and accordion treatments', () => {
    expect(tokenSource).toContain('.app-action-card');
    expect(tokenSource).toContain('.app-action-card-cta');
    expect(tokenSource).toContain('.app-accordion-section');
    expect(tokenSource).toContain('.app-accordion-chevron');
    expect(tokenSource).toContain('.app-list-row');
    expect(iconSource).toContain('global.OrgXIcons = {');
    expect(iconSource).toContain("expand: '");
  });
});

// Boots the real widget in JSDOM with its shared scripts (the MCP Apps SDK is
// skipped; ChatGPT globals deliver the payload).
async function bootBrief(toolOutput: unknown) {
  const { JSDOM } = await import('jsdom');
  const root = resolve(process.cwd(), 'public/widgets');
  const html = readFileSync(resolve(root, 'morning-brief.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/morning-brief.html', runScripts: 'outside-only' });
  Object.assign(dom.window, { openai: { toolOutput, callTool: vi.fn(), setWidgetHeight: vi.fn() }, fetch: vi.fn().mockResolvedValue({ ok: true }) });
  for (const script of dom.window.document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    if (src && /mcp-apps-sdk/.test(src)) continue;
    dom.window.eval(src ? readFileSync(resolve(root, src), 'utf8') : script.textContent!);
  }
  await vi.advanceTimersByTimeAsync(400);
  return dom;
}
const briefText = (dom: { window: Window }) => dom.window.document.getElementById('content')!.textContent!.replace(/\s+/g, ' ');

describe('morning brief renders every payload bound to it', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows ranked recommendations from orgx_recommend next_action mode', async () => {
    const dom = await bootBrief({
      entity_type: 'workspace', entity_id: 'default', canonical_only: false,
      recommendations: [
        { label: 'Decide the launch discount', entity_type: 'decision', summary: 'Blocks pricing', score: 0.9 },
        { label: 'Finish checkout', entity_type: 'workstream' },
      ],
      next_action: { label: 'Decide the launch discount' },
      message: 'Next action: Decide the launch discount.',
    });
    const priorities = Array.from(dom.window.document.querySelectorAll('.priority-title')).map((el) => el.textContent);
    expect(priorities).toEqual(['Decide the launch discount', 'Finish checkout']);
    expect(briefText(dom)).toContain('Blocks pricing');
    dom.window.close();
  });

  it('falls back to next_action alone when no ranked list is returned', async () => {
    const dom = await bootBrief({ recommendations: [], next_action: { title: 'Approve the pricing memo', reason: 'Waiting two days' } });
    const priorities = Array.from(dom.window.document.querySelectorAll('.priority-title')).map((el) => el.textContent);
    expect(priorities).toEqual(['Approve the pricing memo']);
    dom.window.close();
  });

  it('counts chronicle in_review artifacts as review items and reads their url, type and agent', async () => {
    const now = new Date().toISOString();
    const dom = await bootBrief({ ok: true, _v2_tool: 'orgx_recommend', mode: 'morning_brief', chronicle: {
      generatedAt: now, summary: 'Quiet day.', metrics: { pendingDecisions: 0, blockedWork: 0 }, topPriorities: [], reportingNarrative: {},
      artifactLedger: [
        { id: 'a1', title: 'Pricing memo', status: 'in_review', artifactType: 'mktg.copy', agentType: 'marketing', url: 'https://useorgx.com/artifacts/a1', updatedAt: now },
        { id: 'a2', title: 'Release notes', status: 'approved', artifactType: 'eng.report', url: 'https://useorgx.com/artifacts/a2', updatedAt: now },
      ],
    } });
    const text = briefText(dom);
    expect(text).toContain('1 artifact needs your review');
    expect(text).toContain('Mktg.Copy');
    expect(text).toMatch(/Ready for an operator review before execution continues. marketing/);
    const review = dom.window.document.querySelector('.output-link') as HTMLElement;
    expect(review?.dataset.url).toBe('https://useorgx.com/artifacts/a1');
    dom.window.close();
  });
});
