import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAiProvider,
  evaluateSelectionThresholds,
  fetchMcpToolsList,
  fixturesForProfile,
  runLiveSelectionFromEnvironment,
  runSelectionSuite,
  validateJsonSchema,
} from '../scripts/agent-selection-runner.mjs';

const tools = [
  {
    name: 'alpha',
    description: 'Alpha action',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'beta',
    description: 'Beta action',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

describe('agent selection runner', () => {
  it('keeps profile-specific intents out of incompatible tools/list runs', () => {
    const fixtures = [
      { id: 'public', profiles: ['v2', 'full'] },
      { id: 'admin', profiles: ['full'] },
      { id: 'all' },
    ];
    expect(fixturesForProfile(fixtures, 'v2').map((fixture) => fixture.id)).toEqual([
      'public',
      'all',
    ]);
  });

  it('fetches the real per-profile MCP tools/list after initialize', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'orgx', version: 'test' },
            },
          },
          { headers: { 'mcp-session-id': 'session-1' } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: '2.0', id: 2, result: { tools } })
      );

    const manifest = await fetchMcpToolsList({
      endpoint: 'https://mcp.example.test/mcp',
      profile: 'executor',
      accessToken: 'secret-not-logged',
      fetchImpl,
    });

    expect(manifest.profile).toBe('executor');
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(manifest.session_established).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0].toString()).toContain(
      'profile=executor'
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer secret-not-logged',
      'mcp-session-id': 'session-1',
    });
    expect(JSON.parse(fetchImpl.mock.calls[2]?.[1]?.body as string)).toMatchObject(
      { method: 'tools/list' }
    );
  });

  it('produces deterministic selection, retry, latency, byte, and calls-to-success metrics', async () => {
    let call = 0;
    const provider = {
      id: 'deterministic',
      model: 'fixture-model',
      select: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            selected_tool: 'beta',
            arguments: { query: 'launch' },
            attempts: 2,
            latency_ms: 10,
            request_bytes: 100,
            response_bytes: 50,
          };
        }
        return {
          selected_tool: 'alpha',
          arguments: {},
          attempts: 1,
          latency_ms: 20,
          request_bytes: 100,
          response_bytes: 50,
        };
      }),
    };

    const report = await runSelectionSuite({
      fixtures: [
        {
          id: 'choose-beta',
          prompt: 'Search beta',
          expected_tool: 'beta',
          expected_arguments: { query: 'launch' },
          forbidden_tool: 'alpha',
        },
      ],
      tools,
      providers: [provider],
      iterations: 2,
      concurrency: 1,
      profile: 'fixture',
    });

    expect(report.metrics).toMatchObject({
      run_count: 2,
      completed_run_count: 2,
      top_1_accuracy: 0.5,
      forbidden_confusion_rate: 0.5,
      argument_validity_rate: 1,
      provider_retry_count: 1,
      provider_call_count: 3,
      calls_per_success: 3,
      latency_ms: { p50: 10, p95: 20, max: 20 },
      bytes: { request_total: 200, response_total: 100 },
    });
    expect(report.metrics.fixtures[0]).toMatchObject({
      provider: 'deterministic',
      fixture_id: 'choose-beta',
      expected_tool_rate: 0.5,
      forbidden_tool_rate: 0.5,
      argument_validity_rate: 1,
      expected_arguments_match_rate: 0.5,
      provider_retries: 1,
      calls_to_first_success: 1,
    });
    expect(evaluateSelectionThresholds(report)).toMatchObject({
      passed: false,
    });
  });

  it('validates nested required fields, enums, arrays, and additional properties', () => {
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'inspect'] },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    };

    expect(
      validateJsonSchema(
        { action: 'search', filters: [{ value: 2 }] },
        schema
      )
    ).toEqual([]);
    expect(
      validateJsonSchema(
        { action: 'write', filters: [{ value: 2.5, extra: true }] },
        schema
      )
    ).toEqual([
      '$.action is not an allowed enum value',
      '$.filters[0].value must be integer',
      '$.filters[0].extra is not allowed',
    ]);
  });

  it('retries transient provider responses and parses an OpenAI function call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          output: [
            {
              type: 'function_call',
              name: 'beta',
              arguments: '{"query":"launch"}',
            },
          ],
        })
      );
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://openai.example.test/v1',
      fetchImpl,
      maxRetries: 1,
    });

    const selection = await provider.select({ prompt: 'Search', tools });
    expect(selection).toMatchObject({
      selected_tool: 'beta',
      arguments: { query: 'launch' },
      attempts: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(selection.request_bytes).toBeGreaterThan(0);
    expect(selection.response_bytes).toBe(
      new TextEncoder().encode('rate limited').byteLength +
        new TextEncoder().encode(
          JSON.stringify({
            output: [
              {
                type: 'function_call',
                name: 'beta',
                arguments: '{"query":"launch"}',
              },
            ],
          })
        ).byteLength
    );
  });

  it('retains retry, latency, and byte evidence when every provider attempt fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('still busy', { status: 503 }));
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://openai.example.test/v1',
      fetchImpl,
      maxRetries: 1,
    });

    let failure: any;
    try {
      await provider.select({ prompt: 'Search', tools });
    } catch (error) {
      failure = error;
    }

    expect(failure?.provider_metrics).toMatchObject({
      attempts: 2,
      latency_ms: expect.any(Number),
      request_bytes: expect.any(Number),
      response_bytes:
        new TextEncoder().encode('busy').byteLength +
        new TextEncoder().encode('still busy').byteLength,
    });
  });

  it('keeps live provider calls fail-closed behind the explicit gate', async () => {
    await expect(
      runLiveSelectionFromEnvironment({
        fixtures: [],
        env: {},
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow('RUN_AGENT_SELECTION_TESTS=1');
  });
});
