import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getWorkflowToolContract } from "../src/workflowTools";

import {
  buildCompletionProofMetadata,
  executeCompleteWithProofFlow,
} from "../src/completeWithProof";

const completionApi = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock("agents/mcp", () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock("../src/oauth", () => ({ OAuthState: class {} }));
vi.mock("@sentry/cloudflare", () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock("@cloudflare/workers-oauth-provider", () => ({ default: class {} }));
vi.mock("../src/orgxApi", async (original) => ({
  ...await original<typeof import("../src/orgxApi")>(),
  callOrgxApiJson: completionApi.callOrgxApiJson,
}));

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const predecessor = { artifact_id: "33333333-3333-4333-8333-333333333333",
  expected_version: 2, expected_updated_at: "2026-10-10T07:00:00.123+02:00" };
const completionArtifact = { artifact_type: "eng.diff_pack", external_url: "https://example.test/proof" };

async function connectCompletionOperations() {
  const { OrgXMcp } = await import("../src/index");
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = { workspaceId: WORKSPACE_ID };
  worker.env = { ORGX_API_URL: "https://orgx.test", MCP_SERVER_URL: "https://mcp.orgx.test" };
  worker.resolveUserId = () => "completion-fixture-user";
  worker.resolveUserEmail = () => "member@example.test";
  worker.resolveOrgxUserId = () => TASK_ID;
  worker.delegationClaims = () => ({ grantedScopes: ["initiatives:read", "initiatives:write"] });
  worker.buildAuthRequiredResponse = () => null;
  worker.withOrgx = (callback: () => unknown) => callback();
  worker.withClientContext = (shape: unknown) => shape;
  const server = new McpServer({ name: "completion-predecessor", version: "1" });
  worker.server = server;
  const compatibilityHandler = vi.fn(async () => ({ content: [] }));
  worker.registerPublicOperations(new Set([
    "orgx_complete_work_with_proof", "orgx_attach_artifact", "orgx_ship_batch_work",
  ]), new Map([
    ["orgx_act", { config: {}, handler: compatibilityHandler }],
    ["orgx_attach", { config: {}, handler: compatibilityHandler }],
  ]));
  const client = new Client({ name: "completion-predecessor", version: "1" });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer);
  await client.connect(reader);
  return { server, client, compatibilityHandler };
}

describe("registered completion predecessor boundary", () => {
  it.each([false, true])("forwards a typed predecessor losslessly with replacement=%s", async (replacement) => {
    completionApi.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({
      data: { completed: false, proof_attached: true, state: "awaiting_review" },
      meta: { apiVersion: "1", workspaceId: WORKSPACE_ID },
    }));
    const { server, client } = await connectCompletionOperations();
    const modality_proof = { kind: "execution", status: "passed", artifact_version: 1,
      checked_at: "2026-10-10T07:01:00Z", evidence_refs: [{ url: "https://example.test/ci/1", hash: "actual-sha" }] };
    try {
      const result = await client.callTool({ name: "orgx_complete_work_with_proof", arguments: {
        type: "task", id: TASK_ID,
        artifact: { ...completionArtifact, modality_proof, ...(replacement ? { predecessor } : {}) },
      } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(completionApi.callOrgxApiJson).toHaveBeenCalledOnce();
      const [, path, init] = completionApi.callOrgxApiJson.mock.calls[0];
      expect(path).toBe("/api/v1/workflows/complete-with-proof");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^mcp-proof:[a-f0-9]{64}$/);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ type: "task", id: TASK_ID, workspace_id: WORKSPACE_ID,
        artifact: { artifact_type: "eng.diff_pack", artifact_url: completionArtifact.external_url, modality_proof } });
      if (replacement) expect(body.artifact.predecessor).toEqual(predecessor);
      else expect(body.artifact).not.toHaveProperty("predecessor");
      expect(result.structuredContent).toMatchObject({ data: { completed: false, proof_attached: true } });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it.each([
    null,
    { ...predecessor, artifact_id: "not-a-uuid" },
    { ...predecessor, expected_version: 0 },
    { ...predecessor, expected_version: -1 },
    { ...predecessor, expected_version: 1.5 },
    { ...predecessor, expected_version: 2_147_483_648 },
    { ...predecessor, expected_version: "2" },
    { ...predecessor, expected_updated_at: "2026-10-10T07:00:00" },
    { ...predecessor, expected_updated_at: "not-a-date" },
    { ...predecessor, force: true },
    { ...predecessor, status: "approved" },
    { ...predecessor, quality_score: 5 },
    { ...predecessor, user_id: TASK_ID },
    { artifact_id: predecessor.artifact_id, expected_version: 2 },
  ])("rejects malformed or privileged predecessor fields before API effects: %j", async (invalid) => {
    completionApi.callOrgxApiJson.mockReset();
    const { server, client, compatibilityHandler } = await connectCompletionOperations();
    try {
      const result = await client.callTool({ name: "orgx_complete_work_with_proof", arguments: {
        type: "task", id: TASK_ID, artifact: { ...completionArtifact, predecessor: invalid },
      } });
      expect(result.isError).toBe(true);
      expect(completionApi.callOrgxApiJson).not.toHaveBeenCalled();
      expect(compatibilityHandler).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it("returns a predecessor conflict without retrying or manufacturing completion", async () => {
    const conflict = { data: { completed: false, proof_attached: false, artifact: null,
      state: "failed", error: { code: "conflict", message: "Predecessor revision changed" } },
      meta: { apiVersion: "1", workspaceId: WORKSPACE_ID } };
    completionApi.callOrgxApiJson.mockReset().mockResolvedValue(Response.json(conflict, { status: 409 }));
    const { server, client } = await connectCompletionOperations();
    try {
      const result = await client.callTool({ name: "orgx_complete_work_with_proof", arguments: {
        type: "task", id: TASK_ID, artifact: { ...completionArtifact, predecessor },
      } });
      expect(result.structuredContent).toEqual(conflict);
      expect(completionApi.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(result.structuredContent).toMatchObject({ data: { completed: false, proof_attached: false } });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it("keeps replacement out of generic attach and milestone batch contracts", async () => {
    const attach = getWorkflowToolContract("orgx_attach_artifact")!;
    expect(z.object(attach.inputSchema).strict().safeParse({ type: "task", id: TASK_ID,
      name: "Ordinary attachment", artifact_type: "eng.diff_pack",
      location: { external_url: completionArtifact.external_url }, predecessor }).success).toBe(false);
    completionApi.callOrgxApiJson.mockReset();
    const { server, client, compatibilityHandler } = await connectCompletionOperations();
    try {
      for (const call of [
        { name: "orgx_attach_artifact", arguments: { type: "task", id: TASK_ID,
          name: "Ordinary attachment", artifact_type: "eng.diff_pack",
          location: { external_url: completionArtifact.external_url, predecessor } } },
        { name: "orgx_ship_batch_work", arguments: { type: "milestone", id: TASK_ID,
          artifact: { ...completionArtifact, predecessor } } },
      ]) expect((await client.callTool(call)).isError).toBe(true);
      expect(completionApi.callOrgxApiJson).not.toHaveBeenCalled();
      expect(compatibilityHandler).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});

describe("buildCompletionProofMetadata", () => {
  it("claims nothing the caller did not assert", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://github.com/hope/orgx/pull/42",
      qualityScore: 4.7,
      verification: ["pnpm vitest run tests/focused.spec.ts"],
      createdByType: "agent",
      createdById: "engineering-agent",
      sourceClient: "codex",
      runOrSessionRef: "run-123",
    });

    expect(metadata).toMatchObject({
      atomic_unit_type: "completion_proof",
      artifact_hash: "https://github.com/hope/orgx/pull/42",
      // The caller passed evidence and a score, but asserted NOTHING about
      // validation, approval, evals or verification. None of those may be
      // manufactured on its behalf.
      schema_validated: false,
      schema_validated_artifact: false,
      completion_state: "completed",
      proof_state: "in_review",
      quality_eval_state: "missing",
      outcome_event_status: "completion_claimed",
      source_tool: "entity_action.complete_with_proof",
      source_client: "codex",
      owner_source: "entity_action.complete_with_proof",
      run_or_session_ref: "run-123",
      run_ref: "run-123",
      created_by_type: "agent",
      created_by_id: "engineering-agent",
      next_action: "verify_before_claiming_outcome",
      quality_score: 4.7,
      task_id: "task-1",
    });
  });

  it("passes a caller's real assertions through untouched", () => {
    // The fix must not punish honest callers. Someone who genuinely ran schema
    // validation and holds an approval still gets exactly what they asserted.
    //
    // Whether they were ALLOWED to assert it is not decided here — this worker
    // is public and is a client of the API. Permission is enforced in the
    // private monorepo at the write boundary.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://github.com/hope/orgx/pull/42",
      schemaValidated: true,
      createdByType: "agent",
      metadata: {
        proof_state: "approved",
        quality_eval_state: "passed",
        outcome_event_status: "completion_verified",
      },
    });

    expect(metadata).toMatchObject({
      schema_validated: true,
      schema_validated_artifact: true,
      proof_state: "approved",
      quality_eval_state: "passed",
      outcome_event_status: "completion_verified",
    });
  });

  it("never upgrades a claim when the caller is silent", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    });

    for (const [field, forbidden] of [
      ["schema_validated", true],
      ["schema_validated_artifact", true],
      ["proof_state", "approved"],
      ["quality_eval_state", "passed"],
      ["outcome_event_status", "completion_verified"],
    ] as const) {
      expect(
        (metadata as Record<string, unknown>)[field],
        `${field} must not default to ${String(forbidden)}`
      ).not.toBe(forbidden);
    }
  });

  it("keeps the nested proof packet consistent with the top level", () => {
    // proofPacketMigrationPlan reads proof.* as canonical with the top level
    // only as fallback, so a nested packet that still says "completion_verified"
    // silently wins over an honest top level. An earlier pass fixed only the top
    // level and shipped exactly that contradiction.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    }) as Record<string, any>;

    expect(metadata.proof.state).toBe(metadata.proof_state);
    expect(metadata.proof.eval.status).toBe(metadata.quality_eval_state);
    expect(metadata.proof.outcome_status).toBe(metadata.outcome_event_status);
    expect(metadata.proof.next_action).toBe(metadata.next_action);

    expect(metadata.proof.state).not.toBe("approved");
    expect(metadata.proof.eval.status).not.toBe("passed");
    expect(metadata.proof.outcome_status).not.toBe("completion_verified");
  });

  it("only emits values the canonical proof-packet contract allows", () => {
    // lib/server/proof/proofPacketContract.ts defines these enums. Inventing a
    // value that reads as honest but is not in the contract is the same class of
    // error as inventing a claim about it — and validateProofPacketV0 checks
    // presence, not enum membership, so nothing downstream would catch it.
    const PROOF_STATES = [
      "draft",
      "in_review",
      "approved",
      "changes_requested",
      "superseded",
    ];
    const EVAL_STATES = ["missing", "pending", "passed", "failed", "skipped"];

    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    }) as Record<string, any>;

    expect(PROOF_STATES).toContain(metadata.proof_state);
    expect(EVAL_STATES).toContain(metadata.quality_eval_state);
    expect(PROOF_STATES).toContain(metadata.proof.state);
    expect(EVAL_STATES).toContain(metadata.proof.eval.status);
  });

  it("preserves caller-authored proof state and next action", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      artifactHash: "sha256:abc",
      metadata: {
        outcome_event_status: "merged",
        next_action: "verify production",
        source_tool: "github.pull_request",
      },
    });

    expect(metadata).toMatchObject({
      artifact_hash: "sha256:abc",
      outcome_event_status: "merged",
      next_action: "verify production",
      source_tool: "github.pull_request",
    });
  });
  it("refuses a value the contract does not define, at both levels", () => {
    // TypeScript casts do not protect an API boundary. A probe with
    // proof_state:"bogus" previously emitted "bogus" verbatim.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/e",
      createdByType: "agent",
      metadata: { proof_state: "bogus", quality_eval_state: "not_run" },
    }) as Record<string, any>;

    expect(metadata.proof_state).toBe("in_review");
    expect(metadata.quality_eval_state).toBe("missing");
    expect(metadata.proof.state).toBe("in_review");
    expect(metadata.proof.eval.status).toBe("missing");
  });

  it("keeps top level and nested consistent for a nested-only caller", () => {
    // The top level used to ignore metadata.proof.*, so a nested-only caller
    // produced a packet whose two halves disagreed.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/e",
      createdByType: "agent",
      metadata: {
        proof: { outcome_status: "merged", next_action: "watch rollout" },
      },
    }) as Record<string, any>;

    expect(metadata.outcome_event_status).toBe("merged");
    expect(metadata.proof.outcome_status).toBe("merged");
    expect(metadata.next_action).toBe("watch rollout");
    expect(metadata.proof.next_action).toBe("watch rollout");
  });
});

describe("executeCompleteWithProofFlow", () => {
  it("attaches proof, verifies it, and calls canonical complete", async () => {
    const callApi = vi.fn(async (path: string) => {
      if (path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: "artifact-1" } };
      }
      if (path.startsWith("/api/entities/verify?")) {
        return {
          ok: true,
          verification: { verified: true, blockers: [] },
        };
      }
      if (path === "/api/entities/task/task-1/complete") {
        return {
          success: true,
          transition: { from: "in_progress", to: "done" },
          forced_proof_completion: false,
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    });

    const result = await executeCompleteWithProofFlow({
      entityType: "task",
      entityId: "task-1",
      attachPayload: {
        entity_type: "task",
        entity_id: "task-1",
        artifact_url: "https://github.com/hope/orgx/pull/42",
      },
      completeBody: { force: false, user_id: "user-1" },
      callApi,
    });

    expect(callApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/client/artifacts",
      "/api/entities/verify?type=task&id=task-1",
      "/api/entities/task/task-1/complete",
    ]);
    expect(
      callApi.mock.calls.some(([path]) =>
        String(path).endsWith("/complete_with_proof"),
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      completed: true,
      attachResult: { artifact: { id: "artifact-1" } },
      verification: { verified: true },
      completeResult: { forced_proof_completion: false },
    });
  });

  it("stops after verification when proof is blocked", async () => {
    const callApi = vi.fn(async (path: string) => {
      if (path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: "artifact-1" } };
      }
      if (path.startsWith("/api/entities/verify?")) {
        return {
          ok: true,
          verification: {
            verified: false,
            blockers: ["Proof-chain blocker: incomplete_execution_proof"],
          },
        };
      }
      throw new Error(`Completion must not run after a blocked verifier: ${path}`);
    });

    const result = await executeCompleteWithProofFlow({
      entityType: "task",
      entityId: "task-1",
      attachPayload: {
        entity_type: "task",
        entity_id: "task-1",
        artifact_url: "https://github.com/hope/orgx/pull/42",
      },
      completeBody: { force: false, user_id: "user-1" },
      callApi,
    });

    expect(callApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/client/artifacts",
      "/api/entities/verify?type=task&id=task-1",
    ]);
    expect(result).toMatchObject({
      completed: false,
      verification: {
        verified: false,
        blockers: ["Proof-chain blocker: incomplete_execution_proof"],
      },
      completeResult: null,
    });
  });
});
