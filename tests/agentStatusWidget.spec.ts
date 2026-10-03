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

  it('adopts the shared widget token system for an attention-first command surface', () => {
    // Shared tokens must be pulled via a top-level <link> tag — `@import`
    // inside a <style> block does not survive Claude's MCP Apps sandbox.
    expect(widgetSource).toMatch(/<link[^>]+href=("|')shared\/tokens\.css\1/);
    expect(widgetSource).not.toContain("@import url('./shared/tokens.css');");
    expect(widgetSource).toContain('class="agent-command-shell animate-in"');
    expect(widgetSource).toContain('class="agent-switcher-row"');
    expect(widgetSource).toContain('class="agent-switcher-select"');
    expect(widgetSource).toContain('class="agent-attention app-attention-banner"');
    expect(widgetSource).toContain('class="command-disclosure focusable"');
    expect(widgetSource).toContain('min-height: 44px');
  });

  it('compresses the agent switcher and keeps detail behind one disclosure', () => {
    // A list of rows: each row's select button and the agent's hover card are
    // siblings, so no interactive element nests inside another.
    expect(widgetSource).toContain('<ul class="agent-switcher-list"');
    expect(widgetSource).toContain('aria-pressed="');
    expect(widgetSource).not.toContain('role="tab"');
    expect(widgetSource).toContain('data-action="select-agent"');
    expect(widgetSource).toContain('data-action="toggle-details"');
    expect(widgetSource).toContain('data-action="toggle-idle"');
    expect(widgetSource).toContain('No agents need you right now');
    expect(widgetSource).toContain("event.key !== 'ArrowDown'");
    expect(widgetSource).not.toContain('data-action="toggle-section"');
    expect(widgetSource).not.toContain('class="agent-card app-flat-card"');
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

  it('keeps current and completed work visible with an explicit freshness state', () => {
    expect(widgetSource).toContain('shared/widget-state.js');
    expect(widgetSource).toContain('completedTasks');
    expect(widgetSource).toContain('Completed recently');
    expect(widgetSource).toContain('Last execution needs a refresh');
    expect(widgetSource).toContain("data-tone='done'");
  });
});
