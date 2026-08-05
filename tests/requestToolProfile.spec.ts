import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { withRequestToolProfile } from '../src/requestToolProfile';
import {
  CLAUDE_DIRECTORY_SURFACE,
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
      const names = selected ? [...selected] : serverManifest.tools.map((tool) => tool.name);
      const tools = names.map((name) => toolsByName.get(name)).filter(Boolean);

      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools },
      });
    },
  });
}

describe('request URL tool-profile propagation', () => {
  it('uses the profile-aware handlers on the actual OAuthProvider API paths', () => {
    expect(workerSource).toContain(
      'const profileAwareHttpHandler = withRequestToolProfile(rateLimitedHttpHandler);'
    );
    expect(workerSource).toContain(
      'const profileAwareSseHandler = withRequestToolProfile(rateLimitedSseHandler);'
    );
    expect(workerSource).toMatch(
      /apiHandlers:\s*\{[\s\S]*?'\/mcp': profileAwareHttpHandler,[\s\S]*?'\/sse': profileAwareSseHandler/
    );
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

  it('serves the seven-tool non-destructive directory profile with truthful read-only hints', async () => {
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
    expect(body.result.tools).toHaveLength(7);
    expect(body.result.tools.map((tool) => tool.name)).not.toContain(
      'orgx_bootstrap'
    );
    expect(body.result.tools.map((tool) => tool.name)).not.toContain('orgx_write');
    const readOnlyByTool = new Map<string, boolean>([
      ['orgx_search', false],
      ['orgx_inspect', true],
      ['orgx_recommend', false],
      ['get_agent_status', false],
      ['get_initiative_pulse', false],
      ['get_morning_brief', true],
      ['get_operator_chronicle', true],
    ]);
    for (const tool of body.result.tools) {
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: readOnlyByTool.get(tool.name),
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });

  it('fails an unknown URL profile closed to v2 instead of the directory profile', async () => {
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

    expect(ctx.props?.profile).toBe('v2');
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      serverManifest.tools.map((tool) => tool.name)
    );
    expect(body.result.tools.map((tool) => tool.name)).not.toEqual([
      ...CLAUDE_DIRECTORY_SURFACE,
    ]);
  });
});
