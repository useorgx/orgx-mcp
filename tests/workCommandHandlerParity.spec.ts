import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
const callApi = vi.hoisted(() => vi.fn());
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: vi.fn() }; } static serveSSE() { return { fetch: vi.fn() }; } } }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), wrapMcpServerWithSentry: <T>(value: T) => value, withSentry: <T>(_opts: unknown, value: T) => value }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(), callOrgxApiJson: callApi }));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-5222-8222-222222222222';

async function connect() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = { workspaceId };
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.test' };
  worker.resolveUserId = () => 'fixture-owner';
  worker.resolveUserEmail = () => 'fixture@example.test';
  worker.resolveOrgxUserId = () => workspaceId;
  worker.delegationClaims = () => ({ grantedScopes: ['initiatives:write'] });
  worker.buildAuthRequiredResponse = () => null;
  worker.withOrgx = (fn: () => unknown) => fn();
  const server = new McpServer({ name: 'work-command-parity', version: '1' });
  for (const id of ['orgx_create_work', 'orgx_complete_work']) {
    const contract = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === id)!;
    server.registerTool(id, { inputSchema: contract.inputSchema }, (args) => worker.executeContractTool(id, args, contract.securitySchemes));
  }
  const client = new Client({ name: 'work-command-parity', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer); await client.connect(reader);
  return { server, client };
}

describe('actual MCP work command response parity', () => {
  it('keeps command_id from the canonical task on an idempotent retry', async () => {
    callApi.mockReset().mockImplementation(async (_env, _path, request) => {
      const body = JSON.parse(request.body);
      expect(body).not.toHaveProperty('command_id');
      expect(body).not.toHaveProperty('initiative_id');
      return Response.json({ data: { taskId, duplicate: true, task: { id: taskId, metadata: { command_id: taskId } } }, meta: { apiVersion: '1', workspaceId } });
    });
    const { client, server } = await connect();
    try {
      const args = { title: 'Register proof', idempotency_key: 'stable-fixture' };
      const first = await client.callTool({ name: 'orgx_create_work', arguments: args });
      const second = await client.callTool({ name: 'orgx_create_work', arguments: args });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({ taskId, command_id: taskId, idempotency_key: 'stable-fixture' });
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(callApi).toHaveBeenCalledTimes(2);
      expect(callApi.mock.calls[0][2].body).toBe(callApi.mock.calls[1][2].body);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it('forwards a token and measured zero with one canonical request', async () => {
    callApi.mockReset().mockImplementation(async (_env, path, request) => {
      expect(path).toBe('/api/v1/commands/complete-work');
      const body = JSON.parse(request.body);
      expect(body).toMatchObject({ task_id: taskId, version_token: 'server-issued-fixture', actual_hours: 0 });
      expect(body).not.toHaveProperty('expected_updated_at');
      return Response.json({ data: { taskId, duplicate: false } });
    });
    const { client, server } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_complete_work', arguments: { task_id: taskId, version_token: 'server-issued-fixture', actual_hours: 0, idempotency_key: 'complete-fixture' } });
      expect(result.isError).not.toBe(true);
      expect(callApi).toHaveBeenCalledOnce();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
