import { z } from 'zod';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  SECURITY_SCHEMES,
  STREAM_TOOL_DEFINITIONS,
  lifecycleEntityTypeEnum,
} from './toolDefinitions';

export const CONTRACT_TOOL_DEFINITIONS = [
  {
    id: 'orgx_bootstrap',
    title: 'Bootstrap OrgX Contract',
    description:
      'Discover current profile, workspace scope, granted scopes, safe first calls, canonical ID forms, and recommended workflows. USE WHEN: first call in a fresh session, after reconnecting, or before performing a multi-step workflow. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Bootstrapping OrgX contract...',
      'openai/toolInvocation/invoked': 'OrgX contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_describe_tool',
    title: 'Describe OrgX Tool',
    description:
      'Return the live input contract, auth expectations, and workflow guidance for a tool. USE WHEN: you need exact field names, accepted enums, or next-step guidance before calling a tool. Read-only.',
    inputSchema: {
      tool_id: z.string().min(1).describe('Tool ID to inspect'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Describing tool contract...',
      'openai/toolInvocation/invoked': 'Tool contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_describe_action',
    title: 'Describe Entity Action',
    description:
      'Describe lifecycle actions, aliases, and special payload requirements for entity_action. USE WHEN: you need the exact action name or payload shape before calling entity_action. Read-only.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Entity type'),
      action: z.string().optional().describe('Specific action to inspect'),
      id: z
        .string()
        .optional()
        .describe('Optional entity ID to fetch currently available actions'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Describing entity action...',
      'openai/toolInvocation/invoked': 'Entity action contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'resume_plan_session',
    title: 'Resume Plan Session',
    description:
      'Load a plan session using the canonical UUID or OrgX URI returned by OrgX tools. If no session_id is provided, returns the most recent active session. USE WHEN: continuing a planning workflow without guessing IDs.',
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe('Plan session UUID or orgx://plan_session/<uuid>'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.authRequired,
    _meta: {
      'openai/toolInvocation/invoking': 'Loading plan session...',
      'openai/toolInvocation/invoked': 'Plan session loaded',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'create_task',
    title: 'Create Task',
    description:
      'Create a task without using the generic create_entity surface. USE WHEN: adding a single actionable task to a workstream, milestone, or initiative. NEXT: use entity_action action=start when execution should begin.',
    inputSchema: {
      title: z.string().min(1).describe('Task title'),
      summary: z.string().optional().describe('Task summary'),
      description: z.string().optional().describe('Task description'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      workstream_id: z.string().optional().describe('Parent workstream UUID'),
      milestone_id: z.string().optional().describe('Parent milestone UUID'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority'),
      sequence: z.number().int().min(0).optional().describe('Execution order'),
      domain: z.string().optional().describe('Planning domain'),
      depends_on: z.array(z.string()).optional().describe('Dependency IDs'),
      assigned_agent_ids: z
        .array(z.string())
        .optional()
        .describe('Explicit assignee IDs'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating task...',
      'openai/toolInvocation/invoked': 'Task created',
    },
  },
  {
    id: 'create_milestone',
    title: 'Create Milestone',
    description:
      'Create a milestone without using the generic create_entity surface. USE WHEN: adding a phase checkpoint under an initiative or workstream.',
    inputSchema: {
      title: z.string().min(1).describe('Milestone title'),
      summary: z.string().optional().describe('Milestone summary'),
      description: z.string().optional().describe('Milestone description'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      workstream_id: z.string().optional().describe('Parent workstream UUID'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority'),
      sequence: z.number().int().min(0).optional().describe('Execution order'),
      domain: z.string().optional().describe('Planning domain'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating milestone...',
      'openai/toolInvocation/invoked': 'Milestone created',
    },
  },
  {
    id: 'create_decision',
    title: 'Create Decision',
    description:
      'Create a decision without using generic power tools. USE WHEN: surfacing a new approval or judgment point for a workspace or initiative.',
    inputSchema: {
      title: z.string().min(1).describe('Decision title'),
      summary: z.string().optional().describe('Decision summary'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority / urgency'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      owner_id: z.string().optional().describe('Explicit owner ID'),
      user_id: z.string().optional().describe('Deprecated alias for owner_id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Creating decision...',
      'openai/toolInvocation/invoked': 'Decision created',
    },
  },
  {
    id: 'validate_studio_content',
    title: 'Validate Studio Content',
    description:
      'Validate a studio_content entity without composing entity_action manually. USE WHEN: checking a studio content spec before rendering or publication.',
    inputSchema: {
      id: z.string().uuid().describe('studio_content entity UUID'),
      spec: z
        .record(z.unknown())
        .optional()
        .describe('Spec payload to validate'),
      note: z.string().optional().describe('Optional validation note'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Validating studio content...',
      'openai/toolInvocation/invoked': 'Studio content validated',
    },
  },
  {
    id: 'pin_workstream',
    title: 'Pin Workstream',
    description:
      'Pin a workstream to the top of the Next Up queue without composing queue_action manually. USE WHEN: forcing a workstream to the top of the recommendation queue.',
    inputSchema: {
      initiative_id: z.string().min(1).describe('Initiative UUID'),
      workstream_id: z.string().min(1).describe('Workstream UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id'),
      rank: z.number().optional().describe('Pinned order, 0 = top'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Pinning workstream...',
      'openai/toolInvocation/invoked': 'Workstream pinned',
    },
  },
] as const;

export const INLINE_TOOL_CONTRACTS = {
  list_entities: {
    id: 'list_entities',
    title: 'List Entities',
    description:
      'Inline worker tool for listing OrgX entities with filtering, pagination, and optional hydration.',
  },
  create_entity: {
    id: 'create_entity',
    title: 'Create Entity',
    description:
      'Inline worker power tool for creating any entity type. Prefer create_task, create_milestone, or create_decision for common flows.',
  },
  update_entity: {
    id: 'update_entity',
    title: 'Update Entity',
    description:
      'Inline worker tool for updating mutable fields on an existing entity.',
  },
  entity_action: {
    id: 'entity_action',
    title: 'Entity Action',
    description:
      'Inline worker tool for lifecycle actions, attachments, and specialized operations like studio validation.',
  },
  scaffold_initiative: {
    id: 'scaffold_initiative',
    title: 'Scaffold Initiative',
    description:
      'Inline worker tool for creating a full initiative hierarchy in one call.',
  },
  get_task_with_context: {
    id: 'get_task_with_context',
    title: 'Get Task With Context',
    description:
      'Inline worker tool for loading a task with hydrated context attachments.',
  },
  workspace: {
    id: 'workspace',
    title: 'Workspace',
    description:
      'Inline worker tool for listing, reading, and switching workspace context.',
  },
  configure_org: {
    id: 'configure_org',
    title: 'Configure Organization',
    description:
      'Inline worker tool for setup status, agent config, and organization policy changes.',
  },
  stats: {
    id: 'stats',
    title: 'Stats',
    description:
      'Inline worker tool for personal or session usage statistics.',
  },
} as const;

export type KnownToolContract = {
  id: string;
  title: string;
  description: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
  securitySchemes?: readonly { type: string; scopes?: readonly string[] }[];
  annotations?: Record<string, boolean>;
  _meta?: Record<string, unknown>;
  source:
    | 'chatgpt'
    | 'plan_session'
    | 'client_integration'
    | 'stream'
    | 'contract'
    | 'inline';
};

export function getKnownToolContracts(): KnownToolContract[] {
  const liftContract = (
    tool: {
      id: string;
      title: string;
      description: string;
      inputSchema?: unknown;
      securitySchemes?: readonly { type: string; scopes?: readonly string[] }[];
      annotations?: Record<string, boolean>;
      _meta?: Record<string, unknown>;
    },
    source: KnownToolContract['source']
  ): KnownToolContract => ({
    ...tool,
    inputSchema: tool.inputSchema as Record<string, z.ZodTypeAny> | undefined,
    source,
  });

  const typedContracts: KnownToolContract[] = [
    ...CHATGPT_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'chatgpt')),
    ...PLAN_SESSION_TOOLS.map((tool) => liftContract(tool, 'plan_session')),
    ...CLIENT_INTEGRATION_TOOL_DEFINITIONS.map((tool) =>
      liftContract(tool, 'client_integration')
    ),
    ...STREAM_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'stream')),
    ...CONTRACT_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'contract')),
  ];

  const inlineContracts: KnownToolContract[] = Object.values(INLINE_TOOL_CONTRACTS).map(
    (tool) => ({
      ...tool,
      source: 'inline' as const,
    })
  );

  return [...typedContracts, ...inlineContracts];
}

export function getKnownToolContract(toolId: string): KnownToolContract | null {
  return getKnownToolContracts().find((tool) => tool.id === toolId) ?? null;
}
