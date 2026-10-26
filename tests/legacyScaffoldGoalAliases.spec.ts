import { expect, it } from 'vitest';
import { normalizeScaffoldObjectiveAliases } from '../src/scaffoldControl';
import fixtures from './fixtures/legacy-scaffold-goal-alias-v1.json';
it.each(fixtures)('preserves original alias precedence and diagnostics: $name', fixture => { const input = structuredClone(fixture.input); expect(normalizeScaffoldObjectiveAliases(input)).toEqual(fixture.expected); expect(input).toEqual(fixture.input); });
