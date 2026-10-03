// @vitest-environment jsdom

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../public/widgets/shared/agent-identity.js';
import '../public/widgets/shared/widget-runtime.js';
import fixture from './fixtures/orgx-app-routes.json';

/**
 * Every URL the widget link builder produces must land on a real OrgX app
 * page, directly (not through a redirect), with only query parameters that
 * page reads. The route list is generated from the app tree by
 * scripts/generate-app-routes.mjs (ORGX_APP_DIR=../orgx/orgx).
 */
type Links = Record<string, (...args: unknown[]) => string> & { origin: string };
const runtime = (window as unknown as { OrgXWidgetRuntime: { links: Links; __resetForTests(): void } }).OrgXWidgetRuntime;
const links = runtime.links;

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

/** The app route a URL lands on, or a reason it does not. */
function resolveRoute(url: string): { route?: string; problem?: string } {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://useorgx.com') return { problem: `origin ${parsed.origin}` };
  if (redirectSources.some((p) => p.test(parsed.pathname))) return { problem: `${parsed.pathname} is a redirect source` };
  // Static segments beat dynamic ones (Next.js precedence).
  const matches = routes.filter((r) => r.pattern.test(parsed.pathname));
  const weight = (route: string) => (route.match(/\[/g)?.length ?? 0) + (route.includes('...') ? 10 : 0);
  const match = matches.sort((a, b) => weight(a.route) - weight(b.route))[0];
  if (!match) return { problem: `no app page for ${parsed.pathname}` };
  const allowed = (fixture.query as Record<string, string[]>)[match.route] ?? [];
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.includes(key)) return { problem: `${match.route} does not read ?${key}` };
  }
  return { route: match.route };
}

const ID = '7d3f0c2e-5b1a-4c8e-9f21-0a6b3e4d2c11';
const INI = '8a7baebd-2da5-4584-9e32-5b081b830d84';

const CASES: Array<[string, string, string]> = [
  ['initiative', links.initiative(INI), '/initiatives/[id]'],
  ['initiatives index', links.initiative(''), '/initiatives'],
  ['live room', links.live(INI), '/live/[initiativeId]'],
  ['live room focused on a task', links.live(INI, { task: ID }), '/live/[initiativeId]'],
  ['live room focused on a decision', links.live(INI, { decision: ID }), '/live/[initiativeId]'],
  ['live room focused on an artifact', links.live(INI, { artifact: ID }), '/live/[initiativeId]'],
  ['mission control', links.live(), '/live'],
  ['mission control focused on a milestone', links.live(null, { milestone: ID }), '/live'],
  ['mission control focused on a run', links.live(null, { run: ID }), '/live'],
  ['workstream', links.workstream(ID), '/workstreams/[id]'],
  ['workstream in its initiative', links.workstream(ID, { initiativeId: INI }), '/live/[initiativeId]'],
  ['milestone', links.milestone(ID), '/milestones/[id]'],
  ['task', links.task(ID), '/tasks/[id]'],
  ['task in its initiative', links.task(ID, { initiativeId: INI }), '/live/[initiativeId]'],
  ['decision', links.decision(ID), '/decisions/[id]'],
  ['decisions queue', links.decisions(), '/decisions'],
  ['artifact', links.artifact(ID), '/artifacts/[artifactId]'],
  ['artifact without id', links.artifact(''), '/workspace-hub'],
  ['run', links.run(ID), '/runs/[runId]'],
  ['agent by key', links.agent('eli'), '/command/agents/[agentId]'],
  ['agent by domain', links.agent('Engineering'), '/command/agents/[agentId]'],
  ['unknown agent', links.agent('Ada'), '/command/agents'],
  ['plan session', links.planSession(ID), '/live'],
  ['plan session with initiative', links.planSession(ID, { initiativeId: INI }), '/initiatives/[id]'],
  ['search', links.search('pricing'), '/command'],
  ['decision search', links.search('pricing', { type: 'decision' }), '/decisions'],
  ['command', links.command(), '/command'],
  ['command in a workspace', links.command({ center: ID }), '/command'],
  ['goal', links.goal(ID, { center: ID }), '/goals'],
  ['work ledger', links.workLedger(), '/work-ledger'],
];

describe('widget link builder', () => {
  afterEach(() => {
    delete (window as unknown as { openai?: unknown }).openai;
    runtime.__resetForTests();
  });

  it('uses https://useorgx.com', () => {
    expect(links.origin).toBe('https://useorgx.com');
  });

  it.each(CASES)('%s -> a real app route', (_name, url, route) => {
    expect(resolveRoute(url)).toEqual({ route });
  });

  it('builds the agent desk from the agent key', () => {
    expect(links.agent('engineering_autopilot')).toBe('https://useorgx.com/command/agents/eli');
    expect(links.agent('Pace')).toBe('https://useorgx.com/command/agents/pace');
  });

  it('dispatches entity types to the same builders', () => {
    for (const type of ['initiative', 'workstream', 'milestone', 'task', 'decision', 'artifact', 'run', 'agent_run', 'agent', 'plan_session', 'objective', 'workspace', 'unknown']) {
      const url = links.entity(type, ID);
      expect(resolveRoute(url).problem, `${type}: ${url}`).toBeUndefined();
    }
    expect(links.entity('Task', ID, { initiativeId: INI })).toBe(links.task(ID, { initiativeId: INI }));
  });

  it('encodes ids and skips empty query values', () => {
    expect(links.task('a/b c')).toBe('https://useorgx.com/tasks/a%2Fb%20c');
    expect(links.live(INI, { task: '', workstream: undefined })).toBe(`https://useorgx.com/live/${INI}`);
  });

  it.each([
    ['/decisions/' + ID, links.decision(ID)],
    [`https://useorgx.com/settings/agents?agent=eli`, links.agent('eli')],
    [`https://useorgx.com/planning/sessions/${ID}`, links.planSession(ID)],
    ['https://useorgx.com/planning', links.live()],
    [`https://useorgx.com/agents/runs/${ID}`, links.run(ID)],
    [`https://useorgx.com/initiatives/${INI}?focus=decisions&decision=${ID}`, links.decision(ID)],
    [`https://useorgx.com/live/${INI}?milestone=${ID}`, links.milestone(ID)],
    [`https://useorgx.com/live/${INI}?artifactId=${ID}`, links.artifact(ID)],
    [`https://www.useorgx.com/live/${INI}?task=${ID}`, links.task(ID, { initiativeId: INI })],
  ])('normalizes legacy or relative %s', (input, expected) => {
    expect(links.normalize(input)).toBe(expected);
    expect(resolveRoute(links.normalize(input)).problem).toBeUndefined();
  });

  it('refuses anything that is not an OrgX (or GitHub) https URL', () => {
    for (const bad of ['javascript:alert(1)', 'http://useorgx.com/command', '//evil.test/x', 'https://evil.test/command', 'not a url', '']) {
      expect(links.normalize(bad)).toBe('');
    }
    expect(links.normalize('https://github.com/useorgx/orgx-mcp/pull/1')).toBe('https://github.com/useorgx/orgx-mcp/pull/1');
  });

  it('opens through window.openai.openExternal in ChatGPT, with an <a> fallback', () => {
    const openExternal = vi.fn();
    (window as unknown as { openai: unknown }).openai = { openExternal, setWidgetHeight: vi.fn() };
    document.body.innerHTML = `<a id="l" ${links.attrs('/decisions/' + ID)}>Open</a>`;
    const anchor = document.getElementById('l') as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe(links.decision(ID));
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(openExternal).toHaveBeenCalledWith({ url: links.decision(ID) });
    expect(click.defaultPrevented).toBe(true);
  });

  it('routes <ox-agent-card> ox-open events through the host', () => {
    const openExternal = vi.fn();
    (window as unknown as { openai: unknown }).openai = { openExternal, setWidgetHeight: vi.fn() };
    const event = new CustomEvent('ox-open', { detail: { href: links.agent('eli') }, bubbles: true, composed: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(openExternal).toHaveBeenCalledWith({ url: 'https://useorgx.com/command/agents/eli' });
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('widgets build OrgX URLs only through the link builder', () => {
  const dir = resolve(__dirname, '..', 'public', 'widgets');
  const widgets = readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html' && f !== 'scaffold-streaming.html');

  it.each(widgets)('%s has no hand-built useorgx.com URL', (file) => {
    const html = readFileSync(join(dir, file), 'utf8');
    const handBuilt = [
      // 'https://useorgx.com/x/' + id, ORGX_BASE_URL + '/x', `${ORGX}/x`
      ...html.matchAll(/['"`]https:\/\/(?:www\.)?useorgx\.com[^'"`]*['"`]\s*\+|\$\{\s*ORGX[A-Z_]*\s*\}\/|\bORGX(?:_BASE)?(?:_URL)?\s*\+\s*['"`]\//g),
    ].map((m) => m[0]);
    expect(handBuilt).toEqual([]);
  });
});
