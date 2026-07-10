import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The repo-root copies are canonical (they carry the positioning spine from
// docs/positioning.md); public/ serves mirrors of the same bytes. Run
// `pnpm docs:sync:public` after editing a root copy.
const MIRRORED_DOCS = ['agents.md', 'llms.txt', 'llms-full.txt'] as const;

describe('public docs parity', () => {
  for (const doc of MIRRORED_DOCS) {
    it(`keeps ${doc} byte-identical between repo root and public/`, () => {
      const rootCopy = readFileSync(resolve(root, doc));
      const publicCopy = readFileSync(resolve(root, 'public', doc));
      expect(
        publicCopy.equals(rootCopy),
        `public/${doc} drifted from the canonical root copy — run \`pnpm docs:sync:public\``
      ).toBe(true);
    });
  }
});
