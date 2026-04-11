import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = resolve(rootDir, '.githooks', 'pre-commit');

if (process.env.CI) {
  process.exit(0);
}

if (!existsSync(hookPath)) {
  console.warn('Skipping git hook setup: .githooks/pre-commit is missing.');
  process.exit(0);
}

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: rootDir,
    stdio: 'ignore',
  });
} catch {
  process.exit(0);
}

chmodSync(hookPath, 0o755);
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: rootDir,
  stdio: 'ignore',
});

console.log('Configured git hooks to use .githooks');
