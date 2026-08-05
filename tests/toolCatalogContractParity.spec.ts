import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INLINE_TOOL_CONTRACTS } from '../src/contractTools';
import { TOOL_PROFILES } from '../src/toolProfiles';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(
  readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8')
) as {
  tools: Array<{
    id: string;
    securityScopes: string[];
    readOnly: boolean;
    source: string;
    profiles: string[];
  }>;
};

function extractScopes(
  schemes: readonly { type: string; scopes?: readonly string[] }[]
): string[] {
  return schemes.flatMap((scheme) => [...(scheme.scopes ?? [])]);
}

function expectedProfiles(toolId: string): string[] {
  return Object.entries(TOOL_PROFILES)
    .filter(([name, profile]) => {
      if (name === 'full') return false;
      return profile.tools === null || profile.tools.includes(toolId);
    })
    .map(([name]) => name);
}

describe('generated tool catalog contract parity', () => {
  it('keeps review_artifact aligned with its registered inline contract', () => {
    const source = INLINE_TOOL_CONTRACTS.review_artifact;
    const generated = catalog.tools.find((tool) => tool.id === source.id);

    expect(generated).toEqual(
      expect.objectContaining({
        id: source.id,
        securityScopes: extractScopes(source.securitySchemes),
        readOnly: source.annotations.readOnlyHint,
        source: 'inline',
        profiles: expectedProfiles(source.id),
      })
    );
    expect(generated?.securityScopes).toEqual(['initiatives:read']);
    expect(generated?.readOnly).toBe(true);
    expect(generated?.profiles).toContain('chatgpt');
    expect(generated?.profiles).not.toContain('memory');
  });
});
