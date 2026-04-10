import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WIDGET_BUILD_VERSION } from '../src/generated/widgetBuildInfo';

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store')
    .sort((a, b) => a.name.localeCompare(b.name));

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function computeWidgetBuildVersion() {
  const root = process.cwd();
  const widgetRoot = resolve(root, 'public/widgets');
  const hash = createHash('sha256');

  for (const filePath of collectFiles(widgetRoot)) {
    hash.update(relative(root, filePath));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }

  return hash.digest('hex').slice(0, 12);
}

describe('widget build version', () => {
  it('matches the current public widget asset hash', () => {
    expect(WIDGET_BUILD_VERSION).toBe(computeWidgetBuildVersion());
  });
});
