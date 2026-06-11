import { describe, expect, it } from 'vitest';

import { DEFAULT_SKILL_CATALOG } from '../src/skillCatalog';

const ALL_AGENT_DOMAINS = [
  'product',
  'engineering',
  'marketing',
  'sales',
  'design',
  'operations',
  'orchestrator',
];

describe('founder/team artifact catalog', () => {
  it('keeps a practical founder/team artifact contract available to every agent', () => {
    const skill = DEFAULT_SKILL_CATALOG.find(
      (entry) => entry.name === 'founder_team_artifact_contract'
    );

    expect(skill).toBeDefined();
    expect(skill?.trigger_domains).toEqual(ALL_AGENT_DOMAINS);

    const catalogText = [
      skill?.description,
      skill?.prompt_template,
      ...(skill?.trigger_keywords ?? []),
      ...(skill?.checklist ?? []),
    ]
      .join(' ')
      .toLowerCase();

    for (const expected of [
      'early founder',
      'operating team',
      'next valuable initiative',
      'engineering pr',
      'sales strategy',
      'conversion gates',
      'customer discovery',
      'proof distribution',
      'interview/pr',
      'pricing',
      'weekly operator brief',
      'budget',
      'business outcome',
      'verification receipt',
    ]) {
      expect(catalogText).toContain(expected);
    }
  });

  it('requires specialist completion receipts to cover business outcomes and orchestrator handoffs', () => {
    const skill = DEFAULT_SKILL_CATALOG.find(
      (entry) => entry.name === 'agent_output_contract'
    );

    expect(skill).toBeDefined();
    expect(skill?.trigger_domains).toEqual(ALL_AGENT_DOMAINS);

    const contractText = [
      skill?.description,
      skill?.prompt_template,
      ...(skill?.trigger_keywords ?? []),
      ...(skill?.checklist ?? []),
    ]
      .join(' ')
      .toLowerCase();

    for (const expected of [
      'pr url',
      'sales strategy',
      'orchestrator',
      'next initiative',
      'acceptance gates',
      'business outcome',
      'verification evidence',
      'structured blocker',
    ]) {
      expect(contractText).toContain(expected);
    }
  });

  it('keeps loop validation grounded in cheapest-valid verification before autonomy expands', () => {
    const skill = DEFAULT_SKILL_CATALOG.find(
      (entry) => entry.name === 'loop_reliability_validation'
    );

    expect(skill).toBeDefined();
    expect(skill?.trigger_domains).toEqual(ALL_AGENT_DOMAINS);

    const validationText = [
      skill?.description,
      skill?.prompt_template,
      ...(skill?.trigger_keywords ?? []),
      ...(skill?.checklist ?? []),
    ]
      .join(' ')
      .toLowerCase();

    for (const expected of [
      'schema/discovery',
      'dry-run spawn',
      'single-domain fixture',
      'cross-domain initiative fixture',
      'overnight canary',
      'model_tier=standard',
      'budget_mode=cheapest_valid',
      'artifact_type',
      'business_outcome',
      'verification_status',
      'spend',
      'promotion criteria',
    ]) {
      expect(validationText).toContain(expected);
    }
  });
});
