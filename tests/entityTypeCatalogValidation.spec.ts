import { describe, expect, it } from 'vitest';
import * as canonical from '../src/generated/entityVocabulary';
import * as client from '../src/shared/entity';
import * as definitions from '../src/toolDefinitions';
import { readFileSync } from 'node:fs';
import { checkCompiledEntityTypeCatalog, verifyEntityTypeCatalog } from '../scripts/check-entity-type-catalog.mjs';
const catalog = JSON.parse(readFileSync('docs/generated/tool-catalog.json', 'utf8'));
describe('contract workflow compiled entity catalog', () => {
  it('follows reexports and verifies the current compiled 20-type catalog', async () => {
    expect(await checkCompiledEntityTypeCatalog()).toEqual(canonical.ENTITY_TYPES);
    expect(canonical.ENTITY_TYPES).toHaveLength(20);
    expect(client.ENTITY_TYPES).toBe(canonical.ENTITY_TYPES);
  });
  it('rejects an actually emptied facade while preserving the minimum 15', () => {
    expect(() => verifyEntityTypeCatalog({ canonical, definitions, client: { ...client, ENTITY_TYPES: ['workspace'] } }, catalog)).toThrow(/minimum 15/);
  });
  it('rejects missing compiled enum members even when the tuple remains populated', () => {
    expect(() => verifyEntityTypeCatalog({ canonical, client, definitions: { ...definitions, entityTypeEnum: { ...definitions.entityTypeEnum, options: canonical.ENTITY_TYPES.slice(1) } } }, catalog)).toThrow(/Compiled tool enum lost/);
  });
  it('rejects generated catalog loss for a required entity tool', () => {
    expect(() => verifyEntityTypeCatalog({ canonical, client, definitions }, { tools: catalog.tools.filter((tool: { id: string }) => tool.id !== 'create_entity') })).toThrow(/create_entity entity input/);
  });
  it('rejects a restrictive catalog enum omitting a canonical entity type', () => {
    const partial = structuredClone(catalog); partial.tools.find((tool: { id: string }) => tool.id === 'create_entity').inputSchema.properties.type.enum = ['workspace'];
    expect(() => verifyEntityTypeCatalog({ canonical, client, definitions }, partial)).toThrow(/catalog omits/);
  });
});
