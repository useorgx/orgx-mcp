import { describe, expect, it, vi } from 'vitest';
import { buildScaffoldInitiativeBatch } from '../src/scaffoldInitiative';
import { normalizeSuggestedChecks } from '../src/expectations';
import { buildLegacyScaffoldInitiativeBatch } from '../src/generated/legacyScaffoldPlan';
import fixtures from './fixtures/legacy-scaffold-plan-v1.json';

describe('canonical legacy scaffold preparation', () => {
  it.each(fixtures)('$name', ({ input, expected }) => {
    expect(JSON.parse(JSON.stringify(buildScaffoldInitiativeBatch(input)))).toEqual(expected);
    expect(JSON.parse(JSON.stringify(buildLegacyScaffoldInitiativeBatch(input, normalizeSuggestedChecks)))).toEqual(expected);
  });
  it('keeps producer-check parsing an explicit adapter callback', () => {
    const check = { statement: 'Sanitized producer suggestion', verify: 'command', required: false };
    const normalize = vi.fn(() => [check]);
    const result = buildLegacyScaffoldInitiativeBatch({ title: 'Offline', workstreams: [{ title: 'Engineering', suggested_checks: 'raw proposal', milestones: [{ title: 'M', tasks: [{ title: 'T' }] }] }] }, normalize);
    expect(normalize).toHaveBeenCalledWith('raw proposal');
    expect(result.batch.find(x => x.type === 'workstream')?.metadata).toMatchObject({ suggested_checks: [check] });
    expect(result.batch.every(x => !('accepted' in x) && !('authorized' in x))).toBe(true);
  });
});
