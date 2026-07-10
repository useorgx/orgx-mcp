import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CHATGPT_TOOL_DEFINITIONS } from "../src/toolDefinitions";

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
      limit: 25,
    });
    expect(result.success).toBe(true);
  });

  it("keeps the backend limit contract at 25", () => {
    const result = z.object(tool!.inputSchema).safeParse({ limit: 26 });
    expect(result.success).toBe(false);
  });
});
