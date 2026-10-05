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
import { OPENAI_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas';
import { WIDGET_RESOURCES } from '../src/toolDefinitions';
import { CHATGPT_PUBLIC_SURFACE, TOOL_PROFILE_NAMES } from '../src/toolProfiles';
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
const READ_PRESET_PROFILES = new Set(['claude-directory', 'read-only']);

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
};

async function connectProfile(profile: string, clientName = 'surface-contract') {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile,
    userId: 'surface-contract-user',
    orgxUserId: '33333333-3333-4333-8333-333333333333',
    scope: (READ_PRESET_PROFILES.has(profile)
      ? AUTHORIZATION_PRESETS.read.scopes
      : AUTHORIZATION_PRESETS.operate.scopes
    ).join(' '),
    workspace_id: WORKSPACE_ID,
  };
  worker.ctx = {
    id: { toString: () => `surface-${profile}` },
    storage: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
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

function widgetSource(stem: string): string {
  return readFileSync(resolve(root, 'public/widgets', `${stem}.html`), 'utf8');
}

/** callTool / callToolResult / callServerTool names written as literals. */
function parseWidgetToolCalls(source: string): string[] {
  const names = new Set<string>();
  const re = /\b(?:callTool|callToolResult|callServerTool)\(\s*['"]([a-z0-9_]+)['"]/g;
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
      const resources = new Set((await client.listResources()).resources.map((r) => r.uri));
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
    expect(listed).toHaveLength(7);
    for (const tool of listed) {
      expect(tool.title?.trim(), tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      expect(tool.description?.length, tool.name).toBeGreaterThan(0);
      expect(tool.description, tool.name).not.toMatch(/NEXT:|DO NOT USE|USE WHEN:|use `?orgx_/i);
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
      const { client } = await connectProfile('chatgpt');
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
      const schema = OPENAI_OUTPUT_SCHEMAS[name];
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
      const { client } = await connectProfile('chatgpt');
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
      expect(OPENAI_OUTPUT_SCHEMAS[name].safeParse(result.structuredContent).success).toBe(true);
    },
    30000
  );
});

describe('argument aliases reach the real handler (A5)', () => {
  it('orgx_recommend initiative_id is forwarded as the initiative scope', async () => {
    const { client } = await connectProfile('chatgpt');
    apiMocks.callOrgxApiJson.mockClear();
    await client.callTool({ name: 'orgx_recommend', arguments: { initiative_id: INITIATIVE_ID } });
    const bodies = apiMocks.callOrgxApiJson.mock.calls.map(([, , init]) =>
      String((init as RequestInit | undefined)?.body ?? '')
    );
    expect(bodies.some((body) => body.includes(INITIATIVE_ID) && body.includes('"entity_type":"initiative"'))).toBe(true);
  }, 30000);

  it('orgx_bootstrap initiativeId binds the initiative', async () => {
    const { client, worker } = await connectProfile('chatgpt');
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
