import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { buildMetricExpectationRequest } from '../src/metricExpectationContract';
import { buildTaskPredictionRequest } from '../src/taskPredictionContract';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { TASK_PREDICTION_INPUT, TASK_PREDICTION_RESPONSE, TASK_PREDICTION_WORKSPACE_ID } from './fixtures/taskPrediction';

const callOrgxApiJson = vi.hoisted(() => vi.fn());
vi.mock('agents/mcp', () => ({ McpAgent: class McpAgent {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class OAuthState {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class OAuthProvider {} }));
vi.mock('../src/orgxApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orgxApi')>(), callOrgxApiJson,
}));

async function connect() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = { workspaceId: TASK_PREDICTION_WORKSPACE_ID };
  worker.env = { ORGX_API_URL: 'https://orgx.test' };
  worker.resolveUserId = vi.fn(() => 'session-user');
  worker.resolveUserEmail = vi.fn(() => 'member@example.test');
  worker.resolveOrgxUserId = vi.fn(() => TASK_PREDICTION_RESPONSE.owner_id);
  worker.delegationClaims = vi.fn(() => ({ grantedScopes: ['initiatives:write'] }));
  worker.buildAuthRequiredResponse = vi.fn(() => null);
  worker.withOrgx = vi.fn(async (callback) => callback());
  const server = new McpServer({ name: 'task-prediction-handler', version: '1' });
  const contract = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === 'orgx_expect')!;
  installToolResultGuidanceWrapper(server, new Set(['orgx_expect', 'orgx_inspect']));
  server.registerTool('orgx_expect', { inputSchema: contract.inputSchema }, (args) =>
    worker.executeContractTool('orgx_expect', args, contract.securitySchemes));
  const client = new Client({ name: 'task-prediction-reader', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer);
  await client.connect(reader);
  return { server, client, worker };
}

describe('orgx_expect task and coverage handler', () => {
  it.each([false, true])('delivers a pending task prediction with replay=%s through strict SDK output validation', async (replayed) => {
    callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ prediction: TASK_PREDICTION_RESPONSE, replayed }, { status: replayed ? 200 : 201 }));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_expect', arguments: TASK_PREDICTION_INPUT });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ _v2_tool: 'orgx_expect', prediction: TASK_PREDICTION_RESPONSE,
        replayed, idempotency_key: TASK_PREDICTION_INPUT.idempotency_key,
        next_calls: [{ tool: 'orgx_inspect', args: { type: 'task', id: TASK_PREDICTION_INPUT.task_id } }] });
      expect(result.content).toMatchObject([{ text: `Task prediction ${replayed ? 'replayed' : 'registered'} · ${TASK_PREDICTION_RESPONSE.id} · observation pending` }]);
      const [, path, request, actor] = callOrgxApiJson.mock.calls[0];
      const expected = buildTaskPredictionRequest(TASK_PREDICTION_INPUT, { workspaceId: TASK_PREDICTION_WORKSPACE_ID });
      expect(expected.ok).toBe(true);
      if (!expected.ok) return;
      expect(path).toBe('/api/v1/expectations/tasks');
      expect(JSON.parse(request.body)).toEqual(expected.body);
      expect(request.headers).toEqual({ 'Idempotency-Key': expected.idempotencyKey });
      expect(actor).toMatchObject({ userId: 'session-user', orgxUserId: TASK_PREDICTION_RESPONSE.owner_id,
        grantedScopes: ['initiatives:write'], allowFallback: false });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('preserves punctuation and Unicode criterion request order while the app binds its canonical set hash', async () => {
    const criteria_predictions = ['criterion:a_1', 'criterion:a-1', 'criterion:😀', 'criterion:\uE000'].map((criterion_id) => ({ criterion_id, predicted: 'met', confidence: 0.9 }));
    const args = { ...TASK_PREDICTION_INPUT, criteria_predictions };
    callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ prediction: { ...TASK_PREDICTION_RESPONSE, criteria_predictions }, replayed: false }));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_expect', arguments: args });
      expect(result.isError).not.toBe(true);
      const [, path, request] = callOrgxApiJson.mock.calls[0];
      expect(path).toBe('/api/v1/expectations/tasks');
      expect(JSON.parse(request.body).criteria_predictions).toEqual(criteria_predictions);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it.each([undefined, 'metric_coverage'])('preserves the existing coverage route with mode=%s', async (mode) => {
    const args = { ...(mode ? { mode } : {}), metric: 'orgx.run_receipt_coverage.v1',
      window_starts_at: '2026-10-10T14:00:00Z', window_ends_at: '2026-10-11T14:00:00Z', idempotency_key: 'coverage:key' };
    callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ expectation: { id: 'expectation-1', state: 'pending' }, replayed: false }));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_expect', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('next_calls');
      const [, path, request] = callOrgxApiJson.mock.calls[0];
      const expected = buildMetricExpectationRequest(args, { workspaceId: TASK_PREDICTION_WORKSPACE_ID });
      if (!expected.ok) throw new Error(expected.message);
      expect(path).toBe('/api/v1/expectations');
      expect(JSON.parse(request.body)).toEqual(expected.body);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it.each([
    { ...TASK_PREDICTION_INPUT, idempotency_key: undefined },
    { ...TASK_PREDICTION_INPUT, expectation_set_id: undefined },
    { metric: 'orgx.run_receipt_coverage.v1' },
  ])('returns a structured input error without registering incomplete predictions: %j', async (args) => {
    callOrgxApiJson.mockReset();
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_expect', arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: 'invalid_input', status: 400 } });
      expect(callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
