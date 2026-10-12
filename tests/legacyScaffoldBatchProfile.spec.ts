import { expect, it } from 'vitest';
import { getLegacyScaffoldBatchNodeShapeIssue } from '../src/generated/legacyScaffoldBatchProfile';
import fixtures from './fixtures/legacy-scaffold-batch-profile-v1.json';
it.each(fixtures)('finite profile wire compatibility: $name', fixture => {
  const input = structuredClone(fixture.node);
  expect(getLegacyScaffoldBatchNodeShapeIssue(input)).toEqual(fixture.issue);
  expect(input).toEqual(fixture.node);
});
