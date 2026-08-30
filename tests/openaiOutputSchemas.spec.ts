import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  getOpenAiOutputSchema,
  OPENAI_OUTPUT_SCHEMAS,
} from '../src/openaiOutputSchemas';
import { CHATGPT_PUBLIC_SURFACE } from '../src/toolProfiles';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import {
  buildScaffoldOutputVariants,
  COMMON_STRUCTURED_TOOL_ERROR,
  ORGX_ACT_OUTPUT_VARIANTS,
  ORGX_DECIDE_OUTPUT_VARIANTS,
  ORGX_PLAN_OUTPUT_VARIANTS,
  ORGX_SPAWN_DURABLE_OUTPUT,
} from './fixtures/openaiOutputSchemaVariants';

const SCAFFOLD_OUTPUT_KEYS = `
  ok error_kind error resolution_hint request_id identity_warning billing_url pricing_url usage missing
  suggested_next_calls mode response_mode summary initiative_id live_url idempotency_key contract_warnings
  summary_stats dependency_edges coordination_dependency entity_plan_preview entity_plan_count
  entity_plan_preview_count first_agent_work external_sync benchmark_metrics hierarchy created_preview
  created_preview_count created_count failed_preview failed_preview_count failed_count ref_map ref_map_count
  ref_map_truncated scaffold_stream_url scaffold_session_id agent_assignment credential_status launch streams
  billing_usage scaffold_usage fallback_agent_dispatch result_contract tool_hints estimated_time_seconds
  estimated_cost client_activation tool_id error_type
`
  .trim()
  .split(/\s+/);

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'orgx-openai-output-schema-client',
    version: '1.0.0',
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function findBooleanAdditionalProperties(
  value: unknown,
  path = '$'
): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const matches = record.additionalProperties === true ? [path] : [];
  for (const [key, child] of Object.entries(record)) {
    matches.push(
      ...findBooleanAdditionalProperties(child, `${path}.${key}`)
    );
  }
  return matches;
}

describe('OpenAI public tool output schemas', () => {
  it('covers exactly the 23 ChatGPT public tools', () => {
    expect(Object.keys(OPENAI_OUTPUT_SCHEMAS)).toEqual([
      ...CHATGPT_PUBLIC_SURFACE,
    ]);
    expect(Object.keys(OPENAI_OUTPUT_SCHEMAS)).toHaveLength(23);
    expect(getOpenAiOutputSchema('not_a_public_tool')).toBeUndefined();
  });

  it('advertises a non-empty, closed top-level schema for every public tool', async () => {
    const server = new McpServer({
      name: 'orgx-openai-schema-discovery',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);

    for (const name of CHATGPT_PUBLIC_SURFACE) {
      server.registerTool(
        name,
        { description: `${name} schema probe`, inputSchema: {} },
        async () => ({
          content: [{ type: 'text' as const, text: 'expected error' }],
          isError: true,
        })
      );
    }

    const client = await connect(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        ...CHATGPT_PUBLIC_SURFACE,
      ]);

      for (const tool of listed.tools) {
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
        expect(
          Object.keys(tool.outputSchema?.properties ?? {}),
          `${tool.name} must expose named output properties`
        ).not.toHaveLength(0);
        expect(
          findBooleanAdditionalProperties(tool.outputSchema),
          `${tool.name} must not use additionalProperties: true`
        ).toEqual([]);
      }

      const scaffold = listed.tools.find(
        (tool) => tool.name === 'scaffold_initiative'
      );
      const scaffoldOutput = scaffold?.outputSchema as
        | {
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
          }
        | undefined;
      expect(scaffoldOutput?.additionalProperties).toBe(false);
      expect(Object.keys(scaffoldOutput?.properties ?? {})).toEqual(
        SCAFFOLD_OUTPUT_KEYS
      );
      expect(scaffoldOutput?.properties?.ok).toEqual({ type: 'boolean' });
      expect(scaffoldOutput?.properties?.mode).toEqual({
        type: 'string',
        enum: ['draft', 'scaffold', 'launch'],
      });
      expect(scaffoldOutput?.properties?.dependency_edges).toEqual({});
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('validates representative success, empty, and inline error-compatible outputs', () => {
    expect(
      OPENAI_OUTPUT_SCHEMAS.manage_lifecycle.safeParse({
        ok: true,
        action: 'pause',
        level: 'initiative',
        id: 'initiative-1',
        affected: {
          nodes: 3,
          runsPaused: 1,
          runsCancelled: 0,
          redispatched: 0,
        },
        message: 'Initiative paused.',
      }).success
    ).toBe(true);

    expect(
      OPENAI_OUTPUT_SCHEMAS.review_artifact.safeParse({ artifact: null })
        .success
    ).toBe(true);

    expect(
      OPENAI_OUTPUT_SCHEMAS.scaffold_initiative.safeParse({
        ok: false,
        error_kind: 'scaffold_initiative_failed',
        error: 'Workspace context could not be resolved.',
        resolution_hint: 'Pass workspace_id and retry.',
      }).success
    ).toBe(true);
  });

  const variantCases = [
    ['orgx_act', ORGX_ACT_OUTPUT_VARIANTS],
    ['orgx_plan', ORGX_PLAN_OUTPUT_VARIANTS],
    ['orgx_decide', ORGX_DECIDE_OUTPUT_VARIANTS],
    ['scaffold_initiative', buildScaffoldOutputVariants()],
  ] as const;

  for (const [tool, outputs] of variantCases) {
    it(`accepts every audited ${tool} result variant`, () => {
      for (const output of outputs) {
        expect(
          OPENAI_OUTPUT_SCHEMAS[tool].safeParse(output).success,
          JSON.stringify(output)
        ).toBe(true);
      }
    });
  }

  it('accepts the common structured error envelope for every variant-heavy tool', () => {
    for (const tool of [
      'orgx_act',
      'orgx_plan',
      'orgx_decide',
      'scaffold_initiative',
    ] as const) {
      expect(
        OPENAI_OUTPUT_SCHEMAS[tool].safeParse(COMMON_STRUCTURED_TOOL_ERROR)
          .success,
        tool
      ).toBe(true);
    }
  });

  it('lets MCP isError envelopes bypass success-schema validation', async () => {
    const server = new McpServer({
      name: 'orgx-openai-error-envelope',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'orgx_search',
      { description: 'Error envelope probe', inputSchema: {} },
      async () => ({
        content: [{ type: 'text' as const, text: 'Authentication required.' }],
        structuredContent: {
          error: {
            code: 'authentication_required',
            status: 401,
            message: 'Authentication required.',
            details: {
              required_scopes: ['initiatives:read'],
              required_scope_alternatives: [['initiatives:read']],
              missing_scope_alternatives: [['initiatives:read']],
              granted_scopes: [],
              grant_source_known: true,
              retryable: false,
            },
          },
        },
        isError: true,
      })
    );

    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: 'orgx_search',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'authentication_required', status: 401 },
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('validates real orgx_plan value shapes through an MCP call', async () => {
    const server = new McpServer({
      name: 'orgx-plan-output-values',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'orgx_plan',
      {
        description: 'Plan value-shape probe',
        inputSchema: {
          variant: z.enum(['improve', 'edit', 'complete', 'resume']),
        },
      },
      async ({ variant }) => {
        const variantIndex = {
          improve: 3,
          edit: 4,
          complete: 5,
          resume: 6,
        }[variant];
        return {
          content: [{ type: 'text' as const, text: variant }],
          structuredContent: ORGX_PLAN_OUTPUT_VARIANTS[variantIndex],
        };
      }
    );

    const client = await connect(server);
    try {
      for (const variant of [
        'improve',
        'edit',
        'complete',
        'resume',
      ] as const) {
        const result = await client.callTool({
          name: 'orgx_plan',
          arguments: { variant },
        });
        expect(result.isError, variant).not.toBe(true);
        expect(result.structuredContent, variant).toEqual(
          ORGX_PLAN_OUTPUT_VARIANTS[
            { improve: 3, edit: 4, complete: 5, resume: 6 }[variant]
          ]
        );
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('validates a durable orgx_spawn delegation receipt through an MCP call', async () => {
    const server = new McpServer({
      name: 'orgx-spawn-durable-output',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'orgx_spawn',
      { description: 'Durable delegation probe', inputSchema: {} },
      async () => ({
        content: [{ type: 'text' as const, text: 'Delegation accepted.' }],
        structuredContent: ORGX_SPAWN_DURABLE_OUTPUT,
      })
    );

    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: 'orgx_spawn',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        delegation_contract: 'durable_delegation_v2',
        job_id: 'job-789',
        dispatch_receipt: {
          dispatch: 'cloud_claimed',
          jobStatus: 'running',
          publishId: 'inngest-event-1',
        },
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('keeps full scaffold validation behind the compact advertised schema', async () => {
    const server = new McpServer({
      name: 'orgx-scaffold-compact-output',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'scaffold_initiative',
      {
        description: 'Compact output validation probe',
        inputSchema: {
          variant: z.enum(['valid', 'malformed_nested', 'unexpected_root']),
        },
      },
      async ({ variant }) => {
        const valid = {
          ok: false,
          error_kind: 'billing_scaffold_limit_reached',
          usage: {
            scaffoldsUsed: 1,
            scaffoldsIncluded: 1,
            hasScaffolds: false,
          },
        };
        const structuredContent =
          variant === 'valid'
            ? valid
            : variant === 'malformed_nested'
            ? {
                ...valid,
                usage: { ...valid.usage, scaffoldsUsed: 'not-a-number' },
              }
            : { ...valid, unexpected: true };
        return {
          content: [{ type: 'text' as const, text: variant }],
          structuredContent,
        };
      }
    );

    const client = await connect(server);
    try {
      const valid = await client.callTool({
        name: 'scaffold_initiative',
        arguments: { variant: 'valid' },
      });
      expect(valid.isError).not.toBe(true);
      expect(valid.structuredContent).toEqual({
        ok: false,
        error_kind: 'billing_scaffold_limit_reached',
        usage: {
          scaffoldsUsed: 1,
          scaffoldsIncluded: 1,
          hasScaffolds: false,
        },
      });

      for (const variant of [
        'malformed_nested',
        'unexpected_root',
      ] as const) {
        const invalid = await client.callTool({
          name: 'scaffold_initiative',
          arguments: { variant },
        });
        expect(invalid.isError, variant).toBe(true);
        expect(invalid.content, variant).toEqual([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Output validation error'),
          }),
        ]);
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('rejects malformed structured output through the registration wrapper', async () => {
    const server = new McpServer({
      name: 'orgx-openai-malformed-output',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'orgx_search',
      { description: 'Malformed result probe', inputSchema: {} },
      async () => ({
        content: [{ type: 'text' as const, text: 'malformed' }],
        structuredContent: { unexpected: true },
      })
    );

    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: 'orgx_search',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Output validation error'),
        }),
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
