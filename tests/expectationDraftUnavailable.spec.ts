import { expect, it, vi } from 'vitest';

vi.mock('../src/orgxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orgxApi')>();
  return {
    ...actual,
    callOrgxApiJson: vi.fn(async () => {
      throw new actual.OrgXApiError('Not found', 'API 404 from https://x/api/expectations/draft', 404);
    }),
  };
});

import { draftPlanExpectations, draftInitiativeExpectations } from '../src/scaffoldFollowups';

it('an app that cannot draft a bar is no bar, not an error', async () => {
  const batch = [{ type: 'initiative', ref: 'init', title: 'Launch' }];
  expect(await draftPlanExpectations({ env: {} as never, workspaceId: 'ws', batch, actorUserId: null, userEmail: null })).toBeNull();
  expect(await draftInitiativeExpectations({ env: {} as never, initiativeId: 'i-1', actorUserId: null, userEmail: null })).toBeNull();
});
