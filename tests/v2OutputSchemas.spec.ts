import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFailureDetails } from '../src/agentErgonomics';
import { toolError } from '../src/authHelpers';
import { directHumanDecisionActionRequired } from '../src/directHumanDecisionAction';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { V2_PUBLIC_SURFACE, resolveProfileToolSet } from '../src/toolProfiles';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import {
  CONTEXT_TAIL_MATERIAL_EVENT_TYPES,
  CONTEXT_TAIL_SUPPORTED_CHANGE_CLASSES,
  CONTEXT_TAIL_UNAVAILABLE_CHANGE_CLASSES,
} from '../src/workCommandContract';
import {
  buildControllerStatusEnvelope,
  buildNeverRunControllerStatusEnvelope,
} from './fixtures/controllerStatus';
import { findBooleanAdditionalProperties } from './fixtures/outputSchemaPortability';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';

/**
 * A server that returns whatever the current test hands it, for every tool on
 * the selected public/native surface, with the production schema-registration wrapper
 * installed. callTool then exercises both validators the SDK applies: the
 * server's Zod check on success and the client's JSON Schema check on every
 * result that carries structuredContent — errors included.
 */
async function connectSurface(profile: 'v2' | 'legacy' = 'v2') {
  let next: CallToolResult = { content: [] };
  const server = new McpServer({ name: 'orgx-v2-output', version: '1.0.0' });
  const toolsForProfile = resolveProfileToolSet(profile)!;
  installToolResultGuidanceWrapper(server, toolsForProfile, undefined, undefined, false, profile);
  for (const name of toolsForProfile) {
    server.registerTool(
      name,
      { description: `${name} probe`, inputSchema: {} },
      async () => next
    );
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orgx-v2-output-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  return {
    client,
    tools,
    close: () => Promise.allSettled([client.close(), server.close()]),
    call: (name: string, result: CallToolResult) => {
      // Real transports JSON-encode the result, which drops undefined keys.
      // InMemoryTransport passes objects by reference and would keep them, so
      // round-trip here to validate exactly what crosses the wire.
      next = JSON.parse(JSON.stringify(result)) as CallToolResult;
      return client.callTool({ name, arguments: {} });
    },
  };
}

const success = (structuredContent: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: 'ok' }],
  structuredContent,
});

// Success payloads, shaped from the code that produces each one (see the
// source notes in src/openaiOutputSchemas/v2.ts).
const REPRESENTATIVE: Record<string, Record<string, unknown>[]> = {
  orgx_tail: [
    {
      _v2_tool: 'orgx_tail',
      base_verified: true,
      rebootstrap_required: false,
      current_capsule_id: 'ctx_current',
      reusable_for_consequential_action: false,
      delivery_mode: 'partial_event_feed',
      capsule_id: 'ctx_base',
      after_sequence: 4,
      next_after_sequence: 9,
      has_more: false,
      material_changes: [{ sequence: 5, event_type: 'decision.resolved' }],
      coverage: {
        supported_event_types: [...CONTEXT_TAIL_MATERIAL_EVENT_TYPES],
        supported_change_classes: [...CONTEXT_TAIL_SUPPORTED_CHANGE_CLASSES],
        unavailable_change_classes: [...CONTEXT_TAIL_UNAVAILABLE_CHANGE_CLASSES],
      },
    },
  ],
  orgx_controller_status: [
    buildControllerStatusEnvelope() as unknown as Record<string, unknown>,
    buildNeverRunControllerStatusEnvelope() as unknown as Record<string, unknown>,
  ],
  orgx_expect: [
    {
      expectation: { id: 'exp_1', status: 'pending' },
      replayed: false,
      _v2_tool: 'orgx_expect',
      idempotency_key: 'idem-1',
    },
  ],
  orgx_emit_activity: [
    {
      ok: true,
      run_id: UUID,
      event_id: UUID_2,
      reused_run: false,
      session_row_id: UUID,
      auth_mode: 'api_key',
    },
    // The unattributed path: no run was minted, so the ids are null.
    {
      ok: true,
      run_id: null,
      event_id: null,
      reused_run: false,
      attribution: { mode: 'workspace_inbox' },
      auth_mode: 'api_key',
    },
  ],
  orgx_request_question: [
    {
      ok: true,
      decision_id: UUID,
      status: 'pending',
      attention_url: `/api/v1/live/attention/${UUID}`,
      answer_url: `/api/v1/live/questions/${UUID}`,
      changeset_id: UUID_2,
      run_id: UUID,
      replayed: false,
    },
  ],
  orgx_poll_question: [
    {
      ok: true,
      question: {
        id: UUID,
        prompt: 'Ship the pricing page?',
        context: null,
        status: 'approved',
        resolved: true,
        resolution: 'approved',
        answer: 'yes',
        resolution_context: null,
        resolved_at: '2026-09-28T12:00:00.000Z',
        source: {
          client: 'claude',
          run_id: null,
          session_id: null,
          stream_id: null,
          workstream_id: null,
        },
        continuation: { request: null, should_resume: true, runtime: null },
        updated_at: '2026-09-28T12:00:00.000Z',
      },
    },
  ],
  orgx_ack_attention: [
    {
      ok: true,
      replayed: false,
      decision_id: UUID,
      continuation: { state: 'resumed' },
    },
  ],
  orgx_emit_execution_graph: [
    {
      execution_graph_fingerprint: 'fp_1',
      emission_id: 'em_1',
      session_row_id: UUID,
      progress_pct: 40,
      node_counts: { total: 3, done: 1 },
      trust_signals: { verified_nodes: 1 },
      coordination: { ready: ['n2'], blocked: [], cycles: [] },
      auth_mode: 'api_key',
    },
  ],
  consolidate_pr: [
    {
      status: 'merged',
      artifact_id: UUID,
      verdict: 'pass',
      aq_score: 0.91,
      auth_mode: 'api_key',
    },
  ],
  request_independent_artifact_review: [
    {
      artifact_id: UUID,
      artifact_version: 1,
      agent_type: null,
      status: 'queued',
      rubric_version: 'orgx.independent_agent_artifact.v1',
      rating_scale: '1-5',
      independent_of_producer: true,
    },
  ],
  query_org_memory: [
    {
      retention_window_days: 90,
      retention_applied: true,
      total_found: 1,
      results_by_type: { decisions: [{ id: UUID, title: 'Rate limits' }] },
      message: 'Found 1 relevant item.',
      suggested_followups: [],
    },
  ],
  spawn_agent_task: [
    // Deduplicated: an equivalent run was already in flight.
    {
      deduped: true,
      run_id: UUID,
      run_short_id: 'abc123',
      agent_id: 'pace',
      agent_profile_id: null,
      agent_name: 'Pace',
      status: 'queued',
      initiative_id: UUID_2,
      message: 'Reused the run already in flight.',
    },
    {
      task_id: UUID,
      run_id: UUID_2,
      agent_id: 'eli',
      agent_name: 'Eli',
      status: 'running',
      live_url: `https://useorgx.com/live/${UUID_2}`,
      message: 'Task assigned to Eli.',
    },
  ],
  recommend_next_action: [
    {
      entity_type: 'initiative',
      entity_id: UUID,
      canonical_only: true,
      recommendations: [{ id: 'r1', title: 'Resolve the pricing decision' }],
      next_action: { id: 'r1' },
      message: 'Recommended 1 next action.',
    },
  ],
};
// Tools that share a producer share the payloads.
REPRESENTATIVE.orgx_request_attention = REPRESENTATIVE.orgx_request_question;
REPRESENTATIVE.orgx_poll_attention = REPRESENTATIVE.orgx_poll_question;
REPRESENTATIVE.recall_memory = REPRESENTATIVE.query_org_memory;
REPRESENTATIVE.delegate_agent_task = REPRESENTATIVE.spawn_agent_task;

// The error results the worker really produces, built by the real builders.
function realErrorResults(toolId: string): Array<[string, CallToolResult]> {
  const approve = directHumanDecisionActionRequired(UUID, 'approve');
  const reject = directHumanDecisionActionRequired(UUID, 'reject');
  return [
    ['human authority (approve)', toolError(approve.message, approve.options)],
    ['human authority (reject)', toolError(reject.message, reject.options)],
    [
      'client-integration failure',
      toolError('Client integration tool execution failed', {
        code: 'client_integration_failed',
        status: 502,
        details: buildFailureDetails({
          toolId,
          error: new Error('upstream returned 502'),
          args: {},
        }),
      }),
    ],
    [
      'rejected execution graph',
      toolError('Execution graph is incomplete', {
        code: 'invalid_execution_graph',
        status: 422,
        details: { gaps: ['node n3 has no owner'] },
      }),
    ],
    ['bare message', toolError('Something failed')],
  ];
}

let surface: Awaited<ReturnType<typeof connectSurface>> | undefined;
afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

describe('v2 output schemas', () => {
  it('advertises an output schema for every tool on the published v2 surface', async () => {
    surface = await connectSurface();
    const missing = surface.tools
      .filter((tool) => !tool.outputSchema)
      .map((tool) => tool.name);
    expect(missing).toEqual([]);
    expect(surface.tools).toHaveLength(V2_PUBLIC_SURFACE.length);
  });

  it('never uses a boolean additionalProperties anywhere on the surface', async () => {
    surface = await connectSurface();
    for (const tool of surface.tools) {
      expect(
        findBooleanAdditionalProperties(tool.outputSchema),
        `${tool.name} must express openness with a typed catchall`
      ).toEqual([]);
    }
  });

  it('delivers every real error shape to the client instead of rejecting it', async () => {
    // Regression: `details` used to be advertised closed, so the SDK client
    // rejected the error and the caller never saw the message or review URL.
    surface = await connectSurface();
    for (const name of V2_PUBLIC_SURFACE) {
      for (const [label, result] of realErrorResults(name)) {
        const received = await surface.call(name, result);
        expect(received.isError, `${name}: ${label}`).toBe(true);
        expect(received.structuredContent, `${name}: ${label}`).toEqual(
          JSON.parse(JSON.stringify(result.structuredContent))
        );
      }
    }
  });

  it('keeps the review URL a human needs on the decision tools', async () => {
    surface = await connectSurface('legacy');
    const approve = directHumanDecisionActionRequired(UUID, 'approve');
    for (const name of ['approve_decision', 'reject_decision', 'approve_agent_work']) {
      const received = (await surface.call(
        name,
        toolError(approve.message, approve.options)
      )) as { structuredContent?: { error?: { details?: { review_url?: string } } } };
      expect(received.structuredContent?.error?.details?.review_url, name).toMatch(
        /^https?:\/\//
      );
    }
  });

  it('accepts representative native success payloads through the explicit runtime profile', async () => {
    surface = await connectSurface('legacy');
    for (const [name, payloads] of Object.entries(REPRESENTATIVE)) {
      for (const payload of payloads) {
        // Not compared for equality: the production wrapper rewrites guidance
        // fields (it nulls a next_action that names no real tool). What
        // matters here is that neither validator rejects the payload.
        const received = await surface.call(name, success(payload));
        expect(received.isError, name).toBeFalsy();
        expect(received.structuredContent, name).toBeDefined();
      }
    }
  });

  it('accepts fields the upstream API adds later', async () => {
    // These payloads are owned by the OrgX API, which evolves on its own
    // schedule. A new field must not turn a working call into a failure.
    surface = await connectSurface('legacy');
    for (const [name, payloads] of Object.entries(REPRESENTATIVE)) {
      if (name === 'orgx_controller_status') continue; // exact, validated envelope
      const payload = {
        ...payloads[0],
        added_by_a_later_api_release: { nested: [1, 'two', null, { deep: true }] },
      };
      const received = (await surface.call(name, success(payload))) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      expect(received.isError, name).toBeFalsy();
      expect(
        received.structuredContent?.added_by_a_later_api_release,
        name
      ).toEqual(payload.added_by_a_later_api_release);
    }
  });

  it('still rejects a declared field of the wrong type', async () => {
    // Open is not the same as unchecked: the fields a schema names are typed.
    // The SDK reports a server-side output validation failure as an error
    // result naming the field, rather than throwing.
    surface = await connectSurface('legacy');
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        'orgx_emit_activity',
        { ...REPRESENTATIVE.orgx_emit_activity[0], reused_run: 'yes' },
        'reused_run',
      ],
      [
        'request_independent_artifact_review',
        {
          ...REPRESENTATIVE.request_independent_artifact_review[0],
          artifact_version: '1',
        },
        'artifact_version',
      ],
    ];
    for (const [name, payload, field] of cases) {
      const received = (await surface.call(name, success(payload))) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      expect(received.isError, name).toBe(true);
      expect(received.content?.[0]?.text, name).toContain(field);
    }
  });

  it('gives an alias the exact contract of the tool it runs', () => {
    expect(getToolOutputSchema('track_project_progress')).toBe(
      getToolOutputSchema('get_initiative_pulse')
    );
    expect(getToolOutputSchema('recall_memory')).toBe(
      getToolOutputSchema('query_org_memory')
    );
    expect(getToolOutputSchema('delegate_agent_task')).toBe(
      getToolOutputSchema('spawn_agent_task')
    );
  });

  it('invents nothing for a tool without a verified contract', () => {
    expect(getToolOutputSchema('not_a_published_tool')).toBeUndefined();
  });
});
