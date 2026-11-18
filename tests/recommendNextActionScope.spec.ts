import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CHATGPT_TOOL_DEFINITIONS } from "../src/toolDefinitions";
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { WORKFLOW_TOOL_ADAPTERS } from '../src/workflowTools';

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
