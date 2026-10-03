/**
 * Resolves an OrgX URL against tests/fixtures/orgx-app-routes.json (generated
 * from the app tree by scripts/generate-app-routes.mjs). Shared by the widget
 * link builder test and the server deep-link test so both are held to the
 * same app routes.
 */
import fixture from './orgx-app-routes.json';

export function routePattern(route: string): RegExp {
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
export function resolveRoute(url: string): { route?: string; problem?: string } {
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
