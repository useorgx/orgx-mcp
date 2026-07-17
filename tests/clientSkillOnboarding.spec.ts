import { describe, expect, it } from 'vitest';

import {
  buildClientSkillOnboarding,
  resolveSourceClientFromContext,
  resolveSourceClientFromUserAgent,
} from '../src/clientSkillOnboarding';
import { DEFAULT_SKILL_CATALOG } from '../src/skillCatalog';

describe('clientSkillOnboarding', () => {
  it('detects the source client from MCP context', () => {
    expect(
      resolveSourceClientFromContext({
        client: { name: 'Cursor', version: '1.0.0' },
      })
    ).toBe('cursor');
  });

  it('detects Claude Code from the transport user agent', () => {
    expect(
      resolveSourceClientFromUserAgent('claude-code/2.1.211 (sdk-cli)')
    ).toBe('claude');
    expect(resolveSourceClientFromUserAgent('unknown-client/1.0')).toBeNull();
  });

  it('recommends first-use skills for Cursor workflows', () => {
    const onboarding = buildClientSkillOnboarding({
      context: { client: { name: 'Cursor' } },
      skills: [],
      defaultCatalog: DEFAULT_SKILL_CATALOG,
      seededDefaults: false,
    });

    expect(onboarding?.source_client).toBe('cursor');
    expect(onboarding?.first_use).toBe(true);
    expect(onboarding?.suggestions.map((item) => item.skill_name)).toContain(
      'release_readiness_review'
    );
    expect(onboarding?.next_action).toEqual({
      tool: 'list_entities',
      label: 'Seed the default skill catalog',
      args: {
        type: 'skill',
        seed_defaults: true,
      },
    });
  });

  it('prioritizes search-matching skills when the user is looking for launch help', () => {
    const onboarding = buildClientSkillOnboarding({
      context: { client: { name: 'ChatGPT' } },
      search: 'launch readiness',
      skills: [],
      defaultCatalog: DEFAULT_SKILL_CATALOG,
      seededDefaults: true,
    });

    expect(onboarding?.suggestions[0]?.skill_name).toBe(
      'release_readiness_review'
    );
    expect(onboarding?.seeded_defaults).toBe(true);
    expect(onboarding?.next_action).toBeUndefined();
  });
});
