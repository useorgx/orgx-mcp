#!/usr/bin/env node
/**
 * sync-public-docs.mjs
 *
 * Copies the canonical repo-root docs (agents.md, llms.txt, llms-full.txt)
 * into public/ so the served mirrors can never silently drift from the root
 * copies that carry the positioning spine (docs/positioning.md).
 *
 * tests/publicDocsParity.spec.ts asserts the pairs stay byte-identical.
 *
 * Run: pnpm docs:sync:public
 */

import { accessSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const MIRRORED_DOCS = ['agents.md', 'llms.txt', 'llms-full.txt'];

for (const doc of MIRRORED_DOCS) {
  const source = resolve(root, doc);
  const target = resolve(root, 'public', doc);
  accessSync(source); // fail fast if the canonical root copy is missing
  copyFileSync(source, target);
  console.log(`synced ${doc} -> public/${doc}`);
}
