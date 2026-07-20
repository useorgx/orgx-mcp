import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { buildCompactScaffoldResult } from '../src/scaffoldResponse';
import {
  CHATGPT_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';

/**
 * Conversation replay tests (Pass 3, deterministic, no LLM cost).
 *
 * The breadcrumbs we encode in tool results (result_contract.suggested_next_calls,
 * tool_hints, omitted_task_count, etc.) are only useful if they point to
 * tools that actually exist and accept the args we hand them. These tests
 * take a real tool result, walk every breadcrumb it carries, and assert
 * the next call is well-formed against the canonical tool catalog.
 *
 * The LLM "did the agent follow the breadcrumb" gate is a separate
 * concern — see tests/agentSelection.fixture.spec.ts (gated, costs
 * tokens). What fails here is when the breadcrumb itself rots: a
 * renamed tool, a required field dropped from suggested args, etc.
 */

interface ToolWithSchema {
  id: string;
  inputSchema?: Record<string, unknown>;
}

let _inlineToolIdsCache: Set<string> | null = null;
function inlineRegisteredToolIds(): Set<string> {
  if (_inlineToolIdsCache) return _inlineToolIdsCache;
  const ids = new Set<string>();
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  const indexSrc = readFileSync(indexPath, 'utf8');
  const inlineRe = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = inlineRe.exec(indexSrc))) ids.add(match[1]!);
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  while ((match = appRe.exec(indexSrc))) ids.add(match[1]!);
  _inlineToolIdsCache = ids;
  return ids;
}

function findTool(toolId: string): ToolWithSchema | null {
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
      const t = tool as ToolWithSchema;
      if (t.id === toolId) return t;
    }
  }
  // Inline-registered tools (list_entities, entity_action, etc.) — we can
  // confirm registration via index.ts parsing, but inputSchema is not
  // exposed as a runtime export so the schema-required-fields check is
  // a no-op for them.
  if (inlineRegisteredToolIds().has(toolId)) {
    return { id: toolId };
  }
  return null;
}

function isOptional(field: unknown): boolean {
  if (
    field &&
    typeof field === 'object' &&
    'isOptional' in field &&
    typeof (field as { isOptional?: () => boolean }).isOptional === 'function'
  ) {
    return (field as { isOptional: () => boolean }).isOptional();
  }
  return false;
}

function requiredFields(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  for (const [name, field] of Object.entries(schema)) {
    if (!isOptional(field)) out.push(name);
  }
  return out;
}

function makeScaffoldResult(omittedTaskCount: number) {
  const taskCount = 250 + omittedTaskCount;
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `t-${i}`,
    ref: `t-${i}`,
    title: `Task ${i}`,
  }));
  return buildCompactScaffoldResult({
    initiativeId: 'init-replay',
    workspaceId: 'ws-replay',
    liveUrl: 'https://useorgx.com/live/init-replay',
    result: {
      summary: `Created ${taskCount + 3}/${taskCount + 3} entities`,
      total: taskCount + 3,
      created_count: taskCount + 3,
      failed_count: 0,
      warnings: [],
      failed: [],
      ref_map: Object.fromEntries([
        ['initiative', 'init-replay'],
        ['ws-1', 'ws-id'],
        ['ms-1', 'ms-id'],
        ...tasks.map((t) => [t.ref, t.id] as const),
      ]),
      created: [
        { index: 0, type: 'initiative', id: 'init-replay' },
        { index: 1, type: 'workstream', id: 'ws-id' },
        { index: 2, type: 'milestone', id: 'ms-id' },
        ...tasks.map((t, i) => ({ index: i + 3, type: 'task', id: t.id })),
      ],
      results: [],
    },
    hierarchy: {
      initiative: { id: 'init-replay', title: 'Replay Test' },
      workstreams: [
        {
          id: 'ws-id',
          title: 'WS',
          milestones: [{ id: 'ms-id', title: 'MS', tasks }],
        },
      ],
    },
  });
}

describe('conversation replay — scaffold breadcrumbs', () => {
  it('every suggested_next_calls entry names a tool that actually exists', () => {
    const result = makeScaffoldResult(0);
    const orphans: string[] = [];
    for (const call of result.result_contract.suggested_next_calls) {
      if (!findTool(call.tool)) orphans.push(call.tool);
    }
    expect(
      orphans,
      `suggested_next_calls references unregistered tools: ${orphans.join(', ')}`
    ).toEqual([]);
  });

  it("every suggested_next_calls args object satisfies the target tool's required fields", () => {
    const result = makeScaffoldResult(0);
    const violations: string[] = [];
    for (const call of result.result_contract.suggested_next_calls) {
      const tool = findTool(call.tool);
      if (!tool) continue;
      const required = requiredFields(tool.inputSchema);
      const args = call.args as Record<string, unknown> | undefined;
      const missing = required.filter((field) => !args || !(field in args));
      if (missing.length > 0) {
        violations.push(`${call.tool}: missing required fields ${missing.join(', ')}`);
      }
    }
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('initiative-scoped suggested_next_calls preserve initiative_id and workspace_id', () => {
    const result = makeScaffoldResult(0);
    for (const call of result.result_contract.suggested_next_calls) {
      const args = call.args as Record<string, unknown> | undefined;
      expect(args?.initiative_id, `${call.tool} missing initiative_id`).toBe(
        'init-replay'
      );
      expect(args?.workspace_id, `${call.tool} missing workspace_id`).toBe(
        'ws-replay'
      );
    }
  });

  it('do_not_retry_for_full_payload is set so agents stop guessing', () => {
    const result = makeScaffoldResult(0);
    expect(result.result_contract.do_not_retry_for_full_payload).toBe(true);
    expect(result.tool_hints.do_not_rerun_scaffold_for_more_detail).toBe(true);
  });
});

describe('conversation replay — compaction breadcrumb', () => {
  it('when omitted_task_count > 0, orgx_search is in suggested_next_calls', () => {
    const result = makeScaffoldResult(50);
    expect(result.summary_stats.omitted_task_count).toBeGreaterThan(0);
    const tools = result.result_contract.suggested_next_calls.map((c) => c.tool);
    expect(
      tools,
      'agent should be told to fetch the full task list via orgx_search'
    ).toContain('orgx_search');
  });

  it('the orgx_search follow-up call carries type=task so the agent can paginate the omitted tail', () => {
    const result = makeScaffoldResult(50);
    const taskCall = result.result_contract.suggested_next_calls.find(
      (c) =>
        c.tool === 'orgx_search' &&
        (c.args as Record<string, unknown>)?.type === 'task'
    );
    expect(
      taskCall,
      'expected at least one suggested orgx_search call with type=task'
    ).toBeDefined();
    const args = taskCall!.args as Record<string, unknown>;
    expect(args.initiative_id).toBe('init-replay');
    expect(args.limit).toBeTypeOf('number');
  });
});

describe('conversation replay — decision blocker', () => {
  /**
   * When an agent surfaces a blocker decision, the canonical follow-up
   * read is `get_pending_decisions` filtered by urgency. This test pins
   * the contract that the decision-tool family accepts the args a
   * blocker discovery flow would synthesise.
   */
  it('get_pending_decisions accepts urgency_filter, initiative_id, workspace_id, and limit', () => {
    const tool = findTool('get_pending_decisions');
    expect(tool, 'get_pending_decisions must be registered').not.toBeNull();
    const schema = tool!.inputSchema!;
    expect(schema).toHaveProperty('urgency_filter');
    expect(schema).toHaveProperty('initiative_id');
    expect(schema).toHaveProperty('workspace_id');
    expect(schema).toHaveProperty('limit');
  });

  it('approve_decision and reject_decision both require decision_id', () => {
    for (const id of ['approve_decision', 'reject_decision']) {
      const tool = findTool(id);
      expect(tool, `${id} must be registered`).not.toBeNull();
      const schema = tool!.inputSchema!;
      expect(schema).toHaveProperty('decision_id');
      expect(isOptional((schema as Record<string, unknown>).decision_id)).toBe(false);
    }
  });

  it('reject_decision requires reason — never let an agent reject silently', () => {
    const tool = findTool('reject_decision');
    const schema = tool!.inputSchema!;
    expect(schema).toHaveProperty('reason');
    expect(isOptional((schema as Record<string, unknown>).reason)).toBe(false);
  });

  it('the path "create_decision → get_pending_decisions → approve_decision" is fully wired', () => {
    const path = ['create_decision', 'get_pending_decisions', 'approve_decision'];
    const missing = path.filter((id) => !findTool(id));
    expect(missing).toEqual([]);
  });
});
