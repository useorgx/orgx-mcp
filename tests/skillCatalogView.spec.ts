import { describe, expect, it } from 'vitest';

import { DEFAULT_SKILL_CATALOG } from '../src/skillCatalog';
import { buildSkillCatalogView } from '../src/skillCatalogView';

describe('skillCatalogView', () => {
  it('shows installed and available default skills in one catalog view', () => {
    const result = buildSkillCatalogView({
      skills: [
        {
          id: 'skill-1',
          name: 'initiative_breakdown',
          title: 'Initiative Breakdown',
          description: 'Installed version',
          trigger_keywords: ['initiative'],
          trigger_domains: ['product'],
          _link: 'https://useorgx.com/skill/skill-1',
        },
      ],
      defaultCatalog: DEFAULT_SKILL_CATALOG,
    });

    expect(result.installed_count).toBe(1);
    expect(result.available_count).toBe(DEFAULT_SKILL_CATALOG.length);
    expect(
      result.entries.find((entry) => entry.name === 'initiative_breakdown')
    ).toMatchObject({
      id: 'skill-1',
      installed: true,
      available_to_seed: false,
      _link: 'https://useorgx.com/skill/skill-1',
    });
    expect(
      result.entries.find(
        (entry) => entry.name === 'release_readiness_review'
      )
    ).toMatchObject({
      installed: false,
      available_to_seed: true,
      source_type: 'seed_catalog',
    });
  });

  it('filters available skills by search relevance', () => {
    const result = buildSkillCatalogView({
      skills: [],
      defaultCatalog: DEFAULT_SKILL_CATALOG,
      search: 'launch readiness',
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.name).toBe('release_readiness_review');
    expect(
      result.entries.every((entry) => entry.name !== 'incident_triage')
    ).toBe(true);
  });
});
