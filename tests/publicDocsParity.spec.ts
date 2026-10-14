import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOOL_PROFILES } from '../src/toolProfiles';

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

// The canonical docs teach the default v2 operation catalog. Names served only
// by the explicit legacy compatibility profile may appear solely in a
// paragraph that says so, and every v2 write example must carry its own
// idempotency_key (a missing key is refused with idempotency_key_required).
describe('public docs teach the v2 catalog', () => {
  const v2 = new Set(TOOL_PROFILES.v2.tools ?? []);
  const legacyOnly = (TOOL_PROFILES.legacy.tools ?? []).filter((name) => !v2.has(name));
  const catalog = JSON.parse(
    readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8')
  ) as { tools: Array<{ id: string; inputSchema?: { required?: string[] } }> };
  const requiresKey = new Set(
    catalog.tools
      .filter((tool) => tool.inputSchema?.required?.includes('idempotency_key'))
      .map((tool) => tool.id)
  );

  it('derives a non-empty legacy-only set from the profiles', () => {
    expect(legacyOnly).toEqual(expect.arrayContaining(['orgx_write', 'orgx_decide', 'orgx_bootstrap']));
  });

  for (const doc of MIRRORED_DOCS) {
    it(`${doc} names legacy-only tools only in an explicit legacy note`, () => {
      const paragraphs = readFileSync(resolve(root, doc), 'utf8').split(/\n\s*\n/);
      const offenders: string[] = [];
      for (const paragraph of paragraphs) {
        if (/legacy/i.test(paragraph)) continue;
        for (const name of legacyOnly) {
          if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(paragraph)) {
            offenders.push(`${name}: ${paragraph.slice(0, 80)}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${doc} write examples use v2 tools and carry idempotency_key`, () => {
      const text = readFileSync(resolve(root, doc), 'utf8');
      const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
      for (const line of blocks.flatMap((block) => block.split('\n')).filter((l) => l.trim())) {
        const call = JSON.parse(line) as { tool: string; arguments: Record<string, unknown> };
        expect(v2.has(call.tool), `${call.tool} is not on the v2 profile`).toBe(true);
        if (requiresKey.has(call.tool)) {
          expect(typeof call.arguments.idempotency_key, `${call.tool} example lacks idempotency_key`).toBe('string');
        }
      }
    });
  }

  it('documents an example for at least one v2 write in each llms doc', () => {
    for (const doc of ['llms.txt', 'llms-full.txt']) {
      expect(readFileSync(resolve(root, doc), 'utf8')).toMatch(/"idempotency_key": "claude:/);
    }
  });
});
