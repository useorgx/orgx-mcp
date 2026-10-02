// @vitest-environment jsdom
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MCP_APPS_SHARED_COMPONENT_PATHS } from '../src/widgetConfig';
import '../public/widgets/shared/agent-identity.js';

const kitDir = resolve(__dirname, '../public/widgets/shared/kit');
const identity = (window as unknown as {
  OrgXAgentIdentity: {
    resolveAgentKey(...values: unknown[]): string | null;
    formForState(state: string): string;
  };
}).OrgXAgentIdentity;

describe('vendored OrgX design kit', () => {
  // Vendored bundle -> max bytes (the kit's own budgets plus the sync header).
  // Every MCP Apps payload inlines the bundles it uses; per-widget totals are
  // budgeted in tests/widgetPayloadBudget.spec.ts.
  const BUNDLES: Record<string, number> = {
    'ox-elements.js': 26 * 1024,
    'ox-elements-core.js': 12 * 1024,
    'ox-elements-footer.js': 10.5 * 1024,
    'ox-elements-glyph.js': 3 * 1024,
    'ox-elements-avatar.js': 3 * 1024,
  };

  it('stays inside the widget size budget', () => {
    for (const [file, max] of Object.entries(BUNDLES)) expect(statSync(resolve(kitDir, file)).size, file).toBeLessThan(max);
    expect(statSync(resolve(kitDir, 'ox-tokens.css')).size).toBeLessThan(12 * 1024);
  });

  it('records which kit build is vendored', () => {
    const version = JSON.parse(readFileSync(resolve(kitDir, 'VERSION.json'), 'utf8'));
    expect(version.package).toBe('@useorgx/orgx-ui-kit');
    expect(version.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const file of Object.keys(BUNDLES)) {
      const body = readFileSync(resolve(kitDir, file), 'utf8');
      expect(body, file).toContain('do not edit');
      expect(body, file).toContain(`(${version.commit})`);
    }
  });

  it('is inlined into MCP Apps resources, tokens before the widget theme', () => {
    const paths = [...MCP_APPS_SHARED_COMPONENT_PATHS];
    expect(paths).toEqual(
      expect.arrayContaining([
        'shared/kit/ox-tokens.css',
        ...Object.keys(BUNDLES).map((f) => `shared/kit/${f}`),
        'shared/agent-identity.js',
      ]),
    );
    const decisions = readFileSync(resolve(__dirname, '../public/widgets/decisions.html'), 'utf8');
    expect(decisions.indexOf('shared/kit/ox-tokens.css')).toBeLessThan(decisions.indexOf('shared/widget-foundation.css'));
  });
});

describe('agent identity', () => {
  it.each([
    ['Pace - Product', 'pace'],
    ['engineering-agent', 'eli'],
    ['Mark', 'mark'],
    ['sales', 'sage'],
    ['Orion (Operations)', 'orion'],
    ['design_codex', 'dana'],
    ['Xandy', 'xandy'],
  ])('maps %s to %s', (value, key) => {
    expect(identity.resolveAgentKey(value)).toBe(key);
  });

  it.each(['Developer', 'Scope review', 'OrgX System', '', null])('does not guess an agent for %s', (value) => {
    expect(identity.resolveAgentKey(value)).toBeNull();
  });

  it('falls through to the next candidate', () => {
    expect(identity.resolveAgentKey(null, 'unknown', 'design')).toBe('dana');
  });

  it('picks the avatar form from the action state', () => {
    expect(identity.formForState('needs_you')).toBe('asking');
    expect(identity.formForState('running')).toBe('working');
    expect(identity.formForState('verifying')).toBe('verifying');
    expect(identity.formForState('anything-else')).toBe('base');
  });
});
