import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/toolDefinitions", () => ({
  CHATGPT_TOOL_DEFINITIONS: [],
  PLAN_SESSION_TOOLS: [],
  CLIENT_INTEGRATION_TOOL_DEFINITIONS: [],
  STREAM_TOOL_DEFINITIONS: [],
}));
vi.mock("../src/contractTools", () => ({
  CONTRACT_TOOL_DEFINITIONS: [],
  INLINE_TOOL_CONTRACTS: {},
}));
vi.mock("../src/flywheelTools", () => ({ FLYWHEEL_TOOL_DEFINITIONS: [] }));
vi.mock("../src/mcpActivationTracker", () => ({
  MCP_ACTIVATION_MILESTONES: {},
}));
vi.mock("../src/toolProfiles", () => ({ TOOL_PROFILE_NAMES: [] }));
vi.mock("../src/deprecatedTools", () => ({ DEPRECATED_TOOL_IDS: [] }));
import { recordOAuthJourney } from "../src/oauthJourneyTelemetry";
import { handleConsentJourneyEvent } from "../src/consentJourneyEvents";
import { sanitizeWorkerTelemetryProperties } from "../src/workerTelemetryPrivacy";
const journeyId = "f591f6f5-3d83-4e05-8a70-3ab954654091";
const userId = "036c6d38-a58e-4eb1-bd6f-4ec52c854d7d";
const fetchMock = vi.fn(async () => Response.json({ status: "Ok" }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it("records the verified client separately from reported names, with canonical identity", async () => {
  const tasks: Promise<unknown>[] = [];
  await recordOAuthJourney({
    env: { POSTHOG_KEY: "phc_fake" },
    ctx: { waitUntil: (task) => tasks.push(task) },
    state: {
      journeyId,
      clientPresentation: {
        icon: "chatgpt",
        identityTrust: "verified_redirect",
      },
      scopeSource: "server_read_default",
    },
    identity: { userId: "user_clerk", orgxUserId: userId },
    event: "mcp_oauth_grant_created",
    properties: {
      selected_scopes: ["initiatives:read"],
      state_key: "secret",
      email: "private@example.com",
    },
  });
  await Promise.all(tasks);
  const event = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).batch[0];
  expect(event).toMatchObject({
    distinct_id: userId,
    properties: {
      oauth_client: "chatgpt",
      oauth_journey_id: journeyId,
      selected_scopes: ["initiatives:read"],
    },
  });
  expect(JSON.stringify(event)).not.toContain("private");
  expect(JSON.stringify(event)).not.toContain("secret");
  await recordOAuthJourney({
    env: { POSTHOG_KEY: "phc_fake" },
    ctx: { waitUntil: (task) => tasks.push(task) },
    state: {
      journeyId,
      clientPresentation: {
        icon: "chatgpt",
        identityTrust: "registered_metadata",
      },
    },
    event: "mcp_oauth_started",
  });
  expect(
    JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).batch[0].properties
      .oauth_client,
  ).toBe("unknown");
});
it("keeps consent telemetry inside closed vocabularies", () => {
  expect(
    sanitizeWorkerTelemetryProperties({
      selected_scopes: ["memory:read", "private:scope"],
      consent_resource: "private-work-name",
      consent_level: "write",
      oauth_journey_id: "bad",
      state_key: journeyId,
    }),
  ).toEqual({
    selected_scopes: ["memory:read"],
    consent_resource: "other",
    consent_level: "write",
  });
});
it("requires a live same-origin consent session and resolves identity only from KV", async () => {
  const kv = vi.fn(async (key: string) =>
    key.startsWith("auth_state:")
      ? JSON.stringify({ journeyId })
      : JSON.stringify({ userId: "user_clerk", orgxUserId: userId }),
  );
  const env = { POSTHOG_KEY: "phc_fake", OAUTH_KV: { get: kv } };
  const ctx = { waitUntil: vi.fn() };
  const request = (origin: string) =>
    new Request("https://mcp.useorgx.com/oauth/consent-events", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        state_key: journeyId,
        event: "mcp_consent_selection_changed",
        userId: "spoof",
        consent_resource: "decisions",
        consent_level: "write",
      }),
    });
  expect(
    (
      await handleConsentJourneyEvent(
        request("https://attacker.example"),
        env,
        ctx,
      )
    ).status,
  ).toBe(403);
  expect(kv).not.toHaveBeenCalled();
  expect(
    (
      await handleConsentJourneyEvent(
        request("https://mcp.useorgx.com"),
        env,
        ctx,
      )
    ).status,
  ).toBe(204);
  const event = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).batch[0];
  expect(event.distinct_id).toBe(userId);
  expect(JSON.stringify(event)).not.toContain("spoof");
  kv.mockResolvedValue(null as never);
  expect(
    (
      await handleConsentJourneyEvent(
        request("https://mcp.useorgx.com"),
        env,
        ctx,
      )
    ).status,
  ).toBe(410);
});
