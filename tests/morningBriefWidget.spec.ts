import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
    resolve(process.cwd(), 'public/widgets/shared/icons.js'),
    'utf8'
  );

  it('uses the shared token and icon system for the benchmark-style shell', () => {
    // Shared tokens must be pulled via a top-level <link> tag — `@import`
    // inside a <style> block does not survive Claude's MCP Apps sandbox.
    expect(widgetSource).toMatch(/<link[^>]+href=("|')shared\/tokens\.css\1/);
    expect(widgetSource).not.toContain("@import url('./shared/tokens.css');");
    expect(widgetSource).toContain("import { icons } from './shared/icons.js';");
    expect(widgetSource).toContain('class="action-strip app-action-stack"');
    expect(widgetSource).toContain('class="metric-rail app-metric-rail"');
    expect(widgetSource).toContain('class="brief-section app-accordion-section');
    expect(widgetSource).toContain('class="output-list app-list-stack"');
  });

  it('ships the interactive morning brief drilldown model', () => {
    expect(widgetSource).toContain('data-action="open-section"');
    expect(widgetSource).toContain('data-action="toggle-section"');
    expect(widgetSource).toContain('data-action="open-link"');
    expect(widgetSource).toContain('function setActiveSection(section, options = {})');
    expect(widgetSource).toContain('aria-expanded="${');
    expect(widgetSource).toContain('aria-controls="panel-priorities"');
    expect(widgetSource).toContain('role="region"');
    expect(widgetSource).toContain(
      "setActiveSection(trigger.dataset.section || state.activeSection, { scroll: true });"
    );
    expect(widgetSource).not.toContain(
      'The team completed the mission and prepped the next one.'
    );
  });

  it('contains a syntactically valid widget module', () => {
    const moduleSource = widgetSource.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(moduleSource).toBeTruthy();

    const executableSource = moduleSource?.replace(/^\s*import\s+.+?;\s*$/gm, '') || '';
    expect(() => new Function(executableSource)).not.toThrow();
  });

  it('extends shared primitives for richer action and accordion treatments', () => {
    expect(tokenSource).toContain('.app-action-card');
    expect(tokenSource).toContain('.app-action-card-cta');
    expect(tokenSource).toContain('.app-accordion-section');
    expect(tokenSource).toContain('.app-accordion-chevron');
    expect(tokenSource).toContain('.app-list-row');
    expect(iconSource).toContain('chevronDown');
    expect(iconSource).toContain('chevronRight');
  });
});
