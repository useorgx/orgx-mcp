import { V2_PUBLIC_SURFACE } from './toolProfiles';

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

const AUTHENTICATED_MCP_URL = 'https://mcp.useorgx.com/mcp';
const PUBLIC_MCP_URL = 'https://mcp.useorgx.com/public';

export const PRIMARY_AUTHENTICATED_TOOLS = V2_PUBLIC_SURFACE;

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
      'Return example prompts, arguments, and sample responses for primary OrgX tools. Discovery-only; connect the authenticated MCP endpoint to execute real tools.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          enum: PRIMARY_AUTHENTICATED_TOOLS,
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
    safety_note:
      'This public endpoint is discovery-only. It never returns customer workspace data and never executes authenticated OrgX actions.',
  };
}

const TOOL_EXAMPLES: Record<
  (typeof PRIMARY_AUTHENTICATED_TOOLS)[number],
  {
    prompt: string;
    arguments: Record<string, unknown>;
    sample_response: Record<string, unknown>;
  }
> = {
  orgx_decide: {
    prompt:
      'Remember this decision for the team: we are moving onboarding analytics to PostHog.',
    arguments: {
      action: 'remember',
      decision: 'Move onboarding analytics to PostHog',
      context: 'Chosen for funnel visibility and product-led activation reporting.',
    },
    sample_response: {
      saved: true,
      type: 'decision',
      recall_hint: 'Ask "what did we decide about onboarding analytics?"',
    },
  },
  orgx_search: {
    prompt: 'What did we decide about billing?',
    arguments: {
      query: 'billing decisions',
      type: 'decision',
    },
    sample_response: {
      results: [
        {
          type: 'decision',
          title: 'Billing provider direction',
          excerpt: 'Use Stripe Checkout for the first paid conversion path.',
        },
      ],
    },
  },
  orgx_inspect: {
    prompt: 'Show me the full context for this task before I work on it.',
    arguments: {
      type: 'task',
      id: 'task_123',
      hydrate_context: true,
    },
    sample_response: {
      task: { id: 'task_123', title: 'Prepare launch checklist' },
      hydrated_context: [],
    },
  },
  orgx_recommend: {
    prompt: 'What should we prioritize next?',
    arguments: {
      mode: 'next_action',
      entity_type: 'workspace',
      limit: 3,
    },
    sample_response: {
      recommendations: [{ title: 'Unblock launch checklist', priority: 'high' }],
    },
  },
  orgx_write: {
    prompt: 'Create a high-priority task under this milestone.',
    arguments: {
      operation: 'create',
      type: 'task',
      milestone_id: 'milestone_123',
      title: 'Prepare launch checklist',
      priority: 'high',
      idempotency_key: 'example-create-task-1',
    },
    sample_response: {
      type: 'task',
      data: { id: 'task_123', title: 'Prepare launch checklist' },
    },
  },
  orgx_attach: {
    prompt: 'Attach this PR as proof for the task.',
    arguments: {
      type: 'task',
      id: 'task_123',
      name: 'Launch checklist PR',
      artifact_type: 'eng.pull_request',
      external_url: 'https://github.com/useorgx/example/pull/1',
      agent_type: 'engineering',
      company_stage: 'founder_led_company',
      business_outcome: 'Ship the launch checklist fix with reviewable proof.',
      owner: 'engineering-agent',
      review_date: '2026-05-27',
      verification: ['unit tests pass', 'PR review requested'],
      idempotency_key: 'example-attach-pr-1',
    },
    sample_response: {
      artifact: { id: 'artifact_123', status: 'approved' },
    },
  },
  orgx_act: {
    prompt: 'Complete this task after proof is attached.',
    arguments: {
      type: 'task',
      id: 'task_123',
      action: 'complete',
    },
    sample_response: {
      transition: { from: 'in_progress', to: 'completed' },
    },
  },
  orgx_plan: {
    prompt: 'Start a tracked plan for the new onboarding flow.',
    arguments: {
      action: 'start',
      feature_name: 'New onboarding flow',
      initial_plan: 'Draft the first-pass scope and owners.',
    },
    sample_response: {
      session_id: 'plan_123',
    },
  },
  orgx_spawn: {
    prompt: 'Estimate this engineering task before delegating it.',
    arguments: {
      action: 'estimate',
      title: 'Audit onboarding funnel',
      agent_type: 'engineering-agent',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      max_cost_usd: 0.5,
    },
    sample_response: {
      estimate_only: true,
      tier: 'standard',
      estimated_cost_usd: 0.12,
    },
  },
  orgx_submit_receipt: {
    prompt: 'Submit the proof receipt for this completed task.',
    arguments: {
      receipt_type: 'proof',
      entity_type: 'task',
      entity_id: 'task_123',
      summary: 'PR merged and tests passed.',
      artifact_type: 'eng.pull_request',
      agent_type: 'engineering',
      business_outcome: 'Ship the launch checklist fix with reviewable proof.',
      verification_status: 'passed',
      evidence: { pull_request: 'https://github.com/useorgx/example/pull/1' },
      idempotency_key: 'example-receipt-1',
    },
    sample_response: {
      receipt_id: 'receipt_123',
    },
  },
  orgx_emit_activity: {
    prompt: 'Record execution progress for the active run.',
    arguments: {
      phase: 'running',
      message: 'Implementation started.',
    },
    sample_response: {
      ok: true,
    },
  },
  orgx_request_attention: {
    prompt:
      'Ask the initiative owner for permission and preserve this Claude Code session.',
    arguments: {
      initiative_id: '00000000-0000-4000-8000-000000000000',
      correlation_id: 'claude-permission-1',
      source_client: 'claude-code',
      source_tool: 'permission_prompt',
      source_session_id: 'claude-session-123',
      idempotency_key: 'claude-permission-1',
      attention_kind: 'permission',
      question: 'May this session update the deployment configuration?',
      context: 'The scoped config diff is prepared but has not been applied.',
      impact_if_delayed: 'Deployment work remains paused.',
      response_mode: 'confirmation',
      continuation: {
        strategy: 'resume_session',
        session_handle: 'claude-session-123',
      },
    },
    sample_response: {
      decision_id: '00000000-0000-4000-8000-000000000001',
      status: 'pending',
    },
  },
  orgx_poll_attention: {
    prompt: 'Check whether the owner answered a preserved attention request.',
    arguments: {
      attention_id: '00000000-0000-4000-8000-000000000001',
    },
    sample_response: {
      question: {
        resolved: true,
        answer: 'confirmed',
        continuation: { should_resume: true },
      },
    },
  },
  orgx_ack_attention: {
    prompt: 'Confirm that native execution resumed after applying the answer.',
    arguments: {
      attention_id: '00000000-0000-4000-8000-000000000001',
      state: 'resumed',
      idempotency_key: 'claude-permission-1-resumed',
      session_handle: 'claude-session-123',
    },
    sample_response: {
      ok: true,
      continuation: { state: 'resumed' },
    },
  },
  orgx_request_question: {
    prompt:
      'Pause this Codex session and ask the initiative owner which launch direction to use.',
    arguments: {
      initiative_id: '00000000-0000-4000-8000-000000000000',
      correlation_id: 'codex-launch-question-1',
      source_client: 'codex',
      source_tool: 'request_user_input',
      source_session_id: 'codex-session-123',
      idempotency_key: 'codex-launch-question-1',
      question: 'Which launch direction should this session implement?',
      context:
        'The working tree and run are preserved. The selected option changes the implementation direction.',
      response_mode: 'single_select',
      options: [
        { id: 'focused', label: 'Focused launch' },
        { id: 'broad', label: 'Broad launch' },
      ],
    },
    sample_response: {
      decision_id: '00000000-0000-4000-8000-000000000001',
      status: 'pending',
    },
  },
  orgx_poll_question: {
    prompt: 'Check whether the initiative owner answered the paused question.',
    arguments: {
      question_id: '00000000-0000-4000-8000-000000000001',
    },
    sample_response: {
      question: {
        resolved: true,
        answer: 'Focused launch',
        continuation: { should_resume: true },
      },
    },
  },
  orgx_emit_execution_graph: {
    prompt: 'Emit the execution graph and trust ledger for the active run.',
    arguments: {
      initiative_id: '00000000-0000-0000-0000-000000000000',
      nodes: [
        {
          id: 'build',
          type: 'task',
          title: 'Build the feature',
          status: 'completed',
          requires_evidence: true,
          verification: { state: 'passed', evidence_ref: 'pr#1' },
        },
      ],
    },
    sample_response: {
      ok: true,
    },
  },
  check_execution_readiness: {
    prompt: 'Check whether this workspace is ready to dispatch agent work.',
    arguments: {},
    sample_response: {
      ready: true,
      missing: [],
    },
  },
  orgx_bootstrap: {
    prompt: 'Start an OrgX MCP session and show me the available v2 tools.',
    arguments: {
      client_name: 'example-client',
    },
    sample_response: {
      profile: 'v2',
      visible_tools_count: 28,
    },
  },
  approve_decision: {
    prompt: 'Approve the selected decision from the decisions widget.',
    arguments: { decision_id: 'decision_123', note: 'Approved for launch.' },
    sample_response: { status: 'approved' },
  },
  reject_decision: {
    prompt: 'Request changes on this decision.',
    arguments: { decision_id: 'decision_123', reason: 'Need clearer proof.' },
    sample_response: { status: 'rejected' },
  },
  get_agent_status: {
    prompt: 'Show me what the agents are doing.',
    arguments: { include_idle: false },
    sample_response: { agents: [{ id: 'agent_123', status: 'running' }] },
  },
  get_initiative_pulse: {
    prompt: 'Show the health of this initiative.',
    arguments: { initiative_id: 'initiative_123' },
    sample_response: { health: 'on_track', blockers: [] },
  },
  scaffold_initiative: {
    prompt: 'Create an initiative with workstreams, milestones, and tasks.',
    arguments: {
      mode: 'scaffold',
      title: 'Example launch',
      objective_ids: ['objective_123'],
      workstreams: [
        {
          title: 'Engineering',
          milestones: [{ title: 'Ship worker', tasks: [{ title: 'Merge PR' }] }],
        },
      ],
    },
    sample_response: {
      initiative_id: 'initiative_123',
      ref_map: {
        initiative: 'initiative_123',
        'workstream:engineering': 'workstream_123',
      },
      preferred_next_calls: [
        {
          tool: 'orgx_inspect',
          args: {
            type: 'initiative',
            id: 'initiative_123',
            hydrate_context: true,
          },
        },
      ],
    },
  },
  spawn_agent_task: {
    prompt: 'Have an engineering agent handle this task.',
    arguments: {
      agent: 'engineering-agent',
      task: 'Implement the worker fix and return a PR URL or structured blocker.',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      max_cost_usd: 0.5,
    },
    sample_response: {
      run_id: 'run_123',
      status: 'queued',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
    },
  },
  handoff_task: {
    prompt: 'Hand this task to the design agent.',
    arguments: { task_id: 'task_123', agent: 'design-agent', spawn: true },
    sample_response: { status: 'handed_off' },
  },
  recommend_next_action: {
    prompt: 'Show the next best actions assigned to the operations agent.',
    arguments: {
      entity_type: 'workspace',
      entity_id: 'default',
      agent_id: 'operations-agent',
      domain: 'operations',
      canonical_only: true,
      limit: 3,
    },
    sample_response: { recommendations: [{ title: 'Resolve blocker' }] },
  },
  query_org_memory: {
    prompt: 'Search memory for billing launch decisions.',
    arguments: { query: 'billing launch decisions', scope: 'decisions' },
    sample_response: { results: [{ title: 'Billing launch direction' }] },
  },
  recall_memory: {
    prompt: 'Recall prior decisions about onboarding.',
    arguments: { query: 'onboarding decisions', scope: 'decisions' },
    sample_response: { results: [{ title: 'Onboarding analytics' }] },
  },
  approve_agent_work: {
    prompt: 'Show agent work awaiting approval.',
    arguments: { action: 'list', limit: 5 },
    sample_response: { decisions: [{ id: 'decision_123', status: 'pending' }] },
  },
  delegate_agent_task: {
    prompt: 'Delegate this launch task to an agent.',
    arguments: { agent: 'marketing-agent', task: 'Draft the launch email.' },
    sample_response: { run_id: 'run_123', status: 'queued' },
  },
  track_project_progress: {
    prompt: 'Track progress for this project.',
    arguments: { initiative_id: 'initiative_123' },
    sample_response: { health: 'on_track', progress: 62 },
  },
  review_artifact: {
    prompt: 'Review the next artifact awaiting approval.',
    arguments: { workspace_id: 'workspace_123' },
    sample_response: { artifact: { id: 'artifact_123', status: 'in_review' } },
  },
  get_morning_brief: {
    prompt: 'Show today’s OrgX morning brief.',
    arguments: { workspace_id: 'workspace_123' },
    sample_response: { brief: { receipts: [], exceptions: [] } },
  },
  get_operator_chronicle: {
    prompt:
      'Show the operator chronicle for the last 30 days so I can verify decisions, artifacts, PRs, velocity, goals, and gaps.',
    arguments: { period: '30d' },
    sample_response: {
      reportingNarrative: {
        briefMarkdown:
          '2 decisions recorded, 3 proof artifacts attached, and 1 launch gap remains open.',
      },
      topPriorities: [{ title: 'Close launch proof gap', status: 'review' }],
      prVelocity: { merged: 4, open: 1 },
      gaps: [{ title: 'Missing final proof receipt', severity: 'medium' }],
    },
  },
  consolidate_pr: {
    prompt:
      'Create a durable consolidation_pass receipt for this pull request.',
    arguments: {
      pr_url: 'https://github.com/useorgx/example/pull/42',
      initiative_id: '00000000-0000-4000-8000-000000000000',
      reviewer_note: 'Focus on duplication and dead code before approval.',
    },
    sample_response: {
      artifact_id: 'artifact_123',
      artifact_type: 'orchestration.consolidation_pass',
      verdict: 'ship',
      aq_score: 0.91,
    },
  },
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
      'These are example payloads only. Connect https://mcp.useorgx.com/mcp with OAuth to execute real OrgX tools.',
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
      'workspace action=get',
      'get_org_snapshot view=summary',
      'recall_memory query="recent decisions" scope=decisions',
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
