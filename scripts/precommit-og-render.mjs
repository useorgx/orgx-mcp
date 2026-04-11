import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const triggerMatchers = [
  /^public\/widgets\//,
  /^public\/og-preview\.html$/,
  /^scripts\/render-social-preview\.mjs$/,
];

const generatedAssets = [
  'public/screenshots/orgx-mcp-og.png',
  'public/screenshots/social-preview/search-card.png',
  'public/screenshots/social-preview/scaffold-card.png',
  'public/screenshots/social-preview/decision-card.png',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  });
}

const staged = run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
if (staged.status !== 0) {
  process.stderr.write(staged.stderr || 'Failed to inspect staged files.\n');
  process.exit(staged.status ?? 1);
}

const stagedFiles = staged.stdout
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const relevantChanges = stagedFiles.filter((file) =>
  triggerMatchers.some((matcher) => matcher.test(file))
);

if (relevantChanges.length === 0) {
  process.exit(0);
}

process.stdout.write(
  [
    'Detected staged widget changes that affect social preview assets:',
    ...relevantChanges.map((file) => `- ${file}`),
    'Regenerating OG preview assets...',
  ].join('\n') + '\n'
);

const render = run('pnpm', ['og:render'], { stdio: 'inherit' });
if (render.status !== 0) {
  process.exit(render.status ?? 1);
}

const missingAssets = generatedAssets.filter((file) => !existsSync(resolve(rootDir, file)));
if (missingAssets.length > 0) {
  process.stderr.write(
    `OG render completed but expected assets were missing:\n${missingAssets
      .map((file) => `- ${file}`)
      .join('\n')}\n`
  );
  process.exit(1);
}

const stageAssets = run('git', ['add', ...generatedAssets], { stdio: 'inherit' });
if (stageAssets.status !== 0) {
  process.exit(stageAssets.status ?? 1);
}

process.stdout.write('Updated OG preview assets and staged them for commit.\n');
