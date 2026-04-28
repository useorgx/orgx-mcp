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

const PRIMARY_AUTHENTICATED_TOOLS = [
  'remember_decision',
  'recall_memory',
  'approve_agent_work',
  'delegate_agent_task',
  'track_project_progress',
  'query_org_memory',
  'get_pending_decisions',
  'get_agent_status',
  'get_initiative_pulse',
  'scaffold_initiative',
] as const;

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
  remember_decision: {
    prompt:
      'Remember this decision for the team: we are moving onboarding analytics to PostHog.',
    arguments: {
      decision: 'Move onboarding analytics to PostHog',
      context: 'Chosen for funnel visibility and product-led activation reporting.',
    },
    sample_response: {
      saved: true,
      type: 'decision',
      recall_hint: 'Ask "what did we decide about onboarding analytics?"',
    },
  },
  recall_memory: {
    prompt: 'What did we decide about billing?',
    arguments: {
      query: 'billing decisions',
      scope: 'decisions',
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
  approve_agent_work: {
    prompt: 'Show me agent work waiting for approval.',
    arguments: {
      action: 'list',
    },
    sample_response: {
      pending: [
        {
          id: 'D-123',
          title: 'Approve launch checklist',
          requires_confirmation: true,
        },
      ],
    },
  },
  delegate_agent_task: {
    prompt: 'Assign this research task to an engineering agent.',
    arguments: {
      agent: 'engineering-agent',
      task: 'Scope the implementation options for the onboarding analytics migration.',
    },
    sample_response: {
      delegated: true,
      agent: 'engineering-agent',
      status: 'queued',
    },
  },
  track_project_progress: {
    prompt: 'What is blocked on the Growth Launch initiative?',
    arguments: {
      initiative: 'Growth Launch',
    },
    sample_response: {
      health: 'at_risk',
      blockers: ['Analytics decision awaiting approval'],
      next_action: 'Review pending decision D-123',
    },
  },
  query_org_memory: {
    prompt: 'Find the launch plan artifact.',
    arguments: {
      query: 'launch plan artifact',
      scope: 'artifacts',
    },
    sample_response: {
      results: [{ type: 'artifact', title: 'Launch plan v2' }],
    },
  },
  get_pending_decisions: {
    prompt: 'What needs my approval?',
    arguments: {
      limit: 5,
    },
    sample_response: {
      decisions: [{ id: 'D-123', title: 'Approve launch checklist' }],
    },
  },
  get_agent_status: {
    prompt: 'What are my agents working on?',
    arguments: {
      include_idle: false,
    },
    sample_response: {
      running_agents: [{ agent: 'engineering-agent', focus: 'Billing migration' }],
    },
  },
  get_initiative_pulse: {
    prompt: 'Show the pulse for the onboarding initiative.',
    arguments: {
      initiative_id: 'init_123',
    },
    sample_response: {
      health: 'green',
      milestones: { complete: 3, total: 5 },
    },
  },
  scaffold_initiative: {
    prompt: 'Create an initiative to launch the new onboarding flow.',
    arguments: {
      title: 'Launch new onboarding flow',
      summary: 'Plan workstreams, milestones, and tasks for launch readiness.',
    },
    sample_response: {
      created: true,
      hierarchy: ['initiative', 'workstreams', 'milestones', 'tasks'],
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
