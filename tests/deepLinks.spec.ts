import { describe, expect, it } from 'vitest';

import { buildEntityLink } from '../src/deepLinks';

describe('orgx mcp deep links', () => {
  it('opens an initiative in its live room, or its own page for a member', () => {
    expect(buildEntityLink('initiative', 'init-1').url).toBe('https://useorgx.com/live/init-1');
    expect(buildEntityLink('initiative', 'init-1', { audience: 'internal' }).url).toBe('https://useorgx.com/initiatives/init-1');
    expect(buildEntityLink('initiative', '', { audience: 'internal' }).url).toBe('https://useorgx.com/initiatives');
  });

  it('builds task links with initiative context', () => {
    expect(
      buildEntityLink('task', 'task-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/live/initiative-456?task=task-123');
  });

  it('builds milestone links with initiative context', () => {
    // The live room has no milestone focus (?milestone= was ignored there): the milestone page.
    expect(
      buildEntityLink('milestone', 'milestone-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/milestones/milestone-123');
  });

  it('builds workstream links with initiative context', () => {
    expect(
      buildEntityLink('workstream', 'workstream-123', {
        initiativeId: 'initiative-456',
      }).url
    ).toBe('https://useorgx.com/live/initiative-456?workstream=workstream-123');
  });
});
