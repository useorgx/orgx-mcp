import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getWorkflowToolContract } from '../src/workflowTools';
import { taskProofCompletionRequest } from '../src/workflowCompletion';
import { normalizeProofRevisionDescription, PROOF_REVISION_DESCRIPTION_PREFIX as prefix } from '../src/proofRevisionDescription';

const api = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(),
  callOrgxApiJson: api.callOrgxApiJson }));

const workspace = '11111111-1111-4111-8111-111111111111';
const task = '22222222-2222-4222-8222-222222222222';
const predecessor = { artifact_id: '33333333-3333-4333-8333-333333333333', expected_version: 2,
  expected_updated_at: '2026-10-10T07:00:00.123456Z' };
const artifact = { artifact_type: 'eng.pull_request', external_url: 'https://example.test/pr/1',
  artifact_hash: 'actual-head', atomic_unit_type: 'pull_request', description: 'Corrected implementation proof.' };
const encoded = prefix + JSON.stringify({ predecessor, description: artifact.description });
const modality = { kind: 'execution', status: 'passed', artifact_version: 1,
  checked_at: '2026-10-10T07:01:00Z', evidence_refs: [{ url: 'https://example.test/ci/1', hash: 'actual-sha' }] };

async function connect() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = { workspaceId: workspace };
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.orgx.test' };
  worker.resolveUserId = () => 'fixture-user';
  worker.resolveUserEmail = () => 'member@example.test';
  worker.resolveOrgxUserId = () => task;
  worker.delegationClaims = () => ({ grantedScopes: ['initiatives:read', 'initiatives:write'] });
  worker.buildAuthRequiredResponse = () => null;
  worker.withOrgx = (callback: () => unknown) => callback();
  worker.withClientContext = (shape: unknown) => shape;
  const server = new McpServer({ name: 'proof-revision-description', version: '1' });
  worker.server = server;
  const compatibilityHandler = vi.fn(async () => ({ content: [] }));
  worker.registerPublicOperations(new Set(['orgx_complete_work_with_proof']),
    new Map([['orgx_act', { config: {}, handler: compatibilityHandler }]]));
  const client = new Client({ name: 'proof-revision-description', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer);
  await client.connect(reader);
  return { server, client, compatibilityHandler };
}

describe('published completion description revision contract', () => {
  it('roundtrips through the registered tool using only old declared fields', async () => {
    const blocked = { data: { completed: false, proof_attached: true, state: 'blocked',
      verification: { ready: false, blockers: ['Independent review pending'] } },
      meta: { apiVersion: '1', workspaceId: workspace } };
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json(blocked));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_complete_work_with_proof', arguments: {
        type: 'task', id: task, idempotency_key: 'proof-revision-retry', artifact: { ...artifact, description: encoded },
        verification: [`orgx:modality-proof:v1:${JSON.stringify(modality)}`],
      } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(blocked);
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const [, path, init, options] = api.callOrgxApiJson.mock.calls[0];
      expect(path).toBe('/api/v1/workflows/complete-with-proof');
      expect(options).toMatchObject({ allowFallback: false });
      expect(JSON.parse(init.body).artifact).toMatchObject({ predecessor,
        description: artifact.description, artifact_hash: artifact.artifact_hash,
        atomic_unit_type: artifact.atomic_unit_type });
      const typed = await taskProofCompletionRequest({ type: 'task', id: task, workspace_id: workspace,
        artifact: { ...artifact, predecessor }, verification: [`orgx:modality-proof:v1:${JSON.stringify(modality)}`],
        idempotency_key: 'proof-revision-retry' });
      expect(init.body).toBe(JSON.stringify(typed.body));
      expect(new Headers(init.headers).get('Idempotency-Key')).toBe(typed.idempotencyKey);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('binds each revision witness and restored description while retaining identical retry identity', async () => {
    const args = { type: 'task', id: task, artifact: { ...artifact, description: encoded } };
    const first = await taskProofCompletionRequest(args);
    expect(await taskProofCompletionRequest(args)).toEqual(first);
    for (const change of [
      { predecessor: { ...predecessor, expected_version: 3 } },
      { predecessor: { ...predecessor, expected_updated_at: '2026-10-10T07:00:00.123457Z' } },
      { predecessor: { ...predecessor, artifact_id: workspace } },
      { description: 'Different proof description.' },
    ]) {
      const description = prefix + JSON.stringify({ predecessor, description: artifact.description, ...change });
      expect((await taskProofCompletionRequest({ ...args, artifact: { ...artifact, description } })).idempotencyKey)
        .not.toBe(first.idempotencyKey);
    }
    expect(await taskProofCompletionRequest({ ...args, idempotency_key: 'explicit-retry' }))
      .toMatchObject({ idempotencyKey: 'explicit-retry' });
  });

  it.each([
    prefix + '{', prefix + '{}', prefix + '[]',
    prefix + JSON.stringify({ predecessor, status: 'approved' }),
    prefix + JSON.stringify({ predecessor, quality_score: 5 }),
    prefix + JSON.stringify({ predecessor: { ...predecessor, expected_version: 0 } }),
    prefix + JSON.stringify({ predecessor: { ...predecessor, expected_updated_at: 'today' } }),
    prefix + JSON.stringify({ predecessor: { ...predecessor, owner_id: task } }),
    prefix + `{"predecessor":${JSON.stringify(predecessor)},"predecessor":${JSON.stringify(predecessor)}}`,
    'orgx:proof-revision:v2:' + JSON.stringify({ predecessor }),
    prefix + JSON.stringify({ predecessor }, null, 2),
    prefix + JSON.stringify({ predecessor, description: 'x'.repeat(4000) }),
    prefix + JSON.stringify({ predecessor, description: prefix + JSON.stringify({ predecessor }) }),
  ])('rejects malformed or privileged carrier material before HTTP effects: %s', async (description) => {
    api.callOrgxApiJson.mockReset();
    const { server, client, compatibilityHandler } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_complete_work_with_proof', arguments: {
        type: 'task', id: task, artifact: { ...artifact, description } } });
      expect(result.isError).toBe(true);
      expect(api.callOrgxApiJson).not.toHaveBeenCalled();
      expect(compatibilityHandler).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('rejects typed disagreement and parent-target carriers without compatibility fallback', async () => {
    const contract = getWorkflowToolContract('orgx_complete_work_with_proof')!;
    expect(z.object(contract.inputSchema).strict().safeParse({ type: 'task', id: task,
      artifact: { ...artifact, description: encoded, predecessor: { ...predecessor, expected_version: 3 } } }).success).toBe(false);
    expect(() => contract.toCanonicalArgs({ type: 'milestone', id: task,
      artifact: { ...artifact, description: encoded } })).toThrow('only to tasks');
  });

  it('does not reinterpret ordinary descriptions or create review authority', () => {
    const ordinary = { ...artifact, description: 'Source verification passed; independent review pending.' };
    expect(normalizeProofRevisionDescription(ordinary)).toBe(ordinary);
    const normalized = normalizeProofRevisionDescription({ ...artifact, description: encoded });
    expect(normalized).toEqual({ ...artifact, predecessor });
    expect(normalized).not.toHaveProperty('quality_score');
    expect(normalized).not.toHaveProperty('status');
  });
});
