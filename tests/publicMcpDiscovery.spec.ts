import { describe, expect, it } from 'vitest';

import { authHandler } from '../src/authHandler';

const env = {
  MCP_SERVER_URL: 'https://mcp.useorgx.com',
  ORGX_WEB_URL: 'https://useorgx.com',
};

describe('public MCP discovery endpoint', () => {
  it('serves no-auth discovery metadata from GET /public', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public'),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await response.json()) as {
      authenticated_endpoint?: string;
      authentication_required?: boolean;
      public_tools?: Array<{ name?: string }>;
      primary_authenticated_tools?: string[];
    };
    expect(body.authenticated_endpoint).toBe('https://mcp.useorgx.com/mcp');
    expect(body.authentication_required).toBe(false);
    expect(body.public_tools?.map((tool) => tool.name)).toContain(
      'orgx_public_capabilities'
    );
    expect(body.primary_authenticated_tools).toContain('orgx_decide');
    expect(body.primary_authenticated_tools).toContain('consolidate_pr');
    expect(body.primary_authenticated_tools).toContain('get_operator_chronicle');
    expect(body.primary_authenticated_tools).not.toContain('remember_decision');
  });

  it('supports MCP initialize and public tools/list without OAuth', async () => {
    const initialize = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(initialize.status).toBe(200);
    const initialized = (await initialize.json()) as {
      result?: { serverInfo?: { name?: string }; instructions?: string };
    };
    expect(initialized.result?.serverInfo?.name).toBe(
      'OrgX MCP Public Discovery'
    );
    expect(initialized.result?.instructions).toContain('no-auth discovery');

    const toolsList = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(toolsList.status).toBe(200);
    const body = (await toolsList.json()) as {
      result?: { tools?: Array<{ name?: string; annotations?: { readOnlyHint?: boolean } }> };
    };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([
      'orgx_public_capabilities',
      'orgx_public_tool_examples',
      'orgx_public_connection_help',
    ]);
    expect(names).not.toContain('remember_decision');
    expect(body.result?.tools?.every((tool) => tool.annotations?.readOnlyHint)).toBe(
      true
    );
  });

  it('returns example payloads but not workspace data for public tool calls', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'examples',
          method: 'tools/call',
          params: {
            name: 'orgx_public_tool_examples',
            arguments: { tool_name: 'consolidate_pr' },
          },
        }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        structuredContent?: {
          note?: string;
          examples?: Record<string, { prompt?: string }>;
        };
      };
    };
    expect(body.result?.structuredContent?.note).toContain('example payloads only');
    expect(
      body.result?.structuredContent?.examples?.consolidate_pr?.prompt
    ).toContain('consolidation_pass');
    expect(JSON.stringify(body)).toContain('https://mcp.useorgx.com/mcp');
  });

  it('shows scaffold examples with chainable initiative IDs and next calls', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'scaffold-example',
          method: 'tools/call',
          params: {
            name: 'orgx_public_tool_examples',
            arguments: { tool_name: 'scaffold_initiative' },
          },
        }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        structuredContent?: {
          examples?: Record<
            string,
            { sample_response?: Record<string, unknown> }
          >;
        };
      };
    };
    const sample =
      body.result?.structuredContent?.examples?.scaffold_initiative
        ?.sample_response;
    expect(sample?.initiative_id).toBe('initiative_123');
    expect(JSON.stringify(sample)).toContain('orgx_inspect');
    expect(JSON.stringify(sample)).toContain('ref_map');
  });

  it('shows operator chronicle examples for proof read-back', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/public', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'chronicle-example',
          method: 'tools/call',
          params: {
            name: 'orgx_public_tool_examples',
            arguments: { tool_name: 'get_operator_chronicle' },
          },
        }),
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        structuredContent?: {
          examples?: Record<string, { prompt?: string; sample_response?: unknown }>;
        };
      };
    };
    const example =
      body.result?.structuredContent?.examples?.get_operator_chronicle;
    expect(example?.prompt).toContain('operator chronicle');
    expect(JSON.stringify(example?.sample_response)).toContain('prVelocity');
    expect(JSON.stringify(example?.sample_response)).toContain('gaps');
  });
});
