import { describe, expect, it } from 'vitest';

import {
  PLAN_SESSION_ACCEPTED_ID_FORMS,
  buildCanonicalPlanSessionRef,
  enrichPlanSessionResult,
  normalizePlanSessionId,
} from '../src/planSessionContract';

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('plan session contract helpers', () => {
  it('normalizes plain UUIDs and OrgX URIs', () => {
    expect(normalizePlanSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(
      normalizePlanSessionId(`orgx://plan_session/${SESSION_ID}`)
    ).toBe(SESSION_ID);
  });

  it('normalizes object payloads containing session references', () => {
    expect(normalizePlanSessionId({ session_id: SESSION_ID })).toBe(SESSION_ID);
    expect(normalizePlanSessionId({ uri: `orgx://plan_session/${SESSION_ID}` })).toBe(
      SESSION_ID
    );
  });

  it('builds canonical refs with accepted ID forms', () => {
    expect(buildCanonicalPlanSessionRef(SESSION_ID)).toEqual({
      id: SESSION_ID,
      uuid: SESSION_ID,
      uri: `orgx://plan_session/${SESSION_ID}`,
      accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
    });
  });

  it('enriches start_plan_session and get_active_sessions payloads', () => {
    const started = enrichPlanSessionResult('start_plan_session', {
      id: SESSION_ID,
      title: 'Feature plan',
    });
    expect(started).toMatchObject({
      session_id: SESSION_ID,
      uuid: SESSION_ID,
      uri: `orgx://plan_session/${SESSION_ID}`,
    });

    const listed = enrichPlanSessionResult('get_active_sessions', {
      sessions: [{ id: SESSION_ID, title: 'Feature plan' }],
    });
    expect(listed).toMatchObject({
      accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
    });
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        session_id: SESSION_ID,
        uri: `orgx://plan_session/${SESSION_ID}`,
      }),
    ]);
  });
});
