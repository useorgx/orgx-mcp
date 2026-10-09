import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { getPublicOperationContract, getPublicOperationContracts } from '../src/publicOperationContracts';
import { getClaudeDirectoryToolContract } from '../src/claudeDirectoryTools';
import {
  ORGX_TOOL_PROFILE_HEADER,
  withRequestToolProfile,
} from '../src/requestToolProfile';
import {
  CLAUDE_DIRECTORY_SURFACE,
  INFORMATIONAL_SURFACE,
  resolveProfileToolSet,
} from '../src/toolProfiles';

type TestContext = {
  props?: Record<string, unknown>;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

const toolsByName = new Map(
  serverManifest.tools.map((tool) => [tool.name, tool])
);

function createInMemoryMcpHandler() {
  return withRequestToolProfile<undefined, TestContext>({
    async fetch(request, _env, ctx) {
      const message = (await request.json()) as {
        jsonrpc: '2.0';
        id: number;
        method: string;
      };
      if (message.method !== 'tools/list') {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          },
          { status: 404 }
        );
      }

      const profile = String(ctx.props?.profile ?? '');
      const selected = resolveProfileToolSet(profile);
      const names = selected ? [...selected] : getPublicOperationContracts().map((tool) => tool.id);
      const tools = names.map((name) => {
        const directory = profile === 'claude-directory-legacy' ? getClaudeDirectoryToolContract(name) : undefined;
        const contract = directory ?? getPublicOperationContract(name);
        return contract ? { name, annotations: contract.annotations } : toolsByName.get(name);
      }).filter(Boolean);

      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools },
      });
    },
  });
}

describe('request tool-profile propagation', () => {
  it('uses the profile-aware handlers on the actual OAuthProvider API paths', () => {
    expect(workerSource).toContain(
      'const profileAwareHttpHandler = withRequestToolProfile(rateLimitedHttpHandler);'
    );
    expect(workerSource).toContain(
      'const profileAwareSseHandler = withRequestToolProfile(rateLimitedSseHandler);'
    );
    expect(workerSource).toMatch(
      /apiHandlers:\s*\{[\s\S]*?'\/mcp': observedHttpHandler,[\s\S]*?'\/sse': observedSseHandler/
    );
    expect(workerSource).toContain('const observedHttpHandler = observeVerifiedMcpTransport(profileAwareHttpHandler);');
    expect(workerSource).toContain('const observedSseHandler = observeVerifiedMcpTransport(profileAwareSseHandler);');
    expect(workerSource).toMatch(
      /export function getHttpHandler\(\) \{\s*return profileAwareHttpHandler;/
    );
    expect(workerSource).toMatch(
      /export function getSseHandler\(\) \{\s*return profileAwareSseHandler;/
    );
  });

  it('preserves the requested profile on root/run-token SSE handler paths', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = { props: { authSource: 'run_token' } };
    const response = await handler.fetch(
      new Request('https://mcp.useorgx.com/sse?profile=claude-directory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(ctx.props).toMatchObject({
      authSource: 'run_token',
      profile: 'claude-directory',
    });
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      ...CLAUDE_DIRECTORY_SURFACE,
    ]);
  });

  it('accepts a profile header on the canonical OAuth resource URL', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = { props: { userId: 'codex-user' } };
    const response = await handler.fetch(
      new Request('https://mcp.useorgx.com/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ORGX_TOOL_PROFILE_HEADER]: 'commander',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(ctx.props).toMatchObject({
      userId: 'codex-user',
      profile: 'commander',
    });
    expect(body.result.tools.map((tool) => tool.name)).toContain('orgx_expect');
  });

  it('keeps an explicit query profile authoritative over the header', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = {};
    await handler.fetch(
      new Request('https://mcp.useorgx.com/mcp?profile=claude-directory', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ORGX_TOOL_PROFILE_HEADER]: 'commander',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );

    expect(ctx.props?.profile).toBe('claude-directory');
  });

  it('propagates the broader directory operation profile', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = { props: { userId: 'reviewer-1' } };
    const request = new Request(
      'https://mcp.useorgx.com/mcp?profile=claude-directory',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      }
    );

    const response = await handler.fetch(request, undefined, ctx);
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          annotations: {
            readOnlyHint: boolean;
            destructiveHint: boolean;
            openWorldHint: boolean;
          };
        }>;
      };
    };

    expect(ctx.props).toMatchObject({
      userId: 'reviewer-1',
      profile: 'claude-directory',
    });
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      ...CLAUDE_DIRECTORY_SURFACE,
    ]);
    expect(body.result.tools).toHaveLength(48);
    expect(body.result.tools.map((tool) => tool.name)).toContain('orgx_get_workspace_context');
    expect(body.result.tools.map((tool) => tool.name)).not.toContain('orgx_write');
    for (const tool of body.result.tools) {
      const contract = getPublicOperationContract(tool.name);
      expect(tool.annotations, tool.name).toEqual(contract?.annotations);
    }
  });

  it('fails an unknown URL profile closed to the read-only fallback, not v2 or the directory profile', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = {};
    const response = await handler.fetch(
      new Request('https://mcp.useorgx.com/mcp?profile=not-a-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    // Unknown names resolve to the dedicated read-only fallback: the same
    // seven original informational tools, under a distinct name so the
    // directory profile's review-mode suppression semantics do not apply.
    expect(ctx.props?.profile).toBe('read-only');
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      ...INFORMATIONAL_SURFACE,
    ]);
    expect(body.result.tools.map((tool) => tool.name)).not.toEqual(
      serverManifest.tools.map((tool) => tool.name)
    );
  });

  it('fails an external full-profile request closed to read-only', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = {
      props: { userId: 'oauth-user', scope: 'initiatives:read' },
    };
    const response = await handler.fetch(
      new Request('https://mcp.useorgx.com/mcp?profile=full', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(ctx.props?.profile).toBe('read-only');
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      ...INFORMATIONAL_SURFACE,
    ]);
  });

  it('preserves full only for a verified internal run-token context', async () => {
    const handler = createInMemoryMcpHandler();
    const ctx: TestContext = {
      props: { userId: 'agent-run', authSource: 'run_token' },
    };
    const response = await handler.fetch(
      new Request('https://mcp.useorgx.com/mcp?profile=full', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
      }),
      undefined,
      ctx
    );
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(ctx.props?.profile).toBe('full');
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      getPublicOperationContracts().map((tool) => tool.id)
    );
    expect(body.result.tools.map((tool) => tool.name)).toContain('orgx_write');
    expect(body.result.tools.map((tool) => tool.name)).toContain('orgx_create_task');
  });
});
