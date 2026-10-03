import { describe, expect, it } from 'vitest';

import { buildEntityLink, buildLiveUrl, getEntityPath } from '../src/deepLinks';
import { resolveRoute } from './fixtures/orgxAppRoutes';

const ID = '11111111-1111-4111-8111-111111111111';
const INIT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

const ENTITY_TYPES = [
  'initiative',
  'project',
  'workstream',
  'task',
  'milestone',
  'decision',
  'artifact',
  'run',
  'agent_run',
  'session',
  'blocker',
  'agent',
  'plan_session',
  'objective',
  'workspace',
  'command_center',
  'live',
  'workflow',
  'playbook',
  'skill',
  'something_new',
];

const CONTEXTS = [
  {},
  { initiativeId: INIT },
  { runId: RUN },
  { initiativeId: INIT, runId: RUN },
];

describe('deep links land on real OrgX app pages', () => {
  const cases: Array<[string, string]> = [];
  for (const type of ENTITY_TYPES) {
    for (const ctx of CONTEXTS) {
      cases.push([`${type} ${JSON.stringify(ctx)}`, getEntityPath(type, ID, ctx)]);
    }
  }
  for (const agent of ['pace', 'Eli', 'engineering', 'engineering_autopilot', ID]) {
    cases.push([`agent ${agent}`, getEntityPath('agent', agent)]);
  }
  cases.push(['live default', getEntityPath('live', 'default')]);
  cases.push(['buildLiveUrl()', buildLiveUrl()]);
  cases.push(['buildLiveUrl(init)', buildLiveUrl(INIT)]);
  cases.push(['buildLiveUrl(init, session)', buildLiveUrl(INIT, ID)]);
  cases.push(['buildLiveUrl(-, session)', buildLiveUrl(undefined, ID)]);
  cases.push(['buildLiveUrl(workspace)', buildLiveUrl(undefined, undefined, { workspace: ID })]);

  it.each(cases)('%s -> %s', (_label, url) => {
    expect(resolveRoute(new URL(url, 'https://useorgx.com').toString()).problem).toBeUndefined();
  });
});

describe('deep link mapping', () => {
  const url = (type: string, id: string, opts = {}) => buildEntityLink(type, id, opts).url;

  it('maps each entity to its canonical page', () => {
    expect(url('initiative', ID)).toBe(`https://useorgx.com/initiatives/${ID}`);
    expect(url('workstream', ID)).toBe(`https://useorgx.com/workstreams/${ID}`);
    expect(url('task', ID)).toBe(`https://useorgx.com/tasks/${ID}`);
    expect(url('milestone', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/milestones/${ID}`);
    expect(url('decision', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/decisions/${ID}`);
    expect(url('artifact', ID)).toBe(`https://useorgx.com/artifacts/${ID}`);
    expect(url('run', ID)).toBe(`https://useorgx.com/runs/${ID}`);
    expect(url('agent', 'eli')).toBe('https://useorgx.com/command/agents/eli');
    expect(url('agent', 'marketing')).toBe('https://useorgx.com/command/agents/mark');
    expect(url('agent', 'engineering_autopilot')).toBe('https://useorgx.com/command/agents/eli');
    expect(url('session', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/live?view=mission-control&session=${ID}`);
    expect(url('agent', ID)).toBe('https://useorgx.com/command/agents');
    expect(url('plan_session', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/initiatives/${INIT}`);
    expect(url('plan_session', ID)).toBe(`https://useorgx.com/live?view=mission-control&session=${ID}`);
    expect(url('objective', ID)).toBe(`https://useorgx.com/goals?objective=${ID}`);
    expect(url('workspace', ID)).toBe(`https://useorgx.com/command?center=${ID}`);
    expect(url('live', INIT)).toBe(`https://useorgx.com/live/${INIT}`);
  });

  it('opens workstreams and tasks in the live room when the initiative is known', () => {
    expect(url('workstream', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/live/${INIT}?workstream=${ID}`);
    expect(url('task', ID, { initiativeId: INIT })).toBe(`https://useorgx.com/live/${INIT}?task=${ID}`);
  });

  it('falls back to /command for types without a page', () => {
    for (const type of ['workflow', 'playbook', 'skill', 'something_new']) {
      expect(url(type, ID)).toBe('https://useorgx.com/command');
      expect(url(type, ID, { initiativeId: INIT })).toBe(`https://useorgx.com/live/${INIT}`);
    }
  });
});

describe('route matcher', () => {
  it.each([
    `https://useorgx.com/planning/sessions/${ID}`,
    `https://useorgx.com/agents/sessions/${ID}`,
    `https://useorgx.com/blockers/${ID}`,
    `https://useorgx.com/workflows/${ID}`,
    `https://useorgx.com/settings/agents?agent=${ID}`,
    `https://useorgx.com/initiatives/${INIT}?focus=decisions&decision=${ID}`,
    `https://useorgx.com/live/${INIT}?milestone=${ID}`,
    `https://useorgx.com/live/${INIT}?session=${ID}`,
    `https://useorgx.com/live?view=mission-control&workspace=${ID}`,
  ])('flags the legacy link %s', (legacy) => {
    expect(resolveRoute(legacy).problem).toBeDefined();
  });
});
