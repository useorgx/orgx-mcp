import { describe, expect, it } from 'vitest';
import * as entity from '../src/shared/entity';
import * as canonical from '../src/generated/entityVocabulary';
import fixtures from './fixtures/entity-vocabulary-v1.json';

describe('entity vocabulary compatibility', () => {
  it.each(fixtures)('$name', (fixture) => {
    expect(entity.normalizeEntityType(fixture.input)).toBe(fixture.normalized);
    expect(entity.isEntityType(fixture.input)).toBe(fixture.entity);
    expect(entity.isLifecycleEntityType(fixture.input)).toBe(fixture.mcpLifecycle);
    expect(canonical.normalizeEntityType(fixture.input)).toBe(fixture.normalized);
    expect(canonical.isEntityType(fixture.input)).toBe(fixture.entity);
    expect(canonical.isLifecycleEntityType(fixture.input)).toBe(fixture.domainLifecycle);
  });
  it('retains workspace lifecycle routing at the MCP edge', () => {
    expect(entity.LIFECYCLE_ENTITY_TYPES).toEqual(['workspace', 'initiative', 'milestone', 'workstream', 'task', 'objective', 'playbook', 'decision', 'stream', 'studio_content']);
    expect(entity.isLifecycleEntityType(' WORKSPACE ')).toBe(true);
    expect(canonical.isLifecycleEntityType(' WORKSPACE ')).toBe(false);
    for (const key of Object.keys(canonical) as (keyof typeof canonical)[]) {
      if (!key.startsWith('LIFECYCLE_') && key !== 'isLifecycleEntityType') {
        expect(entity[key]).toBe(canonical[key]);
      }
    }
  });
});
