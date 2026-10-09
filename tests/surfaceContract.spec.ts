/**
 * One public contract per profile (live-QA A1/A2/A6).
 *
 * For every profile this runs the real worker (OrgXMcp) over an in-memory MCP
 * transport and checks that these all describe the same surface:
 *
 *   runtime tools/list  ==  bootstrap visible_tools + widget_only_tools
 *   chatgpt tools/list  ==  CHATGPT_PUBLIC_SURFACE == chatgpt-app-submission.json
 *                           == OPENAI_OUTPUT_SCHEMAS (with matching annotations)
 *   v2 tools/list       ==  server.json (names and annotations)
 *   every outputTemplate / ui.resourceUri is a listed resource with a widget file
 *   every tool a served widget calls (callTool, live refresh) is on the profile,
 *     after runtime aliases, or is a documented exception (never on chatgpt/v2)
 *   one visibility per tool (openai/visibility agrees with ui.visibility), and
 *     every widget-called tool is widget-accessible
 *   the widget source, the widget runtime and src/widgetToolContract.ts agree
 *   every widget resource declares openai/widgetCSP + openai/widgetDomain, and
 *     ChatGPT clients get ui.domain on every profile
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import serverManifest from '../server.json';
import submission from '../chatgpt-app-submission.json';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { OPENAI_OUTPUT_SCHEMAS, getToolOutputSchema } from '../src/openaiOutputSchemas';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import { checkAuthRequirements } from '../src/authHelpers';
import { buildAgentWorkReceiptImportRequest } from '../src/agentWorkReceiptV1';
import { RECEIPT_OPERATION_OUTPUT_SCHEMAS } from '../src/receiptOperationTools';
import { OrgXApiError } from '../src/orgxApi';
import { WIDGET_RESOURCES } from '../src/toolDefinitions';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
  TOOL_PROFILE_NAMES,
} from '../src/toolProfiles';
import { isModelVisibleToolMeta } from '../src/toolVisibility';
import {
  CHATGPT_REACHABLE_PROFILES,
  WIDGET_CALL_PROFILE_EXCEPTIONS,
  WIDGET_ONLY_TOOL_IDS,
  WIDGET_RUNTIME_TOOL_ALIASES,
  WIDGET_TOOL_CALLS,
  isWidgetOnlyTool,
  liveRefreshToolFor,
  widgetCalledTools,
} from '../src/widgetToolContract';
import {
  WIDGET_CSP_NEEDS,
  buildWidgetMeta,
  parseWidgetResourceUri,
  widgetCspNeedsForUri,
} from '../src/widgetConfig';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
  fetchContextPack: vi.fn(),
  fetchContextPreparation: vi.fn(),
  captureWorkerPosthogEvent: vi.fn(),
}));

vi.mock('agents/mcp', () => ({
  McpAgent: class McpAgent {
    async getInitializeRequest() { return (this as any).ctx.storage.get('initializeRequest'); }
    async updateProps(props: unknown) {
      await (this as any).ctx.storage.put('props', props ?? {});
      (this as any).props = props;
    }
    static serve() {
      return { fetch: vi.fn(async () => new Response(null, { status: 501 })) };
    }
    static serveSSE() {
      return { fetch: vi.fn(async () => new Response(null, { status: 501 })) };
    }
  },
}));
vi.mock('../src/oauth', () => ({ OAuthState: class OAuthState {} }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  default: class OAuthProvider {
    async fetch() {
      return new Response(null, { status: 501 });
    }
  },
}));
vi.mock('../src/orgxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orgxApi')>();
  return {
    ...actual,
    callOrgxApiJson: apiMocks.callOrgxApiJson,
    callOrgxApiRaw: apiMocks.callOrgxApiRaw,
  };
});
vi.mock('../src/contextPack', () => ({
  fetchContextPack: apiMocks.fetchContextPack,
  fetchContextPreparation: apiMocks.fetchContextPreparation,
}));
vi.mock('../src/posthogTelemetry', () => ({
  captureWorkerPosthogEvent: apiMocks.captureWorkerPosthogEvent,
  resolveAnonymousDistinctId: () => 'surface-contract',
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';

/** Profiles a client can connect with (full is internal-only). */
const EXTERNAL_PROFILES = TOOL_PROFILE_NAMES.filter((name) => name !== 'full');
const READ_PRESET_PROFILES = new Set(['read-only']);

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: unknown;
  inputSchema?: { properties?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
};

async function connectProfile(
  profile: string,
  clientName = 'surface-contract',
  grantedScopes?: readonly string[],
  staleSession?: { previousProfile: string },
  freshSse = false,
) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile,
    ...(profile === 'full' ? { authSource: 'run_token' } : {}),
    userId: 'surface-contract-user',
    orgxUserId: '33333333-3333-4333-8333-333333333333',
    scope: (grantedScopes ?? (READ_PRESET_PROFILES.has(profile)
      ? AUTHORIZATION_PRESETS.read.scopes
      : AUTHORIZATION_PRESETS.operate.scopes
    )).join(' '),
    workspace_id: WORKSPACE_ID,
  };
  const stored = new Map<string, unknown>(staleSession ? [
    ['props', { ...worker.props, profile: staleSession.previousProfile }],
    ['initializeRequest', { jsonrpc: '2.0', method: 'initialize', id: 1 }],
  ] : []);
  worker.ctx = {
    id: { toString: () => `surface-${profile}` },
    storage: {
      get: vi.fn(async (key: string) => stored.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { stored.set(key, value); }),
      sql: { exec: vi.fn(() => []) },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test',
    ORGX_WEB_URL: 'https://useorgx.test',
    MCP_SERVER_URL: 'https://mcp.useorgx.test',
    MCP_JWT_SECRET: 'test-only-secret',
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
  };
  worker.sessionContext = {};
  worker.sessionAuth = {};
  worker.sessionSqlInitialized = false;
  worker.mcpActivationState = createEmptyMcpActivationState();
  worker.mcpSessionReentryState = createEmptyMcpSessionReentryState();
  worker._isNewSession = false;
  worker.widgetDebugEvents = [];
  worker.toolResultGuidanceInstalled = false;
  worker.fetchEntityRecord = vi.fn(async () => ({
    id: WORKSPACE_ID,
    type: 'workspace',
    title: 'Surface contract workspace',
    workspace_id: WORKSPACE_ID,
  }));
  worker.fetchEntityCollection = vi.fn(async () => []);

  if (freshSse) await worker.updateProps(worker.props);
  await worker._doInit();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, worker };
}

const pendingDecisionsPayload = {
  decisions: [{ id: 'decision-1', title: 'Ship it?', status: 'pending', urgency: 'high' }],
  total_pending: 1,
  summary: { critical: 0, high: 1, medium: 0, low: 0 },
  message: '1 decision needs you',
  proof: {
    last_accepted: {
      artifact_id: 'artifact-1',
      title: 'Accepted output',
      accepted_at: '2026-10-02T12:00:00.000Z',
      accepted_by: 'you',
      url: 'https://useorgx.com/artifacts/artifact-1',
    },
    completed_unaccepted: 2,
  },
  _widget_meta: { approval_tokens: { 'decision-1': 'signed-token' } },
};

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('offline in tests', { status: 503 }))
  );
  apiMocks.callOrgxApiRaw.mockImplementation(
    async () =>
      new Response('<!doctype html><html><body>widget</body></html>', {
        headers: { 'content-type': 'text/html' },
      })
  );
  apiMocks.callOrgxApiJson.mockImplementation(
    async (_env: unknown, path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tool_id?: string };
      if (path === '/api/tools/execute' && body.tool_id === 'get_pending_decisions') {
        return Response.json({ ok: true, data: structuredClone(pendingDecisionsPayload) });
      }
      return Response.json({ ok: true, data: {} });
    }
  );
  apiMocks.fetchContextPreparation.mockResolvedValue({
    context_pack: null,
    context_capsule: null,
    context_delivery: null,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function widgetStemOf(uri: string): string {
  return parseWidgetResourceUri(uri)
    .widgetFile.replace(/\.skybridge\.html$/, '')
    .replace(/\.html$/, '');
}

function templateUrisOf(tool: ListedTool): string[] {
  const meta = tool._meta ?? {};
  const ui = meta.ui as { resourceUri?: unknown } | undefined;
  return [meta['openai/outputTemplate'], ui?.resourceUri].filter(
    (value): value is string => typeof value === 'string'
  );
}

/** The widget's HTML plus its own modules (shared/panel/*), as served. */
function widgetSource(stem: string): string {
  const html = readFileSync(resolve(root, 'public/widgets', `${stem}.html`), 'utf8');
  const modules = [...html.matchAll(/\b(?:src|href)="(shared\/panel\/[^"]+)"/g)].map((m) => m[1]!);
  return [html, ...modules.map((path) => readFileSync(resolve(root, 'public/widgets', path), 'utf8'))].join('\n');
}

/** callTool / callToolResult / callServerTool names written as literals. */
function parseWidgetToolCalls(source: string): string[] {
  const names = new Set<string>();
  const re = /\b(?:callTool|callToolResult|callServerTool|callWidgetRead|callWidgetToolResult)\(\s*['"]([a-z0-9_]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) names.add(match[1]!);
  return [...names].sort();
}

const listedByProfile = new Map<string, ListedTool[]>();
async function listProfile(profile: string): Promise<ListedTool[]> {
  const cached = listedByProfile.get(profile);
  if (cached) return cached;
  const { client } = await connectProfile(profile);
  const listed = (await client.listTools()).tools as ListedTool[];
  listedByProfile.set(profile, listed);
  return listed;
}

describe('one public contract per profile', () => {
  it('does not request conversation tracking metadata on the directory profile', async () => {
    for (const tool of await listProfile('claude-directory')) {
      expect(tool.inputSchema?.properties, tool.name).not.toHaveProperty('_context');
    }
  });
  it.each(EXTERNAL_PROFILES)(
    '%s: bootstrap reports exactly the tools/list, split by who may call them',
    async (profile) => {
      const { client } = await connectProfile(profile);
      const listed = (await client.listTools()).tools as ListedTool[];
      const names = listed.map((tool) => tool.name).sort();
      if (!names.includes('orgx_bootstrap')) return;

      const result = await client.callTool({
        name: 'orgx_bootstrap',
        arguments: { workspace_id: WORKSPACE_ID },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const payload = result.structuredContent as {
        visible_tools: string[];
        widget_only_tools: string[];
        visible_tools_count: number;
        listed_tools_count: number;
        safe_first_calls: Array<{ tool: string }>;
        recommended_workflows: Record<string, string[]>;
      };

      const modelVisible = listed
        .filter((tool) => isModelVisibleToolMeta(tool._meta))
        .map((tool) => tool.name)
        .sort();
      expect(payload.visible_tools).toEqual(modelVisible);
      expect([...payload.visible_tools, ...payload.widget_only_tools].sort()).toEqual(names);
      expect(payload.listed_tools_count).toBe(names.length);
      expect(payload.visible_tools_count).toBe(modelVisible.length);
      for (const call of payload.safe_first_calls) {
        expect(payload.visible_tools, `${profile} safe_first_calls`).toContain(call.tool);
      }
      for (const [workflow, tools] of Object.entries(payload.recommended_workflows)) {
        for (const tool of tools) {
          expect(payload.visible_tools, `${profile} ${workflow}`).toContain(tool);
        }
      }
      if (profile === 'claude-directory') {
        expect(payload.recommended_workflows.plan_feature).toContain('orgx_start_plan');
        expect(payload.recommended_workflows.execute_task).toContain('orgx_delegate_work');
        expect(payload.recommended_workflows.human_decision_review).toEqual([
          'orgx_list_pending_decisions', 'orgx_open_decision_review',
        ]);
        expect(payload.recommended_workflows.review_and_prove_work).toContain('orgx_complete_with_proof');
      }
    },
    30000
  );

  it.each(EXTERNAL_PROFILES)(
    '%s: one visibility per tool; widget-only tools are hidden from the model and widget-accessible',
    async (profile) => {
      for (const tool of await listProfile(profile)) {
        const meta = tool._meta ?? {};
        const ui = meta.ui as { visibility?: string[] } | undefined;
        const widgetOnly = isWidgetOnlyTool(tool.name);
        expect(meta['openai/visibility'], tool.name).toBe(widgetOnly ? 'private' : 'public');
        expect(ui?.visibility, tool.name).toEqual(widgetOnly ? ['app'] : ['model', 'app']);
        if (widgetOnly) expect(meta['openai/widgetAccessible'], tool.name).toBe(true);
      }
    },
    30000
  );

  it.each(EXTERNAL_PROFILES)(
    '%s: every template is a listed resource backed by a widget file',
    async (profile) => {
      const { client } = await connectProfile(profile);
      const listed = (await client.listTools()).tools as ListedTool[];
      const resources = new Set(client.getServerCapabilities()?.resources
        ? (await client.listResources()).resources.map((r) => r.uri) : []);
      for (const tool of listed) {
        for (const uri of templateUrisOf(tool)) {
          expect(resources, `${profile} ${tool.name} -> ${uri}`).toContain(uri);
          const stem = widgetStemOf(uri);
          expect(existsSync(resolve(root, 'public/widgets', `${stem}.html`)), stem).toBe(true);
          expect(WIDGET_TOOL_CALLS, `${stem} missing from WIDGET_TOOL_CALLS`).toHaveProperty(stem);
        }
      }
    },
    30000
  );

  it.each(EXTERNAL_PROFILES)(
    '%s: every tool a served widget calls is on the profile and widget-accessible',
    async (profile) => {
      const listed = await listProfile(profile);
      const byName = new Map(listed.map((tool) => [tool.name, tool]));
      const exceptions = WIDGET_CALL_PROFILE_EXCEPTIONS[profile] ?? {};
      const usedExceptions = new Set<string>();
      const missing: string[] = [];

      for (const tool of listed) {
        const stems = new Set(templateUrisOf(tool).map(widgetStemOf));
        const needed = new Set<string>();
        for (const stem of stems) widgetCalledTools(stem).forEach((name) => needed.add(name));
        if (stems.size) {
          const refresh = liveRefreshToolFor(tool.name);
          if (refresh) needed.add(refresh);
        }
        for (const name of needed) {
          const target = byName.get(name);
          if (target) {
            expect(
              target._meta?.['openai/widgetAccessible'],
              `${profile}: ${name} (called by the ${[...stems].join(',')} widget) must be widget-accessible`
            ).toBe(true);
          } else if (exceptions[name]) {
            usedExceptions.add(name);
          } else {
            missing.push(`${tool.name} -> ${[...stems].join(',')} calls ${name}`);
          }
        }
      }

      expect(missing, `${profile} serves widgets whose tools it does not list:\n${missing.join('\n')}`).toEqual([]);
      expect(
        Object.keys(exceptions).filter((name) => !usedExceptions.has(name)),
        `${profile} has stale WIDGET_CALL_PROFILE_EXCEPTIONS`
      ).toEqual([]);
    },
    30000
  );

  it('allows no widget-call exception on a ChatGPT-reachable profile', () => {
    for (const profile of CHATGPT_REACHABLE_PROFILES) {
      expect(WIDGET_CALL_PROFILE_EXCEPTIONS[profile]).toBeUndefined();
    }
  });

  it('claude-directory: every listed tool supplies the title annotation required by the directory scanner', async () => {
    const listed = await listProfile('claude-directory');
    expect(listed.map((tool) => tool.name).sort()).toEqual(
      [...CLAUDE_DIRECTORY_SURFACE].sort()
    );
    for (const tool of listed) {
      expect(tool.title?.trim(), tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      expect(tool.description?.length, tool.name).toBeGreaterThan(0);
      expect(tool.description, tool.name).not.toMatch(/NEXT:|DO NOT USE|USE WHEN:|use `?orgx_/i);
    }
  }, 30000);

  it('claude-directory: a read grant follows operation scope contracts and excludes work mutations', async () => {
    const { client, worker } = await connectProfile(
      'claude-directory', 'directory-read-grant', AUTHORIZATION_PRESETS.read.scopes
    );
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(listed).toEqual(CLAUDE_DIRECTORY_SURFACE.filter((id) => {
        const contract = getPublicOperationContract(id);
        expect(contract, `Missing scope contract for ${id}`).toBeDefined();
        return checkAuthRequirements(contract?.securitySchemes, 'directory-read-grant', AUTHORIZATION_PRESETS.read.scopes).isAuthorized;
      }).sort());
      for (const name of [
        'orgx_create_task', 'orgx_create_initiative_hierarchy', 'orgx_update_work', 'orgx_start_plan',
        'orgx_start_agent_task', 'orgx_capture_decision', 'orgx_attach_artifact',
        'orgx_submit_work_receipt', 'orgx_complete_work_with_proof', 'orgx_cancel_work',
        'orgx_retry_work', 'orgx_resume_work', 'orgx_launch_initiative',
      ]) {
        expect(listed, `${name} must require a write grant`).not.toContain(name);
      }
    } finally {
      await Promise.allSettled([client.close(), worker.server.close()]);
    }
  }, 30000);

  it.each(['chatgpt', 'v2'])('%s: directory title annotations do not change the OpenAI review descriptors', async (profile) => {
    for (const tool of await listProfile(profile)) {
      expect(tool.annotations, tool.name).not.toHaveProperty('title');
    }
  }, 30000);

  it('chatgpt: tools/list == profile == submission manifest == output schemas', async () => {
    const listed = await listProfile('chatgpt');
    const names = listed.map((tool) => tool.name).sort();
    expect(names).toEqual([...CHATGPT_PUBLIC_SURFACE].sort());
    expect(Object.keys(submission.tools).sort()).toEqual(names);
    expect(Object.keys(OPENAI_OUTPUT_SCHEMAS).sort()).toEqual(names);
    for (const tool of listed) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect(
        tool.annotations,
        `${tool.name} submission annotations`
      ).toEqual(
        expect.objectContaining(
          (submission.tools as Record<string, { annotations: Record<string, boolean> }>)[
            tool.name
          ]!.annotations
        )
      );
    }
    for (const widgetOnly of WIDGET_ONLY_TOOL_IDS) {
      expect(names, `${widgetOnly} must be callable by ChatGPT widgets`).toContain(widgetOnly);
    }
  }, 30000);

  // server.json carries curated registry copy (shorter titles and
  // descriptions), so names and annotations are the contract here.
  it('v2: tools/list == server.json (names and annotations)', async () => {
    const listed = await listProfile('v2');
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    expect(listed.map((tool) => tool.name).sort()).toEqual(
      serverManifest.tools.map((tool) => tool.name).sort()
    );
    for (const published of serverManifest.tools) {
      const runtime = byName.get(published.name)!;
      expect(runtime.annotations, `${published.name} annotations`).toEqual(
        expect.objectContaining(published.annotations)
      );
    }
  }, 30000);
});

describe('widget source, runtime and contract agree', () => {
  const servedStems = [...new Set(WIDGET_RESOURCES.map((widget) => widgetStemOf(widget.uri)))].sort();

  it('lists every served widget once, with no unknown widgets', () => {
    expect(Object.keys(WIDGET_TOOL_CALLS).sort()).toEqual(servedStems);
    expect(Object.keys(WIDGET_CSP_NEEDS).sort()).toEqual(servedStems);
  });

  it.each(servedStems)('%s: WIDGET_TOOL_CALLS matches the widget source', (stem) => {
    expect(parseWidgetToolCalls(widgetSource(stem))).toEqual(
      [...(WIDGET_TOOL_CALLS[stem] ?? [])].sort()
    );
  });

  it.each(servedStems)('%s: declared CSP needs match what the widget loads', (stem) => {
    const source = widgetSource(stem);
    const connect =
      /shared\/live-store\.js|new EventSource|reportSearchWidgetEvent|\bfetch\(/.test(source);
    const cdnMedia = /https:\/\/cdn\.useorgx\.com/.test(source);
    expect(WIDGET_CSP_NEEDS[stem]).toEqual({ connect, cdnMedia });
  });

  it('the widget runtime rewrites exactly the contract aliases', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(
      readFileSync(resolve(root, 'public/widgets/shared/widget-runtime.js'), 'utf8')
    );
    const runtime = (dom.window as unknown as {
      OrgXWidgetRuntime: { TOOL_ALIASES: Record<string, { tool: string; args: object }> };
    }).OrgXWidgetRuntime;
    expect(JSON.parse(JSON.stringify(runtime.TOOL_ALIASES))).toEqual(
      JSON.parse(JSON.stringify(WIDGET_RUNTIME_TOOL_ALIASES))
    );
  });

  it('every widget-only tool is called by some widget', () => {
    const called = new Set(Object.keys(WIDGET_TOOL_CALLS).flatMap(widgetCalledTools));
    for (const tool of WIDGET_ONLY_TOOL_IDS) expect(called, tool).toContain(tool);
  });

  it('every widget file in public/widgets is either served or a known standalone page', () => {
    const files = readdirSync(resolve(root, 'public/widgets'))
      .filter((file) => file.endsWith('.html'))
      .map((file) => file.replace(/\.html$/, ''));
    const standalone = new Set(['index', 'scaffold-streaming']);
    expect(files.filter((stem) => !servedStems.includes(stem) && !standalone.has(stem))).toEqual([]);
  });
});

describe('widget resources declare CSP and domain (A6)', () => {
  async function readAll(profile: string, clientName: string) {
    const { client } = await connectProfile(profile, clientName);
    const resources = (await client.listResources()).resources.filter((r) =>
      r.uri.startsWith('ui://widget/')
    );
    expect(resources.length).toBeGreaterThan(0);
    const reads = [];
    for (const resource of resources) {
      const read = await client.readResource({ uri: resource.uri });
      reads.push({ uri: resource.uri, listMeta: resource._meta, meta: read.contents[0]?._meta as Record<string, any> });
    }
    return reads;
  }

  it.each([
    ['chatgpt', 'openai-mcp', true],
    ['v2', 'openai-mcp', true],
    ['v2', 'claude-ai', false],
    ['claude-directory', 'claude-ai', false],
  ] as const)(
    '%s profile, %s client: every widget declares only what it needs (ui.domain: %s)',
    async (profile, clientName, expectDomain) => {
      for (const { uri, meta, listMeta } of await readAll(profile, clientName)) {
        const needs = WIDGET_CSP_NEEDS[widgetStemOf(uri)]!;
        expect(meta, uri).toBeDefined();
        expect(listMeta?.['openai/widgetCSP'], `${uri} list _meta`).toBeDefined();
        expect(meta['openai/widgetDomain'], uri).toBe('https://mcp.useorgx.test');
        const csp = meta['openai/widgetCSP'];
        expect(csp.connect_domains, uri).toEqual(needs.connect ? ['https://mcp.useorgx.test'] : []);
        expect(csp.resource_domains, uri).toEqual(
          needs.cdnMedia
            ? ['https://mcp.useorgx.test', 'https://mcp.useorgx.com', 'https://cdn.useorgx.com']
            : ['https://mcp.useorgx.test', 'https://mcp.useorgx.com']
        );
        for (const list of [csp.connect_domains, csp.resource_domains, csp.redirect_domains]) {
          expect(list, uri).not.toContain('*');
          expect(list, uri).not.toContain('https://api.useorgx.test');
        }
        if (meta.ui) {
          expect(meta.ui.csp.connectDomains, uri).toEqual(csp.connect_domains);
          expect(meta.ui.csp.resourceDomains, uri).toEqual(csp.resource_domains);
        }
        if (expectDomain) {
          expect(meta.ui?.domain, uri).toBe('https://mcp.useorgx.test');
        } else {
          expect(meta.ui?.domain, uri).toBeUndefined();
        }
      }
    },
    60000
  );
});

describe('every absolute URL a widget ships is inside its declared CSP (A6)', () => {
  // Namespaces and comments, never fetched or opened.
  const NOT_REQUESTED = new Set([
    'http://www.w3.org',
    'https://www.w3.org',
    'http://json-schema.org',
    'https://json-schema.org',
    'https://developers.openai.com',
  ]);
  // Standalone-preview fixtures, never rendered from a tool result.
  const PREVIEW_FIXTURE_URLS = new Set(['https://checkout-git-2291.vercel.app/']);
  const LOADED = /\.(?:png|webp|jpe?g|gif|svg|ico|avif|woff2?|ttf|otf|mp4|webm|mov|css|js)(?:[?#]|$)|\/widgets\/shared\//i;

  /** The widget plus every shared file it pulls in (what the host inlines). */
  function shippedSources(stem: string): Array<[string, string]> {
    const html = widgetSource(stem);
    const sources: Array<[string, string]> = [[`${stem}.html`, html]];
    const re = /(?:src|href)=["'](?:\.\/)?(shared\/[^"'?#]+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const path = resolve(root, 'public/widgets', match[1]!);
      if (existsSync(path)) sources.push([match[1]!, readFileSync(path, 'utf8')]);
    }
    return sources;
  }

  const servedStems = [...new Set(WIDGET_RESOURCES.map((widget) => widgetStemOf(widget.uri)))].sort();

  it.each(servedStems)('%s', (stem) => {
    const widget = WIDGET_RESOURCES.find((entry) => widgetStemOf(entry.uri) === stem)!;
    const csp = buildWidgetMeta(
      { MCP_SERVER_URL: 'https://mcp.useorgx.com', ORGX_WEB_URL: 'https://useorgx.com' },
      widgetCspNeedsForUri(widget.uri)
    )['openai/widgetCSP'];
    const outside: string[] = [];
    for (const [file, text] of shippedSources(stem)) {
      for (const url of text.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?/gi) ?? []) {
        const origin = new URL(url).origin;
        if (NOT_REQUESTED.has(origin) || PREVIEW_FIXTURE_URLS.has(url)) continue;
        // A bare origin is an allowlist entry (loads or links): either list.
        const bareOrigin = url.replace(/\/$/, '') === origin;
        const allowed = bareOrigin
          ? [...csp.resource_domains, ...csp.redirect_domains]
          : LOADED.test(url)
            ? csp.resource_domains
            : csp.redirect_domains;
        if (!allowed.includes(origin)) outside.push(`${file}: ${url}`);
      }
    }
    expect(outside, `${stem} references origins outside its CSP`).toEqual([]);
  });
});

describe('decision results through the declared output schemas (A3, A4)', () => {
  it.each([
    ['orgx_decide', { action: 'list_pending' }],
    ['approve_agent_work', { action: 'list' }],
  ] as const)(
    '%s returns pending decisions with proof that pass its output schema',
    async (name, args) => {
      const { client } = await connectProfile('legacy');
      await client.listTools(); // the client validates against the listed schemas
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        total_pending: 1,
        proof: pendingDecisionsPayload.proof,
      });
      expect(result.structuredContent).not.toHaveProperty('_widget_meta');
      // Approval tokens reach the widget only (result _meta), never the model.
      expect(result._meta?.['orgx/widgetApproval']).toEqual({
        approval_tokens: { 'decision-1': 'signed-token' },
      });
      const schema = getToolOutputSchema(name)!;
      expect(schema.safeParse(result.structuredContent).success).toBe(true);
    },
    30000
  );

  it('get_pending_decisions (legacy, full profile) accepts the same proof', async () => {
    const { client } = await connectProfile('full');
    await client.listTools();
    const result = await client.callTool({ name: 'get_pending_decisions', arguments: {} });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ proof: pendingDecisionsPayload.proof });
  }, 30000);

  it.each([
    ['orgx_decide', 'approve', {}],
    ['orgx_decide', 'reject', { reason: 'Needs another pass' }],
    ['approve_agent_work', 'approve', {}],
    ['approve_agent_work', 'reject', { reason: 'Needs another pass' }],
  ] as const)(
    '%s action=%s answers needs_human as a normal result and never settles',
    async (name, action, extra) => {
      const { client } = await connectProfile('legacy');
      await client.listTools();
      apiMocks.callOrgxApiJson.mockClear();
      const result = await client.callTool({
        name,
        arguments: { action, decision_id: 'decision-1', ...extra },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'needs_human',
        decision_id: 'decision-1',
        requested_action: action,
        review_url: 'https://useorgx.com/decisions/decision-1',
        authority_kind: 'human_session',
      });
      const text = (result.content as Array<{ text?: string }>)
        .map((item) => item.text ?? '')
        .join('\n');
      expect(text).toContain('https://useorgx.com/decisions/decision-1');
      expect(text).toMatch(/Not settled/);
      // Nothing was sent upstream: MCP never approves or rejects.
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
      expect(getToolOutputSchema(name)!.safeParse(result.structuredContent).success).toBe(true);
    },
    30000
  );
});

describe('argument aliases reach the real handler (A5)', () => {
  it('orgx_recommend initiative_id is forwarded as the initiative scope', async () => {
    const { client } = await connectProfile('legacy');
    apiMocks.callOrgxApiJson.mockClear();
    await client.callTool({ name: 'orgx_recommend', arguments: { initiative_id: INITIATIVE_ID } });
    const bodies = apiMocks.callOrgxApiJson.mock.calls.map(([, , init]) =>
      String((init as RequestInit | undefined)?.body ?? '')
    );
    expect(bodies.some((body) => body.includes(INITIATIVE_ID) && body.includes('"entity_type":"initiative"'))).toBe(true);
  }, 30000);

  it('orgx_bootstrap initiativeId binds the initiative', async () => {
    const { client, worker } = await connectProfile('legacy');
    worker.fetchEntityRecord = vi.fn(async () => ({
      id: INITIATIVE_ID,
      type: 'initiative',
      workspace_id: WORKSPACE_ID,
    }));
    const result = await client.callTool({
      name: 'orgx_bootstrap',
      arguments: { initiativeId: INITIATIVE_ID },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ initiative: { id: INITIATIVE_ID } });
  }, 30000);
});

describe('explicit operations through the live MCP registry', () => {
  function portableReceipt() {
    const { body } = buildAgentWorkReceiptImportRequest({ receipt_type: 'proof', summary: 'Login test passed', evidence: { links: ['https://example.com/test'] }, verification_status: 'passed' }, { workspaceId: WORKSPACE_ID, receiptId: 'portable-receipt', issuedAt: '2026-10-08T12:00:00.000Z' });
    return { ...body.receipt, schema_version: 'agent-work-receipt/v0.2', intent: { ...(body.receipt.intent as object), criteria: [{ id: 'login', text: 'Login works' }] }, outcome: { ...(body.receipt.outcome as object), criteria_results: [{ criterion_id: 'login', status: 'met', evidence_ids: ['evidence-1'] }] }, provenance: [{ path: '/outcome/status', basis: 'declared', confidence: 0.8 }] };
  }

  it('lists separate receipt operations and hides both legacy routers and human capability inputs', async () => {
    const tools = await listProfile('chatgpt');
    for (const id of Object.keys(RECEIPT_OPERATION_OUTPUT_SCHEMAS)) {
      const tool = tools.find((item) => item.name === id);
      expect(tool, id).toBeDefined();
      expect(tool?.outputSchema, id).toBeDefined();
      expect(tool?.inputSchema?.properties, id).not.toHaveProperty('action');
      expect(tool?.inputSchema?.properties, id).not.toHaveProperty('approval_token');
    }
    for (const id of ['orgx_act', 'orgx_write', 'orgx_plan', 'orgx_spawn', 'orgx_decide', 'manage_lifecycle', 'approve_agent_work']) expect(tools.map((item) => item.name)).not.toContain(id);
  });

  it('new pending-decision list preserves evidence and delivers approval tokens only to widget metadata', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    try {
      await client.listTools();
      const result = await client.callTool({ name: 'orgx_list_pending_decisions', arguments: {} });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ proof: pendingDecisionsPayload.proof });
      expect(result._meta?.['orgx/widgetApproval']).toEqual({ approval_tokens: { 'decision-1': 'signed-token' } });
      expect(JSON.stringify(result.content)).not.toContain('signed-token');
      expect(JSON.stringify(result.structuredContent)).not.toContain('signed-token');
    } finally { await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('imports the complete v0.2 document through the canonical receipt admission with no legacy write', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string) => {
      if (path === '/api/v1/agent-work-receipts') return Response.json({ ok: true, receipt_id: 'ledger-receipt', external_receipt_id: 'portable-receipt', schema_version: 'agent-work-receipt/v0.2', idempotent: false });
      return Response.json({ ok: true, data: {} });
    });
    try {
      await client.listTools();
      const receipt = portableReceipt();
      const result = await client.callTool({ name: 'orgx_submit_work_receipt', arguments: { workspace_id: WORKSPACE_ID, receipt, idempotency_key: 'portable-retry' } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const calls = apiMocks.callOrgxApiJson.mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe('/api/v1/agent-work-receipts');
      expect(JSON.parse(String(calls[0]?.[2]?.body))).toEqual({ workspace_id: WORKSPACE_ID, receipt, idempotency_key: 'portable-retry' });
      expect(result.structuredContent).toMatchObject({ effects: { work_status_changed: false, authoritative_verification_changed: false, human_acceptance_changed: false } });
      expect(RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_submit_work_receipt.safeParse(result.structuredContent).success).toBe(true);
    } finally { apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('never downgrades foreign-workspace or invalid-receipt rejection into a legacy write', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiJson.mockRejectedValue(new OrgXApiError('Workspace access denied', 'test foreign workspace', 403));
    try {
      const result = await client.callTool({ name: 'orgx_submit_work_receipt', arguments: { workspace_id: '99999999-9999-4999-8999-999999999999', receipt: portableReceipt() } });
      expect(result.isError).toBe(true);
      expect(apiMocks.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[1]).toBe('/api/v1/agent-work-receipts');
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('allows anonymous document validation without importing or changing work', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    worker.props = { profile: 'chatgpt', scope: '' };
    worker.sessionAuth = {}; worker.sessionContext = {};
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ ok: true, valid: true, persistence: { stored: false, import_requires_authentication: true } }));
    try {
      const receipt = portableReceipt();
      const result = await client.callTool({ name: 'orgx_validate_work_receipt', arguments: { receipt } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ valid: true, persistence: { stored: false } });
      expect(apiMocks.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[1]).toBe('/api/v1/agent-work-receipts/validate');
      expect(JSON.parse(String(apiMocks.callOrgxApiJson.mock.calls[0]?.[2]?.body))).toEqual(receipt);
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('receipt reads keep the human capability out of model content and preserve separate producer and human verdicts', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ ok: true, data: { receipt_id: 'ledger-receipt', receipt: portableReceipt(), receipt_assessment: { evidence_status: 'recorded', verification_status: 'producer_reported', acceptance_status: 'human_reviewed', outcome_status: 'failed' }, human_judgment: { outcome_status: 'failed', actor_id: 'human', decided_at: '2026-10-08T13:00:00Z' }, _widget_meta: { receipt_approval_tokens: { 'portable-receipt': 'receipt-secret-token' }, token_ttl_seconds: 900 } } }));
    try {
      await client.listTools();
      const result = await client.callTool({ name: 'orgx_get_work_receipt', arguments: { workspace_id: WORKSPACE_ID, receipt_id: 'portable-receipt' } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ producer_claims: { outcome_status: 'succeeded' }, human_judgment: { outcome_status: 'failed' } });
      expect(result._meta?.['orgx/widgetApproval']).toMatchObject({ receipt_approval_tokens: { 'portable-receipt': 'receipt-secret-token' } });
      expect(JSON.stringify(result.content)).not.toContain('receipt-secret-token');
      expect(JSON.stringify(result.structuredContent)).not.toContain('receipt-secret-token');
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('rejects workflow-status changes through a content update before any backend call', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    apiMocks.callOrgxApiJson.mockClear();
    try {
      const result = await client.callTool({ name: 'orgx_update_work', arguments: { type: 'task', id: INITIATIVE_ID, fields: { status: 'completed' } } });
      expect(result.isError).toBe(true);
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('cannot turn the create-task operation into launch or update by adding hidden router arguments', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const execute = vi.spyOn(worker, 'executeContractTool').mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Fixture stopped after operation routing.' }] });
    try {
      await client.callTool({ name: 'orgx_create_task', arguments: { title: 'Login regression', workstream_id: INITIATIVE_ID, action: 'launch', operation: 'update', type: 'initiative', status: 'completed', user_id: 'forged-person' } });
      expect(execute).toHaveBeenCalledOnce();
      const [name, args] = execute.mock.calls[0]!;
      expect(name).toBe('orgx_write');
      expect(args).toMatchObject({ operation: 'create', type: 'task', title: 'Login regression' });
      expect(args).not.toHaveProperty('action');
      expect(args).not.toHaveProperty('status');
      expect(args).not.toHaveProperty('user_id');
    } finally { await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('validates the actual receipt collection and review-queue projections including bounds and counts', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string) => Response.json({ ok: true, data: path.includes('/review?') ? { total: 0, items: [], criteria_proposals: [], queue_limit: 200, queue_truncated: false, window_days: 120 } : { total: 0, results: [], receipts: 0, workstreams: 0, window_days: 120, query: { text: '', filters: {} }, _widget_meta: { receipt_approval_tokens: {}, token_ttl_seconds: 900 } } }));
    try {
      await client.listTools();
      for (const name of ['orgx_list_work_receipts', 'orgx_get_receipt_review_queue']) {
        const result = await client.callTool({ name, arguments: { workspace_id: WORKSPACE_ID } });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ total: 0, window_days: 120 });
      }
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);
});

describe('core proof and artifact operations through MCP output contracts', () => {
  it('opens an explicit artifact from the core review route and keeps its capability hidden', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiJson.mockImplementation(async () => Response.json({ data: {
      artifact: { id: INITIATIVE_ID, name: 'Reviewed deliverable', status: 'in_review', version: 2 },
      reviewContract: null, reviewContractSource: 'entity_fallback', available_actions: [{ id: 'request_changes' }],
      _widget_meta: { approval_tokens: { [INITIATIVE_ID]: 'artifact-hidden-capability' } },
    }, meta: { apiVersion: '1', workspaceId: WORKSPACE_ID } }));
    try {
      await client.listTools();
      const result = await client.callTool({ name: 'orgx_open_artifact_review', arguments: { artifact_id: INITIATIVE_ID, workspace_id: WORKSPACE_ID } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(apiMocks.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[1]).toContain(`/api/v1/workflows/artifact-review/${INITIATIVE_ID}?`);
      expect(result.structuredContent).toMatchObject({ available_actions: [{ id: 'request_changes' }] });
      expect(JSON.stringify(result.structuredContent)).not.toContain('artifact-hidden-capability');
      expect(JSON.stringify(result.content)).not.toContain('artifact-hidden-capability');
      expect(result._meta?.['orgx/widgetApproval']).toEqual({ approval_tokens: { [INITIATIVE_ID]: 'artifact-hidden-capability' } });
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('preserves a core task completion failure and recorded proof instead of losing the partial result', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    const original = apiMocks.callOrgxApiJson.getMockImplementation();
    apiMocks.callOrgxApiJson.mockClear();
    const payload = { data: { completed: false, state: 'failed', proof_attached: true, artifact: { id: 'proof' }, verification: null, completion: null, error: { code: 'conflict', message: 'Task changed after proof attached' } }, meta: { apiVersion: '1', workspaceId: WORKSPACE_ID } };
    apiMocks.callOrgxApiJson.mockImplementation(async () => Response.json(payload));
    try {
      await client.listTools();
      const result = await client.callTool({ name: 'orgx_complete_work_with_proof', arguments: { type: 'task', id: INITIATIVE_ID, workspace_id: WORKSPACE_ID, artifact: { artifact_type: 'document', external_url: 'https://example.com/proof' } } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
      expect(apiMocks.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[1]).toBe('/api/v1/workflows/complete-with-proof');
      expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[2]?.headers).toMatchObject({ 'Idempotency-Key': expect.stringMatching(/^mcp-proof:/) });
    } finally { apiMocks.callOrgxApiJson.mockReset(); apiMocks.callOrgxApiJson.mockImplementation(original!); await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);
});


describe('current session wire contracts', () => {
  it('initializes a fresh SSE session with a bound grant and no persisted initializeRequest', async () => {
    const { client, worker } = await connectProfile('chatgpt', 'fresh-sse', undefined, undefined, true);
    try {
      expect(await worker.ctx.storage.get('initializeRequest')).toBeUndefined();
      expect(await worker.getSessionToolContract(worker.props))
        .toEqual({ profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' });
      expect((await client.listTools()).tools.map((tool) => tool.name).sort())
        .toEqual([...CHATGPT_PUBLIC_SURFACE].sort());
    } finally { await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);

  it('rejects a pre-operation ChatGPT session so the host refreshes discovery', async () => {
    await expect(connectProfile('chatgpt', 'cached-chatgpt', undefined, { previousProfile: 'chatgpt' }))
      .rejects.toThrow('Reconnect without a session ID');
  }, 30000);

  it('binds a current profile and rejects identity or explicit selector changes', async () => {
    const { client, worker } = await connectProfile('chatgpt');
    try {
      await worker.updateProps(worker.props);
      await worker.ctx.storage.put('initializeRequest', { jsonrpc: '2.0', method: 'initialize', id: 1 });
      expect(await worker.getSessionToolContract(worker.props))
        .toEqual({ profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' });
      expect(await worker.getSessionToolContract({ ...worker.props, scope: worker.props.scope.split(' ').reverse().join(' '), email: 'refreshed@example.test' }))
        .toEqual({ profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' });
      await expect(worker.getSessionToolContract({ ...worker.props, scope: 'initiatives:read' }))
        .rejects.toThrow('different authenticated grant');
      await worker.updateProps({ ...worker.props, profile: 'v2', toolProfileExplicit: false });
      expect(worker.props.profile).toBe('chatgpt');
      await expect(worker.updateProps({ ...worker.props, profile: 'extended', toolProfileExplicit: true }))
        .rejects.toThrow('Reconnect');
      await expect(worker.updateProps({ ...worker.props, userId: 'other-actor' }))
        .rejects.toThrow('another authenticated identity');
      await expect(worker.getSessionToolContract({ ...worker.props, userId: 'other-actor' }))
        .rejects.toThrow('another authenticated identity');
      // Native SSE keeps actor props without persisting initializeRequest.
      // Its session must remain bound despite that missing SDK marker.
      await worker.ctx.storage.put('initializeRequest', undefined);
      expect(await worker.getSessionToolContract(worker.props))
        .toEqual({ profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' });
      await expect(worker.getSessionToolContract({ ...worker.props, userId: 'other-actor' }))
        .rejects.toThrow('another authenticated identity');
      await expect(worker.getSessionToolContract({ ...worker.props, scope: 'initiatives:read' }))
        .rejects.toThrow('different authenticated grant');
      expect((await client.listTools()).tools.map((tool) => tool.name).sort())
        .toEqual([...CHATGPT_PUBLIC_SURFACE].sort());
    } finally { await Promise.allSettled([client.close(), worker.server.close()]); }
  }, 30000);
});


it.each(['commander', 'executor', 'full'])('%s preserves the runtime completion concurrency contract', async (profile) => {
  const { client } = await connectProfile(profile);
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'orgx_complete_work')!;
  expect(tool).toBeDefined();
  expect(tool.inputSchema.properties).toHaveProperty('task_id');
  expect(tool.inputSchema.properties).toHaveProperty('expected_updated_at');
  expect(tool.inputSchema.properties).toHaveProperty('expected_aggregate_version');
  expect(tool.inputSchema.properties).not.toHaveProperty('type');
  expect(tool.inputSchema.required).toContain('task_id');
  expect(tool.inputSchema.required).toContain('expected_updated_at');
  expect(tool.inputSchema.required).toContain('expected_aggregate_version');
}, 30000);


it('requires internal runs with pre-operation sessions to reconnect too', async () => {
  await expect(connectProfile('full', 'cached-internal-run', undefined, { previousProfile: 'full' }))
    .rejects.toThrow('Reconnect without a session ID');
}, 30000);
