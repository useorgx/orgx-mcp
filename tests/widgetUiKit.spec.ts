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
  it('stays inside the widget size budget', () => {
    // Every MCP Apps payload inlines the kit; keep it well under the host limits.
    expect(statSync(resolve(kitDir, 'ox-elements.js')).size).toBeLessThan(32 * 1024);
    expect(statSync(resolve(kitDir, 'ox-tokens.css')).size).toBeLessThan(12 * 1024);
  });

  it('records which kit build is vendored', () => {
    const version = JSON.parse(readFileSync(resolve(kitDir, 'VERSION.json'), 'utf8'));
    expect(version.package).toBe('@useorgx/orgx-ui-kit');
    expect(version.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(readFileSync(resolve(kitDir, 'ox-elements.js'), 'utf8')).toContain('do not edit');
  });

  it('is inlined into MCP Apps resources, tokens before the widget theme', () => {
    const paths = [...MCP_APPS_SHARED_COMPONENT_PATHS];
    expect(paths).toEqual(expect.arrayContaining(['shared/kit/ox-tokens.css', 'shared/kit/ox-elements.js', 'shared/agent-identity.js']));
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
