import { describe, expect, it } from 'vitest';

import { agentSlug, buildEntityLink, buildLiveUrl, entityLinkMarkdown } from '../src/deepLinks';
import { entityWebUrl } from '../src/entityCard';
import { buildSurfaceMap, ORGX_SURFACES } from '../src/surfaceMap';
import { buildBillingSettingsUrl, buildPricingUrl } from '../src/shared/billingLinks';
import { buildAgentCreditsUrl } from '../src/accountTools';
import { enrichResultWithContext } from '../src/cross-pollination';
import { directHumanDecisionActionRequired } from '../src/directHumanDecisionAction';
import fixture from './fixtures/orgx-app-routes.json';

/**
 * Every useorgx.com URL the server puts in a tool result (structured content
 * or the text the model pastes into chat) must land on a real OrgX app page,
 * directly (not through a redirect), with only query parameters that page
 * reads, the same bar tests/widgetLinks.spec.ts holds the widget link builder
 * to. The route list is generated from the app tree by
 * scripts/generate-app-routes.mjs.
 */
function routePattern(route: string): RegExp {
  const body = route
    .split('/')
    .map((segment) => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return '(?:/.*)?';
      if (/^\[\.\.\..+\]$/.test(segment)) return '/.+';
      if (/^\[.+\]$/.test(segment)) return '/[^/]+';
      return segment ? '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    })
    .join('');
  return new RegExp(`^${body || '/'}$`);
}

const routes = fixture.routes.map((route) => ({ route, pattern: routePattern(route) }));
const redirectSources = fixture.redirects.map((r) => routePattern(r.source.replace(/:(\w+)\*?/g, '[$1]')));

/** The app route a URL lands on, or a reason it does not. `checkQuery: false` checks the page only. */
function resolveRoute(url: string, checkQuery = true): { route?: string; problem?: string } {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://useorgx.com') return { problem: `origin ${parsed.origin}` };
  if (redirectSources.some((p) => p.test(parsed.pathname))) return { problem: `${parsed.pathname} is a redirect source` };
  const matches = routes.filter((r) => r.pattern.test(parsed.pathname));
  const weight = (route: string) => (route.match(/\[/g)?.length ?? 0) + (route.includes('...') ? 10 : 0);
  const match = matches.sort((a, b) => weight(a.route) - weight(b.route))[0];
  if (!match) return { problem: `no app page for ${parsed.pathname}` };
  if (checkQuery) {
    const allowed = (fixture.query as Record<string, string[]>)[match.route] ?? [];
    for (const key of parsed.searchParams.keys()) {
      if (!allowed.includes(key)) return { problem: `${match.route} does not read ?${key}` };
    }
  }
  return { route: match.route };
}

const ID = '7d3f0c2e-5b1a-4c8e-9f21-0a6b3e4d2c11';
const INI = '8a7baebd-2da5-4584-9e32-5b081b830d84';
const RUN = '3c2b1a09-8f7e-4d6c-9b5a-1e2f3a4b5c6d';

const TYPES = [
  'initiative', 'project', 'task', 'milestone', 'workstream', 'objective', 'goal', 'run', 'agent_run',
  'session', 'decision', 'artifact', 'workflow', 'playbook', 'skill', 'plan', 'plan_session',
  'command_center', 'workspace', 'blocker', 'agent', 'live', 'live_ops', 'live_operations', 'unknown_thing',
];

const link = (type: string, id: string, options = {}) => buildEntityLink(type, id, options).url;

const CASES: Array<[string, string, string]> = [
  ['initiative', link('initiative', INI), '/live/[initiativeId]'],
  ['task', link('task', ID), '/tasks/[id]'],
  ['task in its initiative', link('task', ID, { initiativeId: INI }), '/live/[initiativeId]'],
  ['workstream', link('workstream', ID), '/workstreams/[id]'],
  ['workstream in its initiative', link('workstream', ID, { initiativeId: INI }), '/live/[initiativeId]'],
  // was /live/:id?milestone= (the live room has no milestone focus)
  ['milestone in its initiative', link('milestone', ID, { initiativeId: INI }), '/milestones/[id]'],
  ['milestone', link('milestone', ID), '/milestones/[id]'],
  // was /initiatives/:id?focus=decisions&decision=
  ['decision in its initiative', link('decision', ID, { initiativeId: INI }), '/decisions/[id]'],
  ['decision', link('decision', ID), '/decisions/[id]'],
  ['artifact', link('artifact', ID, { initiativeId: INI }), '/artifacts/[artifactId]'],
  // was /agents/runs/:id
  ['run', link('run', ID), '/runs/[runId]'],
  ['agent run', link('agent_run', ID), '/runs/[runId]'],
  // was /agents/sessions/:id
  // was /live?view=mission-control&session= (empty without an initiative)
  ['session', link('session', ID), '/runs'],
  // was /planning/sessions/:id
  ['plan session', link('plan_session', ID), '/runs'],
  ['plan session with initiative', link('plan_session', ID, { initiativeId: INI }), '/initiatives/[id]'],
  // was /settings/agents?agent= (a redirect source)
  ['agent by key', link('agent', 'eli'), '/command/agents/[agentId]'],
  ['agent by role id', link('agent', 'engineering_autopilot'), '/command/agents/[agentId]'],
  ['unknown agent', link('agent', 'Ada'), '/command/agents'],
  // was /settings/goals?objective=
  ['objective', link('objective', ID), '/goals'],
  ['workspace', link('workspace', ID), '/command'],
  // was /agents/runs/:run?blocker= or /blockers/:id
  ['blocker on its run', link('blocker', ID, { runId: RUN }), '/runs/[runId]'],
  ['blocker in its initiative', link('blocker', ID, { initiativeId: INI }), '/live/[initiativeId]'],
  ['blocker', link('blocker', ID), '/command'],
  // was the legacy mission-control view; Runs is the workspace's running work
  ['mission control', link('live', 'default'), '/runs'],
  ['live room', link('live', INI), '/live/[initiativeId]'],
  ['live, initiative option', link('live', 'default', { initiativeId: INI }), '/live/[initiativeId]'],
  ['live url', buildLiveUrl(INI), '/live/[initiativeId]'],
  ['live url, mission control', buildLiveUrl(), '/runs'],
  ['live url, session', buildLiveUrl(undefined, ID), '/runs'],
  // was /live?workspace= (the live view reads ?center=)
  ['live url, workspace', buildLiveUrl(undefined, undefined, { workspace: ID }), '/runs'],
  ['live url, initiative with session', buildLiveUrl(INI, ID), '/live/[initiativeId]'],
];

describe('server deep links', () => {
  it.each(CASES)('%s -> a real app route', (_name, url, route) => {
    expect(resolveRoute(url)).toEqual({ route });
  });

  it('never emits the legacy shapes', () => {
    const all = TYPES.flatMap((type) => [
      link(type, ID),
      link(type, ID, { initiativeId: INI }),
      link(type, ID, { runId: RUN }),
      link(type, ''),
      link(type, '', { initiativeId: INI }),
    ]);
    for (const url of all) {
      const { pathname, search } = new URL(url);
      expect(pathname, url).not.toMatch(/^\/planning\b|^\/settings\/agents|^\/agents\/(runs|sessions)\/|^\/blockers\/|^\/workflows\/|^\/playbooks\//);
      expect(url).not.toMatch(/focus=decisions|artifactId=/);
      if (/^\/live\/[^/]+$/.test(pathname)) expect(search, url).not.toContain('milestone=');
      expect(pathname, url).not.toBe('/');
    }
  });

  it.each(TYPES)('%s: every option combination lands on a real page with only the params it reads', (type) => {
    for (const [id, options] of [
      [ID, {}],
      [ID, { initiativeId: INI }],
      [ID, { runId: RUN }],
      ['', {}],
      ['', { initiativeId: INI }],
    ] as const) {
      const url = link(type, id, options);
      expect(resolveRoute(url).problem, url).toBeUndefined();
    }
  });

  it('matches the widget link builder on the routes both build', () => {
    expect(link('agent', 'Pace')).toBe('https://useorgx.com/command/agents/pace');
    expect(link('run', ID)).toBe(`https://useorgx.com/runs/${ID}`);
    expect(link('milestone', ID, { initiativeId: INI })).toBe(`https://useorgx.com/milestones/${ID}`);
    expect(link('decision', ID, { initiativeId: INI })).toBe(`https://useorgx.com/decisions/${ID}`);
    expect(link('plan_session', ID)).toBe('https://useorgx.com/runs');
    expect(link('decision', '')).toBe('https://useorgx.com/decisions?status=pending');
    expect(agentSlug('design_codex')).toBe('dana');
    expect(agentSlug('Developer')).toBeNull();
  });

  it('keeps markdown links readable', () => {
    expect(entityLinkMarkdown('decision', ID, 'Ship it?')).toBe(`[Ship it?](https://useorgx.com/decisions/${ID})`);
  });

  it('entity card, surface map, related context and human-action links land on real pages', () => {
    for (const type of ['initiative', 'milestone', 'workstream', 'task', 'decision', 'artifact', 'run', 'objective']) {
      const url = entityWebUrl(type, ID)!;
      expect(resolveRoute(url).problem, url).toBeUndefined();
    }
    const surfaces = buildSurfaceMap({ visibleTools: [] });
    expect(surfaces).toHaveLength(ORGX_SURFACES.length);
    for (const surface of surfaces) expect(resolveRoute(surface.url).problem, surface.url).toBeUndefined();
    const related = enrichResultWithContext(
      { ok: true, data: {} } as never,
      { artifacts: [{ id: ID, title: 'Brief', domain: 'marketing', summary: '' }], memories: [], decisions: [] } as never
    ) as { _relatedContext?: { items: Array<{ link: string }> } };
    for (const item of related._relatedContext!.items) expect(resolveRoute(item.link).problem, item.link).toBeUndefined();
    const human = directHumanDecisionActionRequired(ID, 'approve');
    expect(resolveRoute(human.options.details.review_url).problem).toBeUndefined();
  });

  it('billing and pricing links land on real pages (their attribution params are not page reads)', () => {
    for (const url of [
      buildBillingSettingsUrl(null, { section: 'plans', source: 'mcp' }),
      buildPricingUrl(null, { plan: 'pro', source: 'mcp' }),
      buildAgentCreditsUrl(null),
    ]) {
      expect(resolveRoute(url, false).problem, url).toBeUndefined();
    }
  });
});
