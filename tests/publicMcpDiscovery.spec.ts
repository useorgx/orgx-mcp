import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { authHandler } from '../src/authHandler';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import { PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS, type PublicClientProfile } from '../src/publicClientProfiles';
import { LEGACY_INFORMATIONAL_SURFACE, TOOL_PROFILES, V2_PUBLIC_SURFACE } from '../src/toolProfiles';
import { WIDGET_ONLY_TOOL_IDS } from '../src/widgetToolContract';

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
      compatibility_profiles?: Record<string, PublicClientProfile>;
      profile_note?: string;
    };
    expect(body.authenticated_endpoint).toBe('https://mcp.useorgx.com/mcp');
    expect(body.authentication_required).toBe(false);
    expect(body.public_tools?.map((tool) => tool.name)).toContain(
      'orgx_public_capabilities'
    );
    expect(body.primary_authenticated_tools).toEqual(V2_PUBLIC_SURFACE);
    expect(body.primary_authenticated_tools).toContain('orgx_capture_decision');
    expect(body.primary_authenticated_tools).toContain('orgx_get_operator_brief');
    expect(body.primary_authenticated_tools).not.toContain('orgx_decide');
    expect(body.profile_note).toContain('do not grant access');
    expect(Object.keys(body.compatibility_profiles ?? {})).toEqual(Object.keys(PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS));
    for (const [name, contract] of Object.entries(body.compatibility_profiles ?? {})) {
      expect(contract.tools, name).toEqual(TOOL_PROFILES[name].tools);
      expect(contract.contract_version, name).toBe(PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS[name as keyof typeof PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS]);
      expect(contract.authenticated_endpoint, name).toBe(`https://mcp.useorgx.com/mcp?profile=${name}`);
    }
    expect(body.compatibility_profiles?.['claude-code-legacy']).toEqual({
      contract_version: 'orgx-mcp-legacy/1', tools: [...LEGACY_INFORMATIONAL_SURFACE],
      authenticated_endpoint: 'https://mcp.useorgx.com/mcp?profile=claude-code-legacy',
    });
    for (const name of ['full', 'internal', 'executor', 'commander', 'planner', 'observer', 'memory', 'unknown']) {
      expect(body.compatibility_profiles).not.toHaveProperty(name);
    }
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

  async function callDiscoveryTool(name: string, args: Record<string, unknown> = {}) {
    const response = await authHandler.fetch(new Request('https://mcp.useorgx.com/public', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }),
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      error?: { code: number; message: string };
      result?: { structuredContent?: Record<string, unknown> };
    }>;
  }

  it('publishes the same compatibility contracts through capabilities without customer context', async () => {
    const metadataResponse = await authHandler.fetch(new Request('https://mcp.useorgx.com/public'), env, {} as ExecutionContext);
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    const result = await callDiscoveryTool('orgx_public_capabilities');
    expect(result.result?.structuredContent?.compatibility_profiles).toEqual(metadata.compatibility_profiles);
    expect(result.result?.structuredContent?.profile_note).toContain('OAuth scopes');
    expect(result.result?.structuredContent).not.toHaveProperty('workspace_id');
    expect(result.result?.structuredContent).not.toHaveProperty('granted_scopes');
  });

  it('shows schema-valid examples for every current model operation and no private widget callbacks', async () => {
    const response = await callDiscoveryTool('orgx_public_tool_examples');
    const payload = response.result?.structuredContent;
    expect(payload?.note).toContain('example payloads only');
    expect(payload?.note).toContain('synthetic identifiers');
    const examples = payload?.examples as Record<string, { prompt: string; arguments: Record<string, unknown>; expected_behavior: string }>;
    const privateIds: readonly string[] = WIDGET_ONLY_TOOL_IDS;
    expect(Object.keys(examples).sort()).toEqual(V2_PUBLIC_SURFACE.filter((id) => !privateIds.includes(id)).sort());
    for (const [id, example] of Object.entries(examples)) {
      const contract = getPublicOperationContract(id);
      expect(contract, id).toBeDefined();
      const parsed = z.object(contract!.inputSchema!).strict().safeParse(example.arguments);
      expect(parsed.success, `${id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      expect(example.prompt.length, id).toBeGreaterThan(0);
      expect(example.expected_behavior.length, id).toBeGreaterThan(0);
      expect(example, id).not.toHaveProperty('sample_response');
    }
    expect(examples.orgx_attach_artifact.expected_behavior).toContain('does not approve');
    expect(examples.orgx_complete_work_with_proof.expected_behavior).toContain('blocked');
    expect(examples.orgx_submit_work_receipt.expected_behavior).toContain('without changing work status');
    expect(examples.orgx_submit_work_receipt.arguments.receipt).toMatchObject({
      verification: { status: 'unverified' }, outcome: { acceptance: { status: 'pending' } },
    });
  });

  it('filters to an explicit current operation and refuses legacy or app-only example names', async () => {
    const result = await callDiscoveryTool('orgx_public_tool_examples', { tool_name: 'orgx_create_initiative_hierarchy' });
    expect(Object.keys(result.result?.structuredContent?.examples as object)).toEqual(['orgx_create_initiative_hierarchy']);
    for (const toolName of ['orgx_write', 'approve_decision', 'scaffold_initiative', ...WIDGET_ONLY_TOOL_IDS]) {
      const rejected = await callDiscoveryTool('orgx_public_tool_examples', { tool_name: toolName });
      expect(rejected.error?.code, toolName).toBe(-32602);
      expect(rejected.result, toolName).toBeUndefined();
    }
  });

  it('uses current model operations for client connection verification', async () => {
    for (const client of ['cursor', 'claude', 'chatgpt', 'vscode', 'generic']) {
      const result = await callDiscoveryTool('orgx_public_connection_help', { client });
      const calls = result.result?.structuredContent?.verification_calls as Array<{ tool: string; arguments: Record<string, unknown> }>;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(V2_PUBLIC_SURFACE, client).toContain(call.tool);
        expect(WIDGET_ONLY_TOOL_IDS, client).not.toContain(call.tool);
        expect(z.object(getPublicOperationContract(call.tool)!.inputSchema!).strict().safeParse(call.arguments).success, `${client}: ${call.tool}`).toBe(true);
      }
    }
  });
});
