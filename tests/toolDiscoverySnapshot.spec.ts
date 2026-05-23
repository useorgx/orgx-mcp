import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import {
  TOOL_PROFILES,
  WIDGET_AFFORDANCE_SURFACE,
  resolveProfileToolSet,
} from '../src/toolProfiles';

/**
 * Tool discovery snapshot.
 *
 * Locks the per-profile tool set and a description-content hash. Drift in
 * either requires a deliberate snapshot update — without that, agents
 * connecting via `?profile=executor` (or any other profile) can silently
 * gain or lose tools and we wouldn't see it until a user noticed an
 * unexpected tool selection at runtime.
 *
 * The snapshot has two layers:
 *   1. Per-profile tool ID set (fixed list of strings).
 *   2. Per-tool description hash, so a description rewrite shows up in CI
 *      even when the tool set hasn't changed.
 */

interface ToolDef {
  id: string;
  description?: string;
}

const ALL_DEFINITIONS: ReadonlyArray<ReadonlyArray<unknown>> = [
  CHATGPT_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  CONTRACT_TOOL_DEFINITIONS,
  FLYWHEEL_TOOL_DEFINITIONS,
];

/**
 * Many tools (entity_action, list_entities, scaffold_initiative, etc.) are
 * registered inline in src/index.ts via `this.server.registerTool(...)`
 * rather than through a definition array. For snapshot purposes we extract
 * their IDs by parsing the source — descriptions are kept inline in those
 * registrations and the per-tool description hash here would be brittle to
 * unrelated edits to surrounding code, so we only lock the ID set for them.
 */
function collectInlineRegisteredToolIds(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  const src = readFileSync(indexPath, 'utf8');
  const ids = new Set<string>();
  // Match: this.server.registerTool(\s*'<id>',  -- the canonical inline form.
  const re = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    ids.add(match[1]!);
  }
  // Also catch: registerAppTool(\n  this.server,\n  '<id>', for ChatGPT App tools.
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  while ((match = appRe.exec(src))) {
    ids.add(match[1]!);
  }
  return ids;
}

function collectAllTools(): Map<string, string> {
  // Map of tool id -> description (last definition wins for any duplicates).
  // Inline-registered tools have an empty description — they're locked by
  // their ID being present in the snapshot, not by description hash.
  const map = new Map<string, string>();
  for (const source of ALL_DEFINITIONS) {
    for (const tool of source) {
      const t = tool as ToolDef;
      if (typeof t.id === 'string') {
        map.set(t.id, typeof t.description === 'string' ? t.description : '');
      }
    }
  }
  for (const id of collectInlineRegisteredToolIds()) {
    if (!map.has(id)) map.set(id, '');
  }
  return map;
}

function hashDescription(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

describe('tool discovery snapshot', () => {
  const allTools = collectAllTools();
  const allToolIds = [...allTools.keys()].sort();

  it('full tool catalog ID set is locked (sorted)', () => {
    // Snapshot the entire catalog. Any new tool must be added here and any
    // removed tool must be removed here. This is the one place where the
    // canonical catalog lives in test code.
    expect(allToolIds).toMatchSnapshot('full-catalog-tool-ids');
  });

  it('full tool catalog description hashes are locked', () => {
    // Hash each description so a description rewrite shows up even when
    // the catalog set hasn't changed. This is what catches "someone
    // shortened the USE WHEN line in scaffold_initiative without updating
    // any test."
    const hashes: Record<string, string> = {};
    for (const id of allToolIds) {
      hashes[id] = hashDescription(allTools.get(id) ?? '');
    }
    expect(hashes).toMatchSnapshot('full-catalog-description-hashes');
  });

  describe('per-profile snapshots', () => {
    const profileNames = Object.keys(TOOL_PROFILES).filter((n) => n !== 'full');

    for (const profileName of profileNames) {
      it(`profile "${profileName}" exposes a locked tool set`, () => {
        const allowed = resolveProfileToolSet(profileName);
        expect(allowed, `profile ${profileName} is null/full unexpectedly`).not.toBeNull();
        const exposed = [...(allowed as Set<string>)].sort();
        expect(exposed).toMatchSnapshot(`profile-${profileName}-tool-ids`);
      });

      it(`profile "${profileName}" only references tools that exist in the catalog`, () => {
        const allowed = resolveProfileToolSet(profileName);
        if (!allowed) return;
        const orphans = [...allowed].filter((id) => !allTools.has(id)).sort();
        expect(
          orphans,
          `profile "${profileName}" references tools that aren't in the catalog: ${orphans.join(', ')}`
        ).toEqual([]);
      });
    }
  });

  it('full profile resolves to null (all tools)', () => {
    expect(resolveProfileToolSet('full')).toBeNull();
  });

  it('missing profile defaults to the compact v2 public surface', () => {
    const expected = new Set(TOOL_PROFILES.v2.tools ?? []);
    expect(resolveProfileToolSet(undefined)).toEqual(expected);
    expect(resolveProfileToolSet(null)).toEqual(expected);
  });

  it('every profile includes the bootstrap/describe entry points', () => {
    // Bootstrap is the v2 session handshake and routing entrypoint. Catches
    // accidental removal from filtered profiles.
    const REQUIRED = ['orgx_bootstrap'];
    const profileNames = Object.keys(TOOL_PROFILES).filter((n) => n !== 'full');
    for (const profileName of profileNames) {
      const allowed = resolveProfileToolSet(profileName);
      if (!allowed) continue;
      for (const required of REQUIRED) {
        expect(
          allowed.has(required),
          `profile "${profileName}" must include ${required}`
        ).toBe(true);
      }
    }
  });

  it('default v2 keeps non-deprecated widget affordance tools visible', () => {
    const allowed = resolveProfileToolSet('v2');
    expect(allowed).not.toBeNull();
    for (const toolId of WIDGET_AFFORDANCE_SURFACE) {
      expect(
        allowed?.has(toolId),
        `v2 profile must expose widget affordance tool ${toolId}`
      ).toBe(true);
    }
  });

  it('default v2 does not re-advertise deprecated widget aliases', () => {
    const allowed = resolveProfileToolSet('v2');
    expect(allowed).not.toBeNull();
    for (const toolId of ['get_pending_decisions', 'get_decision_history']) {
      expect(
        allowed?.has(toolId),
        `deprecated widget alias ${toolId} must remain callable only through compatibility routes`
      ).toBe(false);
    }
  });
});
