import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CHATGPT_TOOL_DEFINITIONS } from "../src/toolDefinitions";
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { WORKFLOW_TOOL_ADAPTERS } from '../src/workflowTools';
import { inspectRecommendedWork } from '../src/recommendationContext';
import { sanitizeToolResultGuidance } from '../src/toolGuidance';

describe("recommend_next_action agent scope", () => {
  const tool = CHATGPT_TOOL_DEFINITIONS.find(
    (definition) => definition.id === "recommend_next_action"
  );

  it("accepts canonical agent and domain filters", () => {
    expect(tool).toBeDefined();
    const schema = z.object(tool!.inputSchema);
    const result = schema.safeParse({
      entity_type: "workspace",
      entity_id: "default",
      agent_id: "operations-agent",
      domain: "operations",
      canonical_only: true,
      limit: 25,
    });
    expect(result.success).toBe(true);
  });

  it("keeps the backend limit contract at 25", () => {
    const result = z.object(tool!.inputSchema).safeParse({ limit: 26 });
    expect(result.success).toBe(false);
  });

  it.each([
    tool!,
    CONTRACT_TOOL_DEFINITIONS.find((entry) => entry.id === 'orgx_recommend')!,
    WORKFLOW_TOOL_ADAPTERS.find((entry) => entry.id === 'orgx_get_next_actions')!,
  ])('advertises an explicit capability-assessment opt-in on $id', (definition) => {
    const schema = z.object(definition.inputSchema);
    expect(schema.parse({}).include_capability_suggestions).toBe(false);
    expect(schema.parse({ include_capability_suggestions: true }).include_capability_suggestions).toBe(true);
    expect(schema.safeParse({ include_capability_suggestions: 'true' }).success).toBe(false);
  });
});

describe('recommended work context', () => {
  const key = '11111111-1111-4111-8111-111111111111';
  const task = '22222222-2222-4222-8222-222222222222';

  it.each(['initiative', 'task', 'workstream'])('inspects the exact %s record when the work has no next task', (type) => {
    expect(inspectRecommendedWork({ id: 'scoring-id', entityType: type, key, metadata: { nextTaskId: null } }))
      .toEqual({ tool: 'orgx_inspect', args: { type, id: key } });
  });

  it.each([null, { id: key }, { entityType: 'task', key: 'short' }, { entityType: 'run', key },
    { entityType: 'workstream', key, metadata: { nextTaskId: 'incomplete' } }])(
    'omits the call without an unambiguous work record', (value) => {
      expect(inspectRecommendedWork(value)).toBeNull();
    }
  );

  it('clears the read when this client cannot inspect work', () => {
    const next_call = inspectRecommendedWork({ entityType: 'workstream', key, metadata: { nextTaskId: task } });
    expect(sanitizeToolResultGuidance({ structuredContent: { next_call } }, new Set(['orgx_get_next_actions'])))
      .toEqual({ structuredContent: { next_call: null } });
  });
});
