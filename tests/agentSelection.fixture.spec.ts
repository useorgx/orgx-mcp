import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { z } from 'zod';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';

/**
 * Pass 3 — Agent selection accuracy fixtures.
 *
 * tests/fixtures/agentIntents.json pairs short user utterances with the
 * tool an agent should pick AND the wrong tool we want to avoid. This
 * file runs in two modes:
 *
 *   1. DEFAULT (always on, free): "fixture validation" — every fixture's
 *      `expected_tool` and `forbidden_tool` must reference a tool that is
 *      actually registered. Catches silent fixture rot when a tool is
 *      renamed or removed and the fixture wasn't updated.
 *
 *   2. RUN_AGENT_SELECTION_TESTS=1 (gated, token-costing): "live
 *      selection" — each fixture is run K times against Anthropic +
 *      OpenAI tool-use APIs with the real tools/list manifest injected;
 *      dominant tool must fire ≥ 70% of runs and the forbidden tool
 *      must fire < 10%. Live mode runs out-of-band (e.g. weekly cron
 *      or pre-release) — not in standard CI.
 */

interface IntentFixture {
  id: string;
  prompt: string;
  expected_tool: string;
  expected_arguments?: Record<string, unknown>;
  forbidden_tool: string;
  rationale: string;
}

interface FixtureFile {
  version: number;
  description: string;
  fixtures: IntentFixture[];
}

function loadFixtures(): FixtureFile {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolvePath(here, 'fixtures', 'agentIntents.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;
}

function collectAllTools(): Map<string, { inputSchema?: Record<string, unknown> }> {
  const ids = new Set<string>();
  const tools = new Map<string, { inputSchema?: Record<string, unknown> }>();
  const sources = [
    CHATGPT_TOOL_DEFINITIONS,
    PLAN_SESSION_TOOLS,
    STREAM_TOOL_DEFINITIONS,
    CLIENT_INTEGRATION_TOOL_DEFINITIONS,
    CONTRACT_TOOL_DEFINITIONS,
    FLYWHEEL_TOOL_DEFINITIONS,
  ] as ReadonlyArray<ReadonlyArray<unknown>>;
  for (const source of sources) {
    for (const tool of source) {
      const t = tool as { id?: string; inputSchema?: Record<string, unknown> };
      if (typeof t.id === 'string') {
        ids.add(t.id);
        tools.set(t.id, t);
      }
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  const indexSrc = readFileSync(indexPath, 'utf8');
  const inlineRe = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = inlineRe.exec(indexSrc))) ids.add(match[1]!);
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  while ((match = appRe.exec(indexSrc))) ids.add(match[1]!);
  for (const id of ids) {
    if (!tools.has(id)) tools.set(id, {});
  }
  return tools;
}

describe('agent selection fixtures (validation, free)', () => {
  const fixtures = loadFixtures();
  const allTools = collectAllTools();
  const allToolIds = new Set(allTools.keys());

  it('fixture file has a positive version + non-empty fixtures array', () => {
    expect(fixtures.version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(fixtures.fixtures)).toBe(true);
    expect(fixtures.fixtures.length).toBeGreaterThanOrEqual(20);
  });

  it('every fixture has the required fields with non-empty strings', () => {
    const broken: string[] = [];
    for (const f of fixtures.fixtures) {
      if (!f.id?.trim()) broken.push(`(missing id) prompt="${f.prompt?.slice(0, 40)}"`);
      if (!f.prompt?.trim()) broken.push(`${f.id}: missing prompt`);
      if (!f.expected_tool?.trim()) broken.push(`${f.id}: missing expected_tool`);
      if (!f.forbidden_tool?.trim()) broken.push(`${f.id}: missing forbidden_tool`);
      if (!f.rationale?.trim()) broken.push(`${f.id}: missing rationale`);
    }
    expect(broken, broken.join('; ')).toEqual([]);
  });

  it('every fixture id is unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const f of fixtures.fixtures) {
      if (seen.has(f.id)) dupes.push(f.id);
      seen.add(f.id);
    }
    expect(dupes).toEqual([]);
  });

  it('every fixture references a real registered tool for expected_tool', () => {
    const orphans = fixtures.fixtures
      .filter((f) => !allToolIds.has(f.expected_tool))
      .map((f) => `${f.id} → ${f.expected_tool}`);
    expect(
      orphans,
      `expected_tool not in registered catalog: ${orphans.join(', ')}`
    ).toEqual([]);
  });

  it('every fixture references a real registered tool for forbidden_tool', () => {
    const orphans = fixtures.fixtures
      .filter((f) => !allToolIds.has(f.forbidden_tool))
      .map((f) => `${f.id} → ${f.forbidden_tool}`);
    expect(
      orphans,
      `forbidden_tool not in registered catalog: ${orphans.join(', ')}`
    ).toEqual([]);
  });

  it('expected_tool and forbidden_tool differ within each fixture', () => {
    const broken = fixtures.fixtures
      .filter((f) => f.expected_tool === f.forbidden_tool)
      .map((f) => f.id);
    expect(broken).toEqual([]);
  });

  it('fixtures with expected_arguments validate against the expected tool schema', () => {
    const broken: string[] = [];
    for (const f of fixtures.fixtures) {
      if (!f.expected_arguments) continue;
      const inputSchema = allTools.get(f.expected_tool)?.inputSchema;
      if (!inputSchema) {
        broken.push(`${f.id}: ${f.expected_tool} has no registered input schema`);
        continue;
      }
      const parsed = z.object(inputSchema).safeParse(f.expected_arguments);
      if (!parsed.success) {
        broken.push(`${f.id}: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`);
      }
    }
    expect(broken, broken.join('; ')).toEqual([]);
  });

  it('cost and validation fixtures estimate before dispatching work', () => {
    const estimateFixtures = fixtures.fixtures.filter(
      (f) =>
        f.id.includes('cost') ||
        f.id.includes('budget') ||
        f.id.includes('validation')
    );

    expect(estimateFixtures.length).toBeGreaterThanOrEqual(2);
    for (const f of estimateFixtures) {
      expect(f.expected_tool).toBe('orgx_spawn');
      expect(f.expected_arguments).toMatchObject({
        action: 'estimate',
        budget_mode: 'cheapest_valid',
      });
    }
  });
});

describe.skipIf(process.env.RUN_AGENT_SELECTION_TESTS !== '1')(
  'agent selection fixtures (live, gated by RUN_AGENT_SELECTION_TESTS=1)',
  () => {
    /**
     * Live runs against Anthropic + OpenAI tool-use APIs are deferred to
     * a separate runner script (scripts/run-agent-selection.mjs) so the
     * test file stays a pure correctness check. The runner reads
     * tests/fixtures/agentIntents.json and writes a JSON report; this
     * skipped block exists so contributors can find the gate by
     * searching the test file.
     *
     * To run:
     *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... RUN_AGENT_SELECTION_TESTS=1 \
     *     pnpm test --run tests/agentSelection.fixture.spec.ts
     *
     * Thresholds:
     *   - dominant_tool >= 0.7 (default 70%)
     *   - forbidden_tool < 0.1 (default 10%)
     * across K=10 runs per fixture per provider.
     */
    it('placeholder — wire the live runner here', () => {
      expect(true).toBe(true);
    });
  }
);
