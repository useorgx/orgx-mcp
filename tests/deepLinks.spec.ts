import { describe, expect, it } from 'vitest';

import { buildEntityLink } from '../src/deepLinks';

describe('orgx mcp deep links', () => {
  it('builds task links with initiative context', () => {
    expect(
      buildEntityLink('task', 'task-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/live/initiative-456?task=task-123');
  });

  it('builds milestone links with initiative context', () => {
    expect(
      buildEntityLink('milestone', 'milestone-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/live/initiative-456?milestone=milestone-123');
  });

  it('builds workstream links with initiative context', () => {
    expect(
      buildEntityLink('workstream', 'workstream-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/live/initiative-456?workstream=workstream-123');
  });
});
