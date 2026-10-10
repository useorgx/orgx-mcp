import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentWorkReceiptImportRequest } from '../src/agentWorkReceiptV1';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { WORK_LEDGER_OUTPUT_VARIANTS } from './fixtures/workLedgerOutputVariants';
import { findBooleanAdditionalProperties } from './fixtures/outputSchemaPortability';

const api = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: vi.fn() }; } static serveSSE() { return { fetch: vi.fn() }; } } }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), wrapMcpServerWithSentry: <T>(server: T) => server, withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(), callOrgxApiJson: api.callOrgxApiJson }));
const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

async function connect(extraToolIds: string[] = [], session: { sessionContext?: Record<string, unknown>; inferSessionWorkspace?: () => Promise<{ id: string; name: string | null } | null> } = {}) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = session.sessionContext ?? { workspaceId: WS };
  if (session.inferSessionWorkspace) worker.inferSessionWorkspace = session.inferSessionWorkspace;
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.orgx.test' };
  worker.resolveUserId = () => 'fixture-user'; worker.resolveUserEmail = () => 'member@example.test'; worker.resolveOrgxUserId = () => ID;
  worker.delegationClaims = () => ({ grantedScopes: ['initiatives:read', 'initiatives:write'] });
  worker.resolveReportingSourceClient = () => ({ name: 'named-ledger-reader', version: '1' });
  worker.buildAuthRequiredResponse = () => null; worker.withOrgx = (callback: () => unknown) => callback();
  worker.withClientContext = (shape: unknown) => shape;
  const server = new McpServer({ name: 'named-ledger-contract', version: '1' }); worker.server = server;
  const visible = new Set(['orgx_list_work_receipts', 'orgx_get_work_receipt', 'orgx_attach_artifact', ...extraToolIds]);
  installToolResultGuidanceWrapper(server, visible);
  // The same production registration method used by _doInit, with the real
  // compatibility handler captured behind the fixed artifact operation.
  worker.registerPublicOperations(visible, new Map([['orgx_attach', { config: {}, handler: (args: Record<string, unknown>) => worker.executeContractTool('orgx_attach', args) }]]));
  const client = new Client({ name: 'named-ledger-reader', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer); await client.connect(reader);
  return { server, client, worker };
}

describe('registered named work ledger operation', () => {
  it('infers the authenticated workspace when the session has none selected, as the panel does', async () => {
    // The ChatGPT connector: authenticated, nothing selected. The ledger used to
    // refuse with "Select an authenticated workspace" while the panel's own
    // reads inferred one and worked.
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ ok: true, data: structuredClone(WORK_LEDGER_OUTPUT_VARIANTS[0]!.data) }));
    const infer = vi.fn(async () => ({ id: WS, name: null }));
    const { server, client } = await connect([], { sessionContext: {}, inferSessionWorkspace: infer });
    try {
      const result = await client.callTool({ name: 'orgx_list_work_receipts', arguments: { view: 'receipts', limit: 3, query: 'ledger' } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(infer).toHaveBeenCalledTimes(1);
      const path = new URL(api.callOrgxApiJson.mock.calls[0][1], 'https://orgx.test');
      expect(path.searchParams.get('workspace_id')).toBe(WS);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it('does not infer when the caller names a workspace', async () => {
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ ok: true, data: structuredClone(WORK_LEDGER_OUTPUT_VARIANTS[0]!.data) }));
    const infer = vi.fn(async () => null);
    const { server, client } = await connect([], { sessionContext: {}, inferSessionWorkspace: infer });
    try {
      const result = await client.callTool({ name: 'orgx_list_work_receipts', arguments: { view: 'receipts', limit: 3, query: 'ledger', workspace_id: WS } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(infer).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it.each(WORK_LEDGER_OUTPUT_VARIANTS.slice(0, 3))('delivers $view from the actual registered tool with closed output and bounded guidance', async (variant) => {
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ ok: true, data: structuredClone(variant.data) }));
    const { server, client } = await connect();
    const view = variant.view === 'search' ? 'receipts' : variant.view;
    try {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === 'orgx_list_work_receipts')!;
      expect(descriptor.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(findBooleanAdditionalProperties(descriptor.outputSchema)).toEqual([]);
      const result = await client.callTool({ name: descriptor.name, arguments: { view, limit: 7, ...(view === 'receipts' ? { query: 'ledger outcome:succeeded' } : {}) } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, view, ...variant.data });
      expect(result.structuredContent?.next_calls).not.toEqual([]);
      expect(JSON.stringify(result.structuredContent?.next_calls)).not.toContain('orgx_search');
      const path = new URL(api.callOrgxApiJson.mock.calls[0][1], 'https://orgx.test');
      expect(path.pathname).toBe(variant.path); expect(path.searchParams.get('workspace_id')).toBe(WS);
      expect(path.searchParams.get('limit')).toBe('7'); expect(api.callOrgxApiJson.mock.calls[0][2].method).toBe('GET');
      if (view === 'receipts') expect(path.searchParams.get('q')).toBe('ledger outcome:succeeded');
      const schema = getToolOutputSchema('orgx_list_work_receipts')!;
      expect(schema.safeParse({ ...result.structuredContent, unknown_business_field: true }).success).toBe(false);
      expect(schema.safeParse({ ...result.structuredContent, workstreams: 'invalid' }).success).toBe(false);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it.each([{ view: 'delete' }, { scope: 'work_ledger' }, { action: 'approve' }, { limit: 101 }])('refuses selectors outside the bounded read contract: %j', async (args) => {
    api.callOrgxApiJson.mockReset(); const { server, client } = await connect();
    try {
      expect((await client.callTool({ name: 'orgx_list_work_receipts', arguments: args })).isError).toBe(true);
      expect(api.callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it.each([false, true])('retains typed artifact metadata through the actual public alias with duplicate=%s', async (duplicate) => {
    const meta = { apiVersion: '1', artifactTypeFallback: false, effectiveArtifactType: 'eng.diff_pack', duplicate };
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ data: { id: ID }, meta }, { status: duplicate ? 200 : 201 }));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_attach_artifact', arguments: { type: 'task', id: ID, name: 'Proof', artifact_type: 'eng.diff_pack', location: { external_url: 'https://example.test/proof' }, idempotency_key: 'meta-fixture' } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { id: ID }, meta });
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(api.callOrgxApiJson.mock.calls[0][1]).toBe('/api/client/artifacts');
      expect(JSON.parse(api.callOrgxApiJson.mock.calls[0][2].body).status).toBe('in_review');
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});

const NONBLANK_PATTERN = '^[\\s\\S]*\\S[\\s\\S]*$';

function portableReceipt() {
  const { body } = buildAgentWorkReceiptImportRequest({
    receipt_type: 'proof', summary: 'Recorded bounded execution evidence',
    evidence: { links: ['https://example.test/review/496'] }, verification_status: 'passed',
  }, { workspaceId: WS, receiptId: 'codex-living-work-memory-trail-execution-fixture-v1', issuedAt: '2026-10-10T00:00:00.000Z' });
  return {
    ...body.receipt, schema_version: 'agent-work-receipt/v0.2',
    intent: {
      ...(body.receipt.intent as object),
      summary: 'Record actual execution evidence at a pinned commit.\nPreserve commands, digests and bounded local benchmark results — résumé 📎.',
      objective: 'Keep independent review pending until a person evaluates the evidence.',
      criteria: [{ id: 'receipt-compatibility', text: 'Portable receipt text reaches validation intact.\nProducer success remains a claim.', required: true, source: 'requested' }],
    },
    outcome: { ...(body.receipt.outcome as object), criteria_results: [{ criterion_id: 'receipt-compatibility', status: 'met', evidence_ids: ['evidence-1'], confidence: 0.7 }] },
    provenance: [{ path: '/outcome/status', basis: 'declared', confidence: 0.7 }],
    extensions: { 'org.orgx.review/v1': { version: 'org.orgx.review/v1', criteria: [{ criterion_id: 'receipt-compatibility' }], episodes: [], sources: [] } },
  };
}

/** Model a consumer that applies full-string regex matching to every pattern.
 * All other advertised JSON Schema constraints are retained by the real SDK
 * validator; this does not replace structural validation with a string walk. */
function patternConsumerSchema(schema: unknown, fullMatch: boolean, legacyNonblank = false): any {
  if (Array.isArray(schema)) return schema.map((value) => patternConsumerSchema(value, fullMatch, legacyNonblank));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key !== 'pattern' || typeof value !== 'string') return [key, patternConsumerSchema(value, fullMatch, legacyNonblank)];
    const pattern = legacyNonblank && value === NONBLANK_PATTERN ? '\\S' : value;
    return [key, fullMatch ? `^(?:${pattern})$` : pattern];
  }));
}

describe('registered portable receipt input compatibility', () => {
  it.each(['orgx_validate_work_receipt', 'orgx_submit_work_receipt'])('preserves a complete multiline receipt through strict SDK and both pattern consumers: %s', async (name) => {
    const document = portableReceipt();
    const response = name === 'orgx_validate_work_receipt'
      ? { ok: true, valid: true, persistence: { stored: false, import_requires_authentication: true } }
      : { ok: true, receipt_id: ID, external_receipt_id: document.receipt_id, schema_version: document.schema_version, idempotent: false };
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json(response));
    const { server, client } = await connect([name]);
    try {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === name)!;
      const args = { receipt: document, ...(name === 'orgx_submit_work_receipt' ? { idempotency_key: 'portable-compatible-v1' } : {}) };
      for (const fullMatch of [false, true]) {
        const validation = new AjvJsonSchemaValidator().getValidator(patternConsumerSchema(descriptor.inputSchema, fullMatch))(args);
        expect(validation.valid, JSON.stringify(validation)).toBe(true);
      }
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const sent = JSON.parse(api.callOrgxApiJson.mock.calls[0][2].body);
      expect(name === 'orgx_validate_work_receipt' ? sent : sent.receipt).toEqual(document);
      if (name === 'orgx_validate_work_receipt') expect(result.structuredContent?.persistence).toEqual({ stored: false, import_requires_authentication: true });
      else expect(result.structuredContent?.effects).toMatchObject({ work_status_changed: false, authoritative_verification_changed: false, human_acceptance_changed: false });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('reproduces the legacy pattern rejection only under full-string matching', async () => {
    const { server, client } = await connect(['orgx_validate_work_receipt']);
    try {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === 'orgx_validate_work_receipt')!;
      const args = { receipt: portableReceipt() };
      const standard = new AjvJsonSchemaValidator().getValidator(patternConsumerSchema(descriptor.inputSchema, false, true))(args);
      const fullMatch = new AjvJsonSchemaValidator().getValidator(patternConsumerSchema(descriptor.inputSchema, true, true))(args);
      expect(standard.valid).toBe(true);
      expect(fullMatch.valid).toBe(false);
      expect(fullMatch.errorMessage).toContain('pattern');
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it.each(['receipt_id', 'summary', 'actor_id'])('rejects whitespace-only %s before the handler and in both schema consumers', async (field) => {
    api.callOrgxApiJson.mockReset();
    const { server, client } = await connect(['orgx_validate_work_receipt']);
    try {
      const document = portableReceipt();
      if (field === 'receipt_id') document.receipt_id = ' \t\r\n\u00a0\u2028';
      else if (field === 'summary') document.intent.summary = ' \t\r\n\u00a0\u2028';
      else (document.actor as { id: string }).id = ' \t\r\n\u00a0\u2028';
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === 'orgx_validate_work_receipt')!;
      const args = { receipt: document };
      for (const fullMatch of [false, true]) expect(new AjvJsonSchemaValidator().getValidator(patternConsumerSchema(descriptor.inputSchema, fullMatch))(args).valid).toBe(false);
      expect((await client.callTool({ name: descriptor.name, arguments: args })).isError).toBe(true);
      expect(api.callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
