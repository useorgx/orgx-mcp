import { describe, expect, it } from 'vitest';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';

const INLINE_REGISTERED_TOOL_IDS = [
  'get_org_snapshot',
  'account_status',
  'account_upgrade',
  'account_usage_report',
  'list_entities',
  'entity_action',
  'verify_entity_completion',
  'create_entity',
  'comment_on_entity',
  'list_entity_comments',
  'batch_create_entities',
  'scaffold_initiative',
  'get_task_with_context',
  'batch_delete_entities',
  'update_entity',
  'configure_org',
  'stats',
  'workspace',
] as const;

const INLINE_HANDLED_TOOLS = new Set(['workspace', 'configure_org', 'stats']);

function extractIds(defs: ReadonlyArray<{ id: string }>): string[] {
  return defs.map((d) => d.id);
}

function findDuplicates(arr: string[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of arr) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

describe('MCP Worker tool registration integrity', () => {
  const chatgptIds = extractIds(
    CHATGPT_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const planIds = extractIds(PLAN_SESSION_TOOLS as unknown as { id: string }[]);
  const streamIds = extractIds(
    STREAM_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const clientIds = extractIds(
    CLIENT_INTEGRATION_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const contractIds = extractIds(
    CONTRACT_TOOL_DEFINITIONS as unknown as { id: string }[]
  );
  const inlineIds = [...INLINE_REGISTERED_TOOL_IDS];
  const flywheelIds = extractIds(
    FLYWHEEL_TOOL_DEFINITIONS as unknown as { id: string }[]
  );

  it('CHATGPT_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(chatgptIds)).toEqual([]);
  });

  it('PLAN_SESSION_TOOLS has no duplicate IDs', () => {
    expect(findDuplicates(planIds)).toEqual([]);
  });

  it('STREAM_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(streamIds)).toEqual([]);
  });

  it('CLIENT_INTEGRATION_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(clientIds)).toEqual([]);
  });

  it('CONTRACT_TOOL_DEFINITIONS has no duplicate IDs', () => {
    expect(findDuplicates(contractIds)).toEqual([]);
  });

  it('definition arrays have no overlapping IDs', () => {
    const allDefinitionIds = [
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
    ];
    const dupes = findDuplicates(allDefinitionIds);
    expect(dupes).toEqual([]);
  });

  it('all tools shared between CHATGPT_TOOL_DEFINITIONS and inline registrations are in INLINE_HANDLED_TOOLS skip-set', () => {
    const inlineSet = new Set(inlineIds);
    const sharedTools = chatgptIds.filter((id) => inlineSet.has(id));

    for (const toolId of sharedTools) {
      expect(
        INLINE_HANDLED_TOOLS.has(toolId),
        `Tool "${toolId}" exists in both CHATGPT_TOOL_DEFINITIONS and inline registrations but is NOT in INLINE_HANDLED_TOOLS skip-set.`
      ).toBe(true);
    }
  });

  it('PLAN_SESSION_TOOLS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = planIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('STREAM_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = streamIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('CLIENT_INTEGRATION_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = clientIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('CONTRACT_TOOL_DEFINITIONS does not overlap with inline registrations', () => {
    const inlineSet = new Set(inlineIds);
    const overlap = contractIds.filter((id) => inlineSet.has(id));
    expect(overlap).toEqual([]);
  });

  it('flywheel tools do not overlap with definition arrays', () => {
    const allDefIds = new Set([
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
    ]);
    const overlap = flywheelIds.filter((id) => allDefIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('all tool IDs match MCP naming pattern ^[a-zA-Z0-9_-]{1,64}$', () => {
    const allIds = [
      ...chatgptIds,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
      ...inlineIds,
      ...flywheelIds,
    ];
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const id of allIds) {
      expect(id, `Tool ID "${id}" does not match MCP naming convention`).toMatch(
        pattern
      );
    }
  });

  it('after applying INLINE_HANDLED_TOOLS skip-set, no tool ID would be registered twice', () => {
    const chatgptRegistered = chatgptIds.filter(
      (id) => !INLINE_HANDLED_TOOLS.has(id)
    );

    const allRegistered = [
      ...chatgptRegistered,
      ...planIds,
      ...streamIds,
      ...clientIds,
      ...contractIds,
      ...inlineIds,
      ...flywheelIds,
    ];

    const dupes = findDuplicates(allRegistered);
    expect(dupes).toEqual([]);
  });

  it('INLINE_HANDLED_TOOLS skip-set contains only tools that exist in CHATGPT_TOOL_DEFINITIONS', () => {
    const chatgptSet = new Set(chatgptIds);
    for (const toolId of INLINE_HANDLED_TOOLS) {
      expect(
        chatgptSet.has(toolId),
        `INLINE_HANDLED_TOOLS contains "${toolId}" which is NOT in CHATGPT_TOOL_DEFINITIONS.`
      ).toBe(true);
    }
  });

  it('INLINE_HANDLED_TOOLS skip-set contains only tools that are inline-registered', () => {
    const inlineSet = new Set(inlineIds);
    for (const toolId of INLINE_HANDLED_TOOLS) {
      expect(
        inlineSet.has(toolId),
        `INLINE_HANDLED_TOOLS contains "${toolId}" which is NOT inline-registered.`
      ).toBe(true);
    }
  });
});
