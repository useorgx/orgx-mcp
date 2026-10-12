/** Verify compiled canonical/client vocabularies and the enum used by tool definitions. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const { build } = createRequire(localRequire.resolve('vite/package.json'))('esbuild');

export function verifyEntityTypeCatalog({ canonical, client, definitions }, catalog) {
  const types = client.ENTITY_TYPES;
  assert.ok(Array.isArray(types) && types.length >= 15, 'Entity type count too low (minimum 15), possible drift');
  assert.equal(new Set(types).size, types.length, 'Entity types must be unique');
  assert.ok(types.every(type => typeof type === 'string' && /^[a-z_]+$/.test(type)), 'Entity type catalog contains invalid values');
  assert.deepEqual(types, canonical.ENTITY_TYPES, 'Client entity vocabulary differs from the canonical contract');
  assert.deepEqual(definitions.ENTITY_TYPES, types, 'Tool definitions lost canonical entity types');
  assert.deepEqual(definitions.entityTypeEnum.options, types, 'Compiled tool enum lost entity types');
  for (const type of types) {
    assert.ok(client.isEntityType(type), `Runtime vocabulary refuses ${type}`);
    assert.ok(definitions.entityTypeEnum.safeParse(type).success, `Compiled tool enum refuses ${type}`);
  }
  assert.equal(client.isEntityType('unknown_entity_type'), false, 'Runtime vocabulary must reject unknown entity types');
  assert.equal(definitions.entityTypeEnum.safeParse('unknown_entity_type').success, false, 'Compiled enum must reject unknown entity types');
  for (const id of ['create_entity', 'list_entities']) {
    const tool = catalog.tools?.find(tool => tool.id === id);
    assert.ok(tool?.inputSchema?.properties?.type?.type === 'string', `${id} entity input contract is missing`);
    const allowed = tool.inputSchema.properties.type.enum;
    if (allowed) for (const type of types) assert.ok(allowed.includes(type), `${id} catalog omits ${type}`);
  }
  return types;
}

export async function checkCompiledEntityTypeCatalog(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const imports = ['generated/entityVocabulary', 'shared/entity', 'toolDefinitions'].map(path => JSON.stringify(resolve(root, `src/${path}.ts`)));
  const bundled = await build({ stdin: { contents: `import * as canonical from ${imports[0]}; import * as client from ${imports[1]}; import * as definitions from ${imports[2]}; export { canonical, client, definitions };`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const compiled = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const catalog = JSON.parse(readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8'));
  return verifyEntityTypeCatalog(compiled, catalog);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const types = await checkCompiledEntityTypeCatalog();
  console.log(`Compiled entity catalog is consistent (${types.length} types; minimum 15): ${types.join(', ')}`);
}
