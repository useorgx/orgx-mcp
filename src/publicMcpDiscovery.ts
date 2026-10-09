import { V2_PUBLIC_SURFACE } from './toolProfiles';
import { WIDGET_ONLY_TOOL_IDS } from './widgetToolContract';
import { AUTHENTICATED_MCP_URL, getPublicClientProfiles } from './publicClientProfiles';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type PublicTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  annotations: {
    readOnlyHint: true;
  };
};

const PUBLIC_MCP_URL = 'https://mcp.useorgx.com/public';

export const PRIMARY_AUTHENTICATED_TOOLS = V2_PUBLIC_SURFACE;
const MODEL_OPERATION_TOOLS = PRIMARY_AUTHENTICATED_TOOLS.filter(
  (name) => !(WIDGET_ONLY_TOOL_IDS as readonly string[]).includes(name)
);

const PUBLIC_DISCOVERY_TOOLS: PublicTool[] = [
  {
    name: 'orgx_public_capabilities',
    title: 'OrgX public capabilities',
    description:
      'Describe OrgX MCP capabilities, authenticated endpoints, primary tools, and when agents should use OrgX. Discovery-only; does not read workspace data.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'orgx_public_tool_examples',
    title: 'OrgX tool examples',
    description:
      'Return synthetic prompts and schema-valid arguments for current OrgX model operations. Describes behavior without claiming that example work ran or was approved. Connect the authenticated MCP endpoint to execute tools.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          enum: MODEL_OPERATION_TOOLS,
          description:
            'Optional authenticated OrgX tool name to focus the examples on.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'orgx_public_connection_help',
    title: 'OrgX connection help',
    description:
      'Return installation guidance for connecting OrgX MCP from Cursor, Claude, ChatGPT, VS Code, or other MCP clients.',
    inputSchema: {
      type: 'object',
      properties: {
        client: {
          type: 'string',
          enum: ['cursor', 'claude', 'chatgpt', 'vscode', 'generic'],
          description: 'Optional client name for tailored setup notes.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'public, max-age=300');
  }
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers,
  });
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function toolResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function buildCapabilitiesPayload() {
  return {
    category: 'organizational memory for AI agents',
    public_endpoint: PUBLIC_MCP_URL,
    authenticated_endpoint: AUTHENTICATED_MCP_URL,
    authentication: {
      public_endpoint: 'not required',
      authenticated_endpoint: 'OAuth 2.x with PKCE and dynamic client registration',
    },
    use_orgx_when: [
      'remembering or recalling a team decision',
      'searching organizational memory or project context',
      'finding prior artifacts or plans',
      'reviewing agent work awaiting approval',
      'delegating work to specialist AI agents',
      'tracking project health, blockers, milestones, and owners',
    ],
    not_for: [
      'personal preference memory only',
      'generic web search',
      'code documentation lookup',
      'local file reads',
      'one-off notes that should not enter team memory',
    ],
    primary_authenticated_tools: PRIMARY_AUTHENTICATED_TOOLS,
    compatibility_profiles: getPublicClientProfiles(),
    profile_note:
      'Profiles describe registered tool inventories. OAuth scopes, workspace access and operation policy still apply to every authenticated call.',
    safety_note:
      'This public endpoint is discovery-only. It never returns customer workspace data and never executes authenticated OrgX actions.',
  };
}

// Synthetic records make references consistent across examples. Replace each
// identifier with one returned by the authenticated workspace before calling.
const EXAMPLE_IDS = {
  workspace: '00000000-0000-4000-8000-000000000001',
  initiative: '00000000-0000-4000-8000-000000000002',
  workstream: '00000000-0000-4000-8000-000000000003',
  milestone: '00000000-0000-4000-8000-000000000004',
  task: '00000000-0000-4000-8000-000000000005',
  plan: '00000000-0000-4000-8000-000000000006',
  decision: '00000000-0000-4000-8000-000000000007',
  artifact: '00000000-0000-4000-8000-000000000008',
  command: '00000000-0000-4000-8000-000000000009',
};
const EXAMPLE_PLAN = {
  initiative: { title: 'Example onboarding launch', summary: 'Prepare a reviewed launch checklist.' },
  workstreams: [{
    name: 'Engineering', domain: 'engineering',
    milestones: [{ title: 'Prepare launch', tasks: [{ title: 'Prepare launch checklist', type: 'implement' }] }],
  }],
};
const EXAMPLE_RECEIPT = {
  schema_version: 'agent-work-receipt/v0.2', receipt_id: 'example:launch-checklist:1',
  intent: { summary: 'Prepare an example launch checklist', criteria: [{ id: 'checklist', text: 'Checklist is available for review', source: 'requested' }] },
  actor: { type: 'agent', id: 'example-agent', runtime: { name: 'example-client' } },
  authority: { mode: 'none', status: 'unknown', scope: { actions: [], resources: [] } },
  actions: [{ id: 'prepare', type: 'document.prepare', summary: 'Prepare an illustrative checklist', status: 'completed' }],
  artifacts: [],
  evidence: [{ id: 'note', kind: 'note', summary: 'Illustrative evidence; replace with observed proof.', observed_at: '2026-10-08T12:00:00Z' }],
  outcome: { status: 'unknown', summary: 'Human review has not been recorded.', acceptance: { status: 'pending' }, criteria_results: [{ criterion_id: 'checklist', status: 'unknown', evidence_ids: ['note'] }] },
  verification: { status: 'unverified', method: 'No verification performed for this synthetic example.', checks: [], evidence_ids: [] },
  cost: { currency: 'USD', total: 0, estimated: true },
  lineage: { parent_receipt_refs: [], references: [] }, human_interventions: [],
  timestamps: { started_at: '2026-10-08T12:00:00Z', completed_at: '2026-10-08T12:00:00Z', issued_at: '2026-10-08T12:00:00Z' },
};
type ToolExample = {
  prompt: string;
  arguments: Record<string, unknown>;
  expected_behavior: string;
};
const example = (prompt: string, args: Record<string, unknown>, expectedBehavior: string): ToolExample => ({
  prompt, arguments: args, expected_behavior: expectedBehavior,
});
const workReference = { type: 'task', id: EXAMPLE_IDS.task };
const proofLocation = { external_url: 'https://github.com/useorgx/example/pull/1' };

const TOOL_EXAMPLES: Record<string, ToolExample> = {
  orgx_get_workspace_context: example('Read my authorized workspace context.', {},
    'Reads workspace context without selecting a workspace or creating a session.'),
  orgx_search: example('Find prior billing decisions.', { query: 'billing', type: 'decision' },
    'Returns authorized search results and pagination; follow returned references.'),
  orgx_inspect: example('Read this task before continuing it.', { ...workReference, hydrate_context: true },
    'Reads one authorized work record and its linked context.'),
  orgx_get_operator_brief: example('Show the workspace reporting for the last 30 days.', { period: '30d' },
    'Reads recorded chronology, progress, proof, priorities and gaps.'),
  orgx_get_next_actions: example('What should we prioritize next?', { entity_type: 'workspace', entity_id: EXAMPLE_IDS.workspace, limit: 3 },
    'Returns suggested priorities; the compatibility service records metered MCP allowance usage.'),
  orgx_get_agent_status: example('Show active agents.', { include_idle: false },
    'Reads agent status; the compatibility service records metered MCP allowance usage.'),
  orgx_get_initiative_progress: example('Read the initiative progress and blockers.', { initiative_id: EXAMPLE_IDS.initiative },
    'Reads progress and review gates; the compatibility service records metered MCP allowance usage.'),
  orgx_get_operation_status: example('Check the operation returned by the previous call.', { operation_id: `command:${EXAMPLE_IDS.command}` },
    'Reads command state without starting or settling work.'),
  orgx_check_execution_readiness: example('Check readiness before dispatch.', {},
    'Reports credential and configuration gaps without dispatching work.'),
  orgx_start_plan: example('Start a tracked onboarding plan.', { title: 'Example onboarding launch', initial_plan: '# Onboarding launch\nPrepare scope and owners.', idempotency_key: 'example:start-plan:1' },
    'Creates a planning draft. Use the returned plan_ref and revision for later edits.'),
  orgx_read_plan: example('Read the current planning draft.', { session_id: EXAMPLE_IDS.plan },
    'Returns the draft and authoritative revision; no plan changes are made.'),
  orgx_save_plan: example('Save the revised draft after reading its current revision.', { session_id: EXAMPLE_IDS.plan, plan_content: '# Onboarding launch\nPrepare checklist and review.', expected_version: 1, edit_summary: 'Add the review step.' },
    'Saves when the expected revision matches; stale revisions return a conflict.'),
  orgx_complete_plan: example('Complete the planning draft without launching work.', { session_id: EXAMPLE_IDS.plan, plan_content: '# Final launch plan\nPrepare and review the checklist.' },
    'Completes the planning session; executable work remains separate.'),
  orgx_validate_initiative_plan: example('Validate this hierarchy before creation.', { plan: EXAMPLE_PLAN },
    'Returns structural findings and a digest without creating work.'),
  orgx_create_initiative_hierarchy: example('Create the validated hierarchy without launching it.', { plan: EXAMPLE_PLAN, idempotency_key: 'example:create-hierarchy:1' },
    'Atomically creates private work records. Chain the actual returned references into later calls.'),
  orgx_create_initiative: example('Create the launch initiative.', { title: 'Example onboarding launch', idempotency_key: 'example:create-initiative:1' },
    'Creates an initial initiative. Workspace policy may require objectives.'),
  orgx_create_workstream: example('Create engineering work under this initiative.', { title: 'Engineering', initiative_id: EXAMPLE_IDS.initiative },
    'Creates one workstream without starting or dispatching it.'),
  orgx_create_milestone: example('Create a milestone under this workstream.', { title: 'Prepare launch', workstream_id: EXAMPLE_IDS.workstream },
    'Creates one milestone without starting or completing work.'),
  orgx_create_task: example('Create a task under this workstream and milestone.', { title: 'Prepare launch checklist', workstream_id: EXAMPLE_IDS.workstream, milestone_id: EXAMPLE_IDS.milestone, priority: 'high' },
    'Creates one task; it remains separate from agent dispatch.'),
  orgx_update_work: example('Update the task description and priority.', { ...workReference, fields: { description: 'Prepare a reviewable launch checklist.', priority: 'high' } },
    'Updates content only; status, approval and execution authority cannot be set by this patch.'),
  orgx_estimate_agent_task: example('Estimate the existing engineering task before dispatch.', { task: { task_id: EXAMPLE_IDS.task }, agent_type: 'engineering', max_cost_usd: 0.5 },
    'Returns routing and cost estimates without starting a run.'),
  orgx_start_agent_task: example('Dispatch this existing task within the budget.', { task_id: EXAMPLE_IDS.task, agent_type: 'engineering', max_cost_usd: 0.5 },
    'Dispatches only when eligibility, authority, budget and acceptance policy allow it; may incur costs.'),
  orgx_handoff_task: example('Hand this task to the design specialist.', { task_id: EXAMPLE_IDS.task, agent_type: 'design' },
    'Uses the canonical handoff lifecycle; permitted dispatch may incur costs.'),
  orgx_launch_initiative: example('Launch this initiative after readiness and approval checks.', { initiative_id: EXAMPLE_IDS.initiative },
    'May dispatch agents and incur costs after OrgX policy checks.'),
  orgx_pause_work: example('Pause this task and its active execution.', { level: 'task', id: EXAMPLE_IDS.task },
    'Uses lifecycle control to pause work and stop active runs; does not complete work.'),
  orgx_resume_work: example('Resume this paused task.', { level: 'task', id: EXAMPLE_IDS.task },
    'Uses permitted recovery and redispatch; may incur costs.'),
  orgx_retry_work: example('Retry this eligible failed task.', { level: 'task', id: EXAMPLE_IDS.task },
    'Preserves attempt lineage and checks recovery policy before redispatch.'),
  orgx_cancel_work: example('Cancel this task and active execution.', { level: 'task', id: EXAMPLE_IDS.task },
    'Cancels through lifecycle control without reporting successful completion.'),
  orgx_capture_decision: example('Record the proposed onboarding analytics decision for review.', { decision: 'Move onboarding analytics to PostHog', context: 'Proposed for funnel reporting; human review is pending.' },
    'Captures a decision and returns its recorded review state; does not approve it.'),
  orgx_list_pending_decisions: example('List decisions waiting for review.', {},
    'Reads pending decisions; each selected decision can be opened for human review.'),
  orgx_open_decision_review: example('Open this decision for my review.', { decision_id: EXAMPLE_IDS.decision },
    'Opens one pending decision. The human chooses the ruling.'),
  orgx_attach_artifact: example('Attach the PR as reviewable proof for this task.', { ...workReference, name: 'Launch checklist PR', artifact_type: 'eng.pull_request', location: proofLocation },
    'Registers proof in review; may trigger a paid external evaluation. Attaching does not approve or complete work.'),
  orgx_open_artifact_review: example('Open this artifact for human review.', { artifact_id: EXAMPLE_IDS.artifact },
    'Reads the review packet. Human actions use the review UI and its authenticated authority.'),
  orgx_request_independent_artifact_review: example('Request an independent assessment of this artifact.', { artifact_id: EXAMPLE_IDS.artifact },
    'Queues an evaluator selected by OrgX; may incur costs. The producing agent cannot choose the score.'),
  orgx_complete_work_with_proof: example('Attempt task completion with the linked proof.', { ...workReference, artifact: { name: 'Launch checklist PR', artifact_type: 'eng.pull_request', ...proofLocation } },
    'Records proof and checks completion requirements. Completion can remain blocked or awaiting review.'),
  orgx_submit_work_receipt: example('Import the portable receipt with its producer claims preserved.', { receipt: EXAMPLE_RECEIPT, idempotency_key: 'example:receipt:1' },
    'Imports a receipt without changing work status, authoritative verification or human acceptance.'),
  orgx_validate_work_receipt: example('Check this portable receipt before importing it.', { receipt: EXAMPLE_RECEIPT },
    'Checks document conformance without storing it or validating whether the evidence is true.'),
  orgx_get_work_receipt: example('Read the receipt and its separate human judgment.', { receipt_id: 'example:launch-checklist:1' },
    'Reads bounded producer evidence, claims, human judgment and uncertainty.'),
  orgx_list_work_receipts: example('Find receipts for this repository.', { query: 'repo:useorgx/example', limit: 10 },
    'Searches the ledger without model inference or judgment changes.'),
  orgx_get_receipt_review_queue: example('Show receipt outcomes waiting for a person.', { kind: 'outcome', limit: 10 },
    'Reads review suggestions; resolution requires the human review UI.'),
  orgx_record_plan_edit: example('Record a feedback summary without replacing the plan.', { session_id: EXAMPLE_IDS.plan, edit_summary: 'Clarify the review owner before creation.' },
    'Appends plan feedback; does not save markdown, complete planning or launch work.'),
};

function buildToolExamplesPayload(params: Record<string, unknown> | undefined) {
  const toolName =
    typeof params?.tool_name === 'string' &&
    params.tool_name in TOOL_EXAMPLES
      ? (params.tool_name as keyof typeof TOOL_EXAMPLES)
      : undefined;

  const examples = toolName
    ? { [toolName]: TOOL_EXAMPLES[toolName] }
    : TOOL_EXAMPLES;

  return {
    note:
      'These are example payloads only, using synthetic identifiers and documents. Replace identifiers with authorized references returned by OrgX. No example is an executed result or an approval. Connect https://mcp.useorgx.com/mcp with OAuth to call real tools.',
    authenticated_endpoint: AUTHENTICATED_MCP_URL,
    examples,
  };
}

function buildConnectionHelpPayload(params: Record<string, unknown> | undefined) {
  const client =
    typeof params?.client === 'string' ? params.client.toLowerCase() : 'generic';
  const base = {
    authenticated_endpoint: AUTHENTICATED_MCP_URL,
    public_discovery_endpoint: PUBLIC_MCP_URL,
    verification_calls: [
      { tool: 'orgx_get_workspace_context', arguments: {} },
      { tool: 'orgx_search', arguments: { query: 'recent decisions', type: 'decision' } },
      { tool: 'orgx_list_work_receipts', arguments: { query: '', limit: 5 } },
    ],
  };

  if (client === 'cursor') {
    return {
      ...base,
      client: 'cursor',
      config: {
        mcpServers: {
          orgx: {
            command: 'npx',
            args: ['mcp-remote', AUTHENTICATED_MCP_URL],
          },
        },
      },
    };
  }

  if (client === 'chatgpt') {
    return {
      ...base,
      client: 'chatgpt',
      steps: [
        'Open Settings -> Apps & Connectors.',
        'Enable Developer Mode or custom connectors if your workspace exposes it.',
        `Add ${AUTHENTICATED_MCP_URL} as a remote MCP connector.`,
        'Authenticate with OrgX OAuth when prompted.',
      ],
    };
  }

  if (client === 'claude') {
    return {
      ...base,
      client: 'claude',
      steps: [
        'Open Settings -> Connectors.',
        `Add ${AUTHENTICATED_MCP_URL} as a custom remote MCP connector.`,
        'Complete the OrgX OAuth flow in your browser.',
      ],
    };
  }

  if (client === 'vscode') {
    return {
      ...base,
      client: 'vscode',
      config: {
        servers: {
          orgx: {
            type: 'http',
            url: AUTHENTICATED_MCP_URL,
          },
        },
      },
    };
  }

  return {
    ...base,
    client: 'generic',
    steps: [
      `Use ${AUTHENTICATED_MCP_URL} for authenticated streamable HTTP MCP.`,
      'Use the legacy /sse endpoint only when a client explicitly requires SSE.',
      `Use ${PUBLIC_MCP_URL} only for no-auth discovery and example payloads.`,
    ],
  };
}

function handleToolCall(request: JsonRpcRequest) {
  const name =
    typeof request.params?.name === 'string' ? request.params.name : undefined;
  const args =
    request.params?.arguments &&
    typeof request.params.arguments === 'object' &&
    !Array.isArray(request.params.arguments)
      ? (request.params.arguments as Record<string, unknown>)
      : {};

  switch (name) {
    case 'orgx_public_capabilities':
      return jsonRpcResult(request.id, toolResult(buildCapabilitiesPayload()));
    case 'orgx_public_tool_examples':
      if (args.tool_name !== undefined &&
        (typeof args.tool_name !== 'string' || !MODEL_OPERATION_TOOLS.includes(args.tool_name))) {
        return jsonRpcError(request.id, -32602, 'Unknown current model operation', {
          available_tools: MODEL_OPERATION_TOOLS,
          note: 'Legacy client inventories are listed in orgx_public_capabilities.compatibility_profiles.',
        });
      }
      return jsonRpcResult(request.id, toolResult(buildToolExamplesPayload(args)));
    case 'orgx_public_connection_help':
      return jsonRpcResult(request.id, toolResult(buildConnectionHelpPayload(args)));
    default:
      return jsonRpcError(request.id, -32602, 'Unknown public discovery tool', {
        available_tools: PUBLIC_DISCOVERY_TOOLS.map((tool) => tool.name),
        note:
          'Authenticated OrgX tools require https://mcp.useorgx.com/mcp and OAuth.',
      });
  }
}

function handleJsonRpc(request: JsonRpcRequest) {
  switch (request.method) {
    case 'initialize':
      return jsonRpcResult(request.id, {
        protocolVersion: '2025-06-18',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'OrgX MCP Public Discovery',
          version: '1.0.4',
        },
        instructions:
          'This is a no-auth discovery endpoint. Use https://mcp.useorgx.com/mcp with OAuth for real OrgX workspace tools.',
      });
    case 'ping':
      return jsonRpcResult(request.id, {});
    case 'tools/list':
      return jsonRpcResult(request.id, {
        tools: PUBLIC_DISCOVERY_TOOLS,
      });
    case 'tools/call':
      return handleToolCall(request);
    default:
      return jsonRpcError(
        request.id,
        -32601,
        `Unsupported public discovery method: ${request.method ?? 'unknown'}`
      );
  }
}

function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined && typeof request.method === 'string';
}

export async function handlePublicMcpDiscoveryRequest(
  request: Request
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const response = jsonResponse({
      name: 'OrgX MCP Public Discovery',
      description:
        'No-auth MCP discovery endpoint for OrgX capabilities, example payloads, and setup help.',
      public_endpoint: PUBLIC_MCP_URL,
      authenticated_endpoint: AUTHENTICATED_MCP_URL,
      authentication_required: false,
      execution_model:
        'Discovery-only. Does not expose workspace data or execute authenticated OrgX actions.',
      supported_json_rpc_methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
      public_tools: PUBLIC_DISCOVERY_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      primary_authenticated_tools: PRIMARY_AUTHENTICATED_TOOLS,
      compatibility_profiles: getPublicClientProfiles(),
      profile_note: 'Profile inventories do not grant access. OAuth scopes, workspace access and operation policy are checked on authenticated calls.',
    });
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      {
        error: 'method_not_allowed',
        error_description:
          'OrgX public discovery supports GET, HEAD, OPTIONS, and MCP JSON-RPC POST requests.',
      },
      { status: 405, headers: { allow: 'GET,HEAD,OPTIONS,POST' } }
    );
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (Array.isArray(payload)) {
    const responses = payload
      .filter((item) => !isNotification(item))
      .map((item) => handleJsonRpc(item));
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return jsonResponse(responses, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (isNotification(payload)) {
    return new Response(null, { status: 202 });
  }

  return jsonResponse(handleJsonRpc(payload), {
    headers: { 'cache-control': 'no-store' },
  });
}
