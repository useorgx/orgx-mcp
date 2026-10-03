/**
 * generate-app-routes.mjs
 *
 * Snapshots the OrgX app's page routes into tests/fixtures/orgx-app-routes.json
 * so link builders (src/deepLinks.ts, widget runtime) can be checked against
 * pages that actually exist.
 *
 * For each `app/**\/page.tsx` it records:
 *   - the route pattern (route groups stripped; parallel slots skipped)
 *   - `redirect`: the target when the page only redirects
 *   - `params`: query params the page (or a module it imports from its own
 *     route folder) reads from searchParams
 * It also records the static `redirects()` entries from next.config.mjs.
 *
 * Usage:
 *   ORGX_APP_DIR=../orgx/orgx pnpm app:routes
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(repoRoot, process.env.ORGX_APP_DIR ?? '../orgx/orgx');
const appDir = path.join(appRoot, 'app');
const outFile = path.join(repoRoot, 'tests/fixtures/orgx-app-routes.json');

if (!existsSync(appDir)) {
  console.error(`OrgX app directory not found: ${appDir} (set ORGX_APP_DIR)`);
  process.exit(1);
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const NON_PARAM_KEYS = new Set([
  'get', 'getAll', 'set', 'has', 'append', 'delete', 'toString', 'entries',
  'keys', 'values', 'forEach', 'size', 'then', 'length',
]);

function walkPages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Parallel-route slots (@x) only fill a layout; they never create a URL on their own.
    if (name === 'node_modules' || name.startsWith('_') || name.startsWith('@') || name === 'api') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkPages(full, out);
    else if (name === 'page.tsx' || name === 'page.ts' || name === 'page.jsx') out.push(full);
  }
  return out;
}

function routePattern(pageFile) {
  const segments = path
    .relative(appDir, path.dirname(pageFile))
    .split(path.sep)
    .filter(Boolean)
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return `/${segments.join('/')}`;
}

function isRouteDir(dir) {
  return ['page.tsx', 'page.ts', 'page.jsx'].some((f) => existsSync(path.join(dir, f)));
}

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/app/')) base = path.join(appDir, spec.slice('@/app/'.length));
  else return null;
  const candidates = [base, ...SOURCE_EXTENSIONS.map((e) => base + e), ...SOURCE_EXTENSIONS.map((e) => path.join(base, 'index' + e))];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Files the page owns: itself plus local modules it imports that live in its route folder (not in a child route). */
function ownedFiles(pageFile) {
  const routeDir = path.dirname(pageFile);
  const seen = new Set();
  const queue = [pageFile];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const resolved = resolveImport(file, m[1]);
      if (!resolved || !resolved.startsWith(routeDir + path.sep)) continue;
      // Stop at child routes: they are their own pages.
      let dir = path.dirname(resolved);
      let crossesRoute = false;
      while (dir !== routeDir) {
        if (isRouteDir(dir)) crossesRoute = true;
        dir = path.dirname(dir);
      }
      if (!crossesRoute) queue.push(resolved);
    }
  }
  return [...seen];
}

function readParams(files) {
  const params = new Set();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b\w*[sS]earch[pP]arams\??\.(\w+)/g)) params.add(m[1]);
    for (const m of src.matchAll(/\b\w*[sS]earch[pP]arams\??\.?\[\s*['"](\w+)['"]\s*\]/g)) params.add(m[1]);
    if (/[sS]earch[pP]arams/.test(src)) {
      for (const m of src.matchAll(/\.get\(\s*['"]([\w-]+)['"]\s*\)/g)) params.add(m[1]);
    }
  }
  return [...params].filter((p) => !NON_PARAM_KEYS.has(p)).sort();
}

/** A page that renders nothing and only calls redirect(...). */
function pageRedirect(pageFile) {
  const src = readFileSync(pageFile, 'utf8');
  if (!/\bredirect\(/.test(src)) return null;
  if (/(?:return|=>)\s*\(?\s*<[A-Za-z>]/.test(src)) return null;
  // Keep the static prefix of the target (`/live?run=${id}` -> `/live?run=`).
  const m = src.match(/\bredirect\(\s*([`'"])([^`'"\n]*)/);
  const target = m ? m[2].split('${')[0] : '';
  return target || 'dynamic';
}

function configRedirects() {
  const configFile = ['next.config.mjs', 'next.config.js', 'next.config.ts']
    .map((f) => path.join(appRoot, f))
    .find((f) => existsSync(f));
  if (!configFile) return [];
  const src = readFileSync(configFile, 'utf8');
  const block = src.slice(src.indexOf('redirects()'));
  const out = [];
  for (const m of block.matchAll(/source:\s*'([^']+)',\s*destination:\s*'([^']+)'/g)) {
    out.push({ source: m[1], destination: m[2] });
  }
  return out;
}

const routes = walkPages(appDir)
  .map((pageFile) => ({
    pattern: routePattern(pageFile),
    redirect: pageRedirect(pageFile),
    params: readParams(ownedFiles(pageFile)),
  }))
  .sort((a, b) => a.pattern.localeCompare(b.pattern));

const fixture = {
  $comment: 'Generated by scripts/generate-app-routes.mjs from the OrgX app (orgx/app/**/page.tsx). Do not edit by hand.',
  routes,
  redirects: configRedirects(),
};

writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote ${fixture.routes.length} routes and ${fixture.redirects.length} redirects to ${path.relative(repoRoot, outFile)}`);
