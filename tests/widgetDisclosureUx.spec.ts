import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readWidget(name: string) {
  return readFileSync(resolve(process.cwd(), `public/widgets/${name}.html`), 'utf8');
}

describe('widget disclosure UX', () => {
  it('lets the default Agent Status section close on the first click', () => {
    const source = readWidget('agent-status');

    expect(source).toContain("var currentSection = Object.prototype.hasOwnProperty.call(widgetState, cardId)");
    expect(source).toContain("widgetState[cardId] = currentSection === section ? null : section;");
    expect(source).toContain('trigger.focus();');
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
});
