import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson, hashAcceptanceContract } from '../src/dispatchContract';
import fixtures from './fixtures/dispatch-acceptance-serialization-v1.json';

const recipes: Record<string, () => unknown> = {
  undefinedRoot: () => undefined, undefinedObject: () => ({ a: 1, b: undefined }), undefinedArray: () => [undefined, 1],
  nan: () => Number.NaN, infinity: () => Infinity, bigint: () => 1n, function: () => ({ a: () => 1 }),
  cycle: () => { const value: Record<string, unknown> = {}; value.self = value; return value; },
  shared: () => { const value = { a: 1 }; return [value, value]; },
};
describe('historical dispatch serialization v1', () => {
  it.each(fixtures)('$name', async (fixture) => {
    const input = fixture.mode === 'recipe' ? recipes[fixture.recipe!]() : fixture.input;
    let actual;
    try { const material = canonicalJson(input); actual = { ok: true, ...(material === undefined ? { absent: true } : { material, sha256: createHash('sha256').update(material).digest('hex') }) }; }
    catch (error) { actual = { ok: false, name: (error as Error).name }; }
    expect(actual).toEqual(fixture.expected);
    if (fixture.mode === 'json' && Array.isArray(input)) expect(await hashAcceptanceContract(input as never)).toBe(fixture.expected.sha256);
  });
});
