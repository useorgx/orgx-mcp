import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readWidget(name: string) {
  return readFileSync(resolve(process.cwd(), `public/widgets/${name}.html`), 'utf8');
}

describe('widget disclosure UX', () => {
  it('updates Morning Brief disclosures without replacing the focused trigger', () => {
    const source = readWidget('morning-brief');

    expect(source).toContain('function setActiveSection(section, options = {})');
    expect(source).toContain('aria-expanded="${');
    expect(source).toContain('aria-controls="panel-priorities"');
    expect(source).toContain('role="region"');
    expect(source).toContain(
      "setActiveSection(trigger.dataset.section || state.activeSection, { scroll: true });"
    );
  });

  it('restores focus after Agent Status disclosures rerender', () => {
    const source = readWidget('agent-status');

    expect(source).toContain("document.querySelector('[data-action=\"toggle-idle\"]')");
    expect(source).toContain("'[data-action=\"toggle-details\"][data-agent=\"' + CSS.escape(agentId)");
    expect(source).toContain('if (nextTrigger) nextTrigger.focus();');
  });

  it('preserves focus when Initiative Pulse panels change', () => {
    const source = readWidget('initiative-pulse');

    expect(source).toContain('window.togglePulsePanel = function (panel, trigger)');
    expect(source).toContain("togglePulsePanel(\\'actions\\', this)");
    expect(source).toContain('trigger.focus();');
  });

  it('connects decision rejection triggers to their disclosure panels', () => {
    const source = readWidget('decisions');

    expect(source).toContain('data-action="toggle-reject"');
    expect(source).toContain('aria-controls="reject-composer-${escapeHtml(d.id)}"');
    expect(source).toContain('id="reject-composer-${escapeHtml(d.id)}"');
    expect(source).toContain('(nextTrigger || trigger)?.focus();');
  });

  it('keeps scaffold walkthrough controls touch-sized', () => {
    const source = readWidget('scaffolded-initiative');

    expect(source).toMatch(/\.scaffold-state__dot\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
    expect(source).toContain('.scaffold-state__dot::before');
  });

  it('requires an explicit live scaffold stream before connecting', () => {
    const source = readWidget('scaffold-streaming');

    expect(source).toContain("var _live = _params.get('live') === 'true';");
    expect(source).toContain('} else if (_live) {');
    expect(source).toContain('showIdleState();');
  });

  it('keeps Initiative Pulse recovery actions touch-sized', () => {
    const source = readWidget('initiative-pulse');

    expect(source).toMatch(/\.deep-link\s*\{[\s\S]*?min-height:\s*44px;/);
  });
});
