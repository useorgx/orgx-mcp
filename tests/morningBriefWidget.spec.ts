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
    expect(widgetSource).toContain("@import url('./shared/tokens.css');");
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
    expect(widgetSource).toContain('state.activeSection = trigger.dataset.section || state.activeSection;');
    expect(widgetSource).not.toContain(
      'The team completed the mission and prepped the next one.'
    );
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
