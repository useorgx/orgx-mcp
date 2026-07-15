import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ORG = 'knodible';
const PROJECT = 'orgx-mcp';
const DIST = path.resolve('dist');
const SENTRY_CLI = path.resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'sentry-cli.cmd' : 'sentry-cli'
);

function run(args, options = {}) {
  const result = spawnSync(SENTRY_CLI, args, {
    env: process.env,
    stdio: options.quiet ? 'ignore' : 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function deleteSourceMaps(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return deleteSourceMaps(target);
      if (entry.isFile() && entry.name.endsWith('.map')) {
        await rm(target);
      }
    })
  );
}

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.log('[sentry] Source-map upload skipped: SENTRY_AUTH_TOKEN is unset.');
  process.exit(0);
}

const release =
  process.env.SENTRY_RELEASE?.trim() ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const projectArgs = [`--org=${ORG}`, `--project=${PROJECT}`];

const releaseExists =
  run(['releases', 'info', release, ...projectArgs], { quiet: true }) === 0;
if (!releaseExists) {
  const createCode = run(['releases', 'new', release, ...projectArgs]);
  if (createCode !== 0) process.exit(createCode);
}

const uploadCode = run([
  'sourcemaps',
  'upload',
  ...projectArgs,
  `--release=${release}`,
  '--strip-prefix',
  'dist/..',
  DIST,
]);
if (uploadCode !== 0) process.exit(uploadCode);

await deleteSourceMaps(DIST);
console.log(`[sentry] Uploaded source maps for ${PROJECT}@${release}.`);
