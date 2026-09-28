import { describe, expect, it } from 'vitest';

import { WIDGET_BUILD_VERSION } from '../src/generated/widgetBuildInfo';
// The hash rule lives in one place. This suite used to carry its own copy of
// the walk-and-digest logic, which is two definitions of a rule that has to
// agree exactly.
import { computeWidgetBuildVersion } from '../scripts/lib/widgetBuildHash.mjs';

describe('widget build version', () => {
  it('matches the current public widget asset hash', () => {
    expect(WIDGET_BUILD_VERSION).toBe(computeWidgetBuildVersion());
  });
});

describe('widget build version determinism', () => {
  it('does not change when only the generated manifest is rewritten', () => {
    // The manifest carries a generatedAt timestamp and used to feed this hash,
    // so every build produced a new version: `pnpm verify` dirtied the tree and
    // this suite failed until the regenerated file was committed again.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const root = join(__dirname, '..');
    const versionFile = join(root, 'src', 'generated', 'widgetBuildInfo.ts');

    const read = () => readFileSync(versionFile, 'utf8');
    execFileSync('node', ['scripts/build-widgets.mjs'], { cwd: root, stdio: 'ignore' });
    execFileSync('node', ['scripts/generate-widget-build-info.mjs'], { cwd: root, stdio: 'ignore' });
    const first = read();
    execFileSync('node', ['scripts/build-widgets.mjs'], { cwd: root, stdio: 'ignore' });
    execFileSync('node', ['scripts/generate-widget-build-info.mjs'], { cwd: root, stdio: 'ignore' });
    expect(read()).toBe(first);
  }, 30000);
});
