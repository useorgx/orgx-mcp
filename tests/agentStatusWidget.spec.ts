import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('agent status widget', () => {
  const widgetSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/agent-status.html'),
    'utf8'
  );
  const tokenSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/shared/tokens.css'),
    'utf8'
  );

  it('adopts the shared widget token system for attention-first cards', () => {
    expect(widgetSource).toContain("@import url('./shared/tokens.css');");
    expect(widgetSource).toContain('class="agent-card app-flat-card"');
    expect(widgetSource).toContain('class="agent-attention app-attention-banner"');
    expect(widgetSource).toContain('class="metric-row app-metric-rail"');
    expect(widgetSource).toContain('class="app-disclosure-trigger focusable"');
  });

  it('renders the new drilldown interaction model instead of a timeline log', () => {
    expect(widgetSource).toContain('data-action="toggle-section"');
    expect(widgetSource).toContain('No agents need you right now');
    expect(widgetSource).toContain("if (section === 'overview')");
    expect(widgetSource).not.toContain('class="timeline"');
    expect(widgetSource).not.toContain('Task Distribution');
  });

  it('publishes reusable shared primitives for future widgets', () => {
    expect(tokenSource).toContain('.app-flat-card');
    expect(tokenSource).toContain('.app-metric-rail');
    expect(tokenSource).toContain('.app-attention-banner');
    expect(tokenSource).toContain('.app-disclosure-trigger');
    expect(tokenSource).toContain('--app-color-attention');
    expect(tokenSource).toContain('--app-color-review');
  });
});
