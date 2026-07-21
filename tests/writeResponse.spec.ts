import { describe, expect, it } from "vitest";

import { canonicalizeOrgxWriteResponse } from "../src/writeResponse";

describe("canonicalizeOrgxWriteResponse", () => {
  it("echoes a nested created entity UUID at the top level", () => {
    expect(
      canonicalizeOrgxWriteResponse(
        {
          type: "task",
          data: { id: "task-uuid", title: "Fix the contract" },
        },
        "task",
      ),
    ).toMatchObject({
      id: "task-uuid",
      entity_id: "task-uuid",
      type: "task",
      data: { id: "task-uuid" },
    });
  });

  it("keeps an idempotent replay chainable without changing its data shape", () => {
    const existing = { id: "initiative-uuid", title: "Existing initiative" };
    const result = canonicalizeOrgxWriteResponse(
      { existing, data: existing, idempotent_replay: true },
      "initiative",
    );

    expect(result.id).toBe("initiative-uuid");
    expect(result.entity_id).toBe("initiative-uuid");
    expect(result.existing).toBe(existing);
    expect(result.data).toBe(existing);
  });
});
