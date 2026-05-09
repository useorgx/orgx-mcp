import { z } from 'zod';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  OUTPUT_TEMPLATE_URIS,
  PLAN_SESSION_TOOLS,
  SECURITY_SCHEMES,
  STREAM_TOOL_DEFINITIONS,
  WIDGET_URIS,
  lifecycleEntityTypeEnum,
} from './toolDefinitions';
import { FLYWHEEL_TOOL_DEFINITIONS } from './flywheelTools';

export const V2_ORGX_TOOL_IDS = [
  'orgx_bootstrap',
  'orgx_inspect',
  'orgx_search',
  'orgx_recommend',
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'orgx_emit_activity',
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_submit_receipt',
] as const;

export const V2_ORGX_TOOL_ID_SET = new Set<string>(V2_ORGX_TOOL_IDS);

export const CONTRACT_TOOL_DEFINITIONS = [
  {
    id: 'orgx_bootstrap',
    title: 'Bootstrap OrgX Contract',
    description:
      'Establish OrgX session context, discover granted scopes, and get the v2 tool routing map. Also known as: bootstrap, setup, tool routing. USE WHEN: first call in a fresh session, after reconnecting, or before performing a multi-step workflow. NEXT: use orgx_search, orgx_inspect, or orgx_recommend based on the returned routing map. DO NOT USE WHEN: you already have session context and need to read or mutate work. Read-only.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Canonical workspace UUID to bind as the active session workspace'),
      conversation_id: z.string().optional().describe('Optional client conversation/session identifier for continuity'),
      client_name: z.string().optional().describe('Optional MCP client name, such as codex, chatgpt, cursor, or claude'),
      timezone: z.string().optional().describe('Optional user timezone for date-sensitive readouts'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Bootstrapping OrgX contract...',
      'openai/toolInvocation/invoked': 'OrgX contract ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_inspect',
    title: 'Inspect OrgX Entity',
    description:
      'Hydrate one OrgX entity with execution context. USE WHEN: the user names a specific task, milestone, initiative, decision, artifact, or plan session and needs details before acting. NEXT: use orgx_act, orgx_attach, or orgx_write if the user asks to change what you inspected. DO NOT USE WHEN: browsing or searching many records; use orgx_search. Read-only.',
    inputSchema: {
      type: z
        .enum(['initiative', 'workstream', 'milestone', 'task', 'decision', 'artifact', 'plan_session'])
        .describe('Entity type to inspect'),
      id: z.string().min(1).describe('Entity UUID or accepted short ID prefix'),
      hydrate_context: z.boolean().optional().describe('Include linked context where available; default true'),
      max_chars: z.number().int().min(1000).max(50000).optional().describe('Approximate maximum hydrated context characters'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Inspecting OrgX entity...',
      'openai/toolInvocation/invoked': 'OrgX entity inspected',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'orgx_search',
    title: 'Search OrgX',
    description:
      'Find OrgX entities, decisions, artifacts, and memory. USE WHEN: browsing work, searching memory, finding IDs, or listing related records. NEXT: use orgx_inspect for one selected result or orgx_recommend when the user asks what to do next. DO NOT USE WHEN: you already know the exact entity and need full context; use orgx_inspect.',
    inputSchema: {
      query: z.string().optional().describe('Search query for memory or title/text matching'),
      type: z.string().optional().describe('Optional entity type filter, such as task, milestone, decision, artifact, or initiative'),
      status: z.string().optional().describe('Optional status filter'),
      initiative_id: z.string().optional().describe('Optional initiative UUID scope'),
      workspace_id: z.string().optional().describe('Optional workspace UUID scope'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return'),
      fields: z.array(z.string()).optional().describe('Optional compact field list'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Searching OrgX...',
      'openai/toolInvocation/invoked': 'OrgX search complete',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'orgx_recommend',
    title: 'Recommend Next OrgX Action',
    description:
      'Recommend next work, summarize morning-brief signals, or read prioritization context. USE WHEN: user asks what to do next, wants a brief, or needs priority guidance. NEXT: present the recommendation, then use orgx_act, orgx_write, or orgx_spawn only after the user confirms an action. DO NOT USE WHEN: the user already specified the action; use orgx_act or orgx_write.',
    inputSchema: {
      mode: z.enum(['next_action', 'morning_brief']).optional().describe('Recommendation mode; default next_action'),
      entity_type: z.enum(['workspace', 'initiative', 'workstream', 'milestone', 'task']).optional().describe('Recommendation scope type'),
      entity_id: z.string().optional().describe('Scoped entity ID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum recommendations'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.morningBrief,
      'openai/toolInvocation/invoking': 'Building OrgX recommendation...',
      'openai/toolInvocation/invoked': 'OrgX recommendation ready',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.morningBrief },
    },
  },
  {
    id: 'orgx_write',
    title: 'Write OrgX Entity',
    description:
      'Create or update durable OrgX records using canonical snake_case fields. USE WHEN: adding or editing a task, milestone, decision, artifact, skill, brand, or content entity. NEXT: use orgx_act when the new or edited record should launch, pause, complete, or validate. DO NOT USE WHEN: changing lifecycle state or attaching proof; use orgx_act or orgx_attach.',
    inputSchema: {
      operation: z.enum(['create', 'update']).optional().describe('Write operation; default create'),
      type: z.string().min(1).describe('Entity type, such as task, milestone, decision, artifact, skill, studio_brand, or studio_content'),
      id: z.string().optional().describe('Entity ID for operation=update'),
      title: z.string().optional().describe('Title/name for created records'),
      name: z.string().optional().describe('Alternative name/title'),
      summary: z.string().optional().describe('Summary'),
      description: z.string().optional().describe('Description'),
      fields: z.record(z.unknown()).optional().describe('Fields to update when operation=update'),
      initiative_id: z.string().optional().describe('Parent initiative UUID'),
      workstream_id: z.string().optional().describe('Parent workstream UUID'),
      milestone_id: z.string().optional().describe('Parent milestone UUID; task parents are auto-resolved server-side where available'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority'),
      due_date: z.string().optional().describe('Due date as YYYY-MM-DD'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata payload'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-generated idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Writing OrgX entity...',
      'openai/toolInvocation/invoked': 'OrgX entity written',
    },
  },
  {
    id: 'orgx_attach',
    title: 'Attach OrgX Artifact',
    description:
      'Attach a durable artifact, proof URL, or preview to an existing OrgX entity. USE WHEN: saving evidence, PRs, documents, reports, screenshots, or external artifacts. NEXT: use orgx_submit_receipt to close attribution/quality loops or orgx_act to complete with proof. DO NOT USE WHEN: creating generic entities; use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type'),
      id: z.string().min(1).describe('Target entity UUID or short ID prefix'),
      name: z.string().min(1).describe('Artifact title'),
      artifact_type: z.string().min(1).describe('Artifact type code, such as eng.diff_pack'),
      artifact_url: z.string().optional().describe('Internal artifact URL'),
      external_url: z.string().optional().describe('External artifact URL'),
      description: z.string().optional().describe('Artifact description'),
      preview_markdown: z.string().optional().describe('Markdown preview'),
      status: z.enum(['draft', 'in_review', 'approved', 'changes_requested', 'superseded', 'archived']).optional().describe('Artifact workflow status'),
      metadata: z.record(z.unknown()).optional().describe('Artifact metadata'),
      idempotency_key: z.string().optional().describe('Strongly recommended client-generated idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Attaching OrgX artifact...',
      'openai/toolInvocation/invoked': 'OrgX artifact attached',
    },
  },
  {
    id: 'orgx_act',
    title: 'Act On OrgX Entity',
    description:
      'Run lifecycle, validation, completion, delete, dry-run, or proof actions on an existing OrgX entity. USE WHEN: launching, pausing, completing, validating, deleting, shipping, or changing entity state. NEXT: use orgx_inspect or orgx_search to verify resulting state, then orgx_submit_receipt for durable proof when needed. DO NOT USE WHEN: creating records; use orgx_write.',
    inputSchema: {
      type: lifecycleEntityTypeEnum.describe('Target entity type'),
      id: z.string().min(1).describe('Target entity UUID or short ID prefix'),
      action: z.string().min(1).describe('Action, such as launch, pause, complete, complete_with_proof, update, delete, validate, ship_batch, or reassign_streams'),
      fields: z.record(z.unknown()).optional().describe('Patch fields for action=update'),
      note: z.string().optional().describe('Optional action note or reason'),
      dry_run: z.boolean().optional().describe('Preview risky actions without mutating where supported'),
      force: z.boolean().optional().describe('Force action where server supports override semantics'),
      spec: z.record(z.unknown()).optional().describe('Spec payload for studio validation'),
      artifact: z.record(z.unknown()).optional().describe('Proof artifact payload for ship_batch or completion flows'),
      verification: z.array(z.string()).optional().describe('Verification evidence for completion flows'),
      quality_score: z.number().min(0).max(5).optional().describe('Quality score for proof flows'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Running OrgX action...',
      'openai/toolInvocation/invoked': 'OrgX action complete',
    },
  },
  {
    id: 'orgx_plan',
    title: 'Manage OrgX Plan Session',
    description:
      'Start, resume, edit, improve, or complete a tracked OrgX planning session. USE WHEN: work is still in planning or should become executable context. NEXT: use orgx_write or orgx_act after the plan is accepted and needs durable execution state. DO NOT USE WHEN: directly scaffolding a full initiative hierarchy; use scaffold_initiative for that compatibility path.',
    inputSchema: {
      action: z.enum(['start', 'resume', 'improve', 'record_edit', 'complete']).describe('Planning action'),
      session_id: z.string().optional().describe('Plan session UUID or orgx://plan_session URI'),
      feature_name: z.string().optional().describe('Feature or plan name for action=start'),
      initial_plan: z.string().optional().describe('Initial plan for action=start'),
      plan_content: z.string().optional().describe('Plan content for improve/complete'),
      edit_summary: z.string().optional().describe('Edit summary for record_edit'),
      attach_to: z.record(z.unknown()).optional().describe('Optional target attachment for completed plans'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.planSessionLive,
      'openai/toolInvocation/invoking': 'Updating OrgX plan...',
      'openai/toolInvocation/invoked': 'OrgX plan updated',
      ui: { resourceUri: WIDGET_URIS.planSessionLive },
    },
  },
  {
    id: 'orgx_spawn',
    title: 'Spawn OrgX Agent Work',
    description:
      'Guard, classify, spawn, or hand off specialist agent work. USE WHEN: explicitly delegating work to an OrgX agent or checking if delegation is allowed. NEXT: use orgx_inspect or orgx_search to monitor the delegated work, then orgx_submit_receipt for proof. DO NOT USE WHEN: only creating a task row; use orgx_write.',
    inputSchema: {
      action: z.enum(['guard', 'spawn', 'handoff', 'classify']).optional().describe('Spawn operation; default spawn'),
      title: z.string().optional().describe('Task title for spawn/handoff'),
      task_id: z.string().optional().describe('Existing task UUID'),
      initiative_id: z.string().optional().describe('Initiative UUID scope'),
      workspace_id: z.string().optional().describe('Workspace UUID scope'),
      agent_type: z.string().optional().describe('Requested agent type/domain'),
      instructions: z.string().optional().describe('Delegation instructions'),
      idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Preparing OrgX agent work...',
      'openai/toolInvocation/invoked': 'OrgX agent work ready',
    },
  },
  {
    id: 'orgx_decide',
    title: 'Manage OrgX Decision',
    description:
      'Create, approve, reject, remember, or list durable OrgX decisions. USE WHEN: capturing judgment, approval, rejection, or pending decision review. NEXT: use orgx_act, orgx_write, or orgx_spawn only after the decision resolves the next action. DO NOT USE WHEN: writing non-decision entities; use orgx_write.',
    inputSchema: {
      action: z.enum(['create', 'remember', 'list_pending', 'approve', 'reject']).describe('Decision operation'),
      decision_id: z.string().optional().describe('Decision UUID for approve/reject'),
      title: z.string().optional().describe('Decision title'),
      decision: z.string().optional().describe('Decision text for remember/create'),
      summary: z.string().optional().describe('Decision summary'),
      context: z.string().optional().describe('Decision context/rationale'),
      reason: z.string().optional().describe('Required rejection reason'),
      note: z.string().optional().describe('Optional approval note'),
      initiative_id: z.string().optional().describe('Optional initiative scope'),
      workspace_id: z.string().optional().describe('Optional workspace scope'),
      idempotency_key: z.string().optional().describe('Strongly recommended idempotency key for writes'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Updating OrgX decision...',
      'openai/toolInvocation/invoked': 'OrgX decision updated',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'orgx_submit_receipt',
    title: 'Submit OrgX Receipt',
    description:
      'Submit durable proof, attribution, quality, or outcome receipt metadata. USE WHEN: closing the loop on agent work with provenance and measurable evidence. NEXT: use orgx_recommend or orgx_search to show the next priority or confirm the updated work graph. DO NOT USE WHEN: merely emitting telemetry; use orgx_emit_activity.',
    inputSchema: {
      workspace_id: z.string().optional().describe('Workspace UUID'),
      entity_type: z.string().optional().describe('Related entity type'),
      entity_id: z.string().optional().describe('Related entity UUID'),
      receipt_type: z.string().min(1).describe('Receipt type, such as proof, outcome, quality, attribution, or learning'),
      summary: z.string().min(1).describe('Receipt summary'),
      evidence: z.record(z.unknown()).optional().describe('Structured evidence payload'),
      artifact_id: z.string().optional().describe('Related artifact UUID'),
      idempotency_key: z.string().optional().describe('Strongly recommended idempotency key for safe retries'),
      session_id: z.string().optional().describe('Optional bootstrap/session identifier'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Submitting OrgX receipt...',
      'openai/toolInvocation/invoked': 'OrgX receipt submitted',
    },
  },
  {
    id: 'orgx_describe_tool',
    title: 'Describe OrgX Tool',
    description:
      'Return the live input contract, auth expectations, and workflow guidance for an OrgX tool. Also known as: tool schema, tool help, contract. USE WHEN: you need exact field names, accepted enums, or next-step guidance before calling a tool. Read-only.',
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
    id: 'remember_decision',
    title: 'Remember Decision',
    description:
      'Save a decision to organizational memory so agents and teammates can recall it later. Also known as: decision log, team memory, agent memory, record decision, remember what we decided.',
    inputSchema: {
      decision: z
        .string()
        .min(1)
        .describe('Decision text or short decision title to remember'),
      context: z
        .string()
        .optional()
        .describe('Optional background, rationale, or source context'),
      title: z
        .string()
        .optional()
        .describe('Optional explicit decision title'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional parent initiative UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority / urgency'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Remembering decision...',
      'openai/toolInvocation/invoked': 'Decision remembered',
    },
  },
  {
    id: 'recall_memory',
    title: 'Recall Memory',
    description:
      'Search organizational memory for prior decisions, artifacts, project context, and team knowledge. Also known as: search memory, recall decisions, find context, retrieve artifacts, what did we decide.',
    inputSchema: {
      query: z.string().min(1).describe('Search query for organizational memory'),
      scope: z
        .enum(['all', 'artifacts', 'decisions', 'initiatives'])
        .optional()
        .describe('Optional scope filter for the memory search'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of results to return'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Recalling organizational memory...',
      'openai/toolInvocation/invoked': 'Memory recalled',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'approve_agent_work',
    title: 'Approve Agent Work',
    description:
      'Review agent decisions or work items awaiting human approval. Also known as: pending approvals, agent blocked, sign off, review decisions, approve AI work.',
    inputSchema: {
      decision_id: z
        .string()
        .optional()
        .describe('Decision ID to approve or reject after user confirmation'),
      action: z
        .enum(['list', 'approve', 'reject'])
        .optional()
        .describe('Use list to review pending approvals, or approve/reject a specific decision_id'),
      note: z.string().optional().describe('Optional approval note'),
      reason: z.string().optional().describe('Required rejection reason'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of pending decisions to return when listing'),
      urgency_filter: z
        .enum(['all', 'critical', 'high'])
        .optional()
        .describe('Optional urgency filter for the pending decision list'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to scope pending decisions'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Reviewing agent approvals...',
      'openai/toolInvocation/invoked': 'Agent approvals reviewed',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'delegate_agent_task',
    title: 'Delegate Agent Task',
    description:
      'Assign work to a specialist AI agent and track the result. Also known as: hand this off, spawn agent, assign task, delegate to agent, have an AI agent do it.',
    inputSchema: {
      agent: z.string().min(1).describe('Target agent identifier or alias'),
      task: z.string().min(1).describe('Task instructions for the target agent'),
      context: z
        .string()
        .optional()
        .describe('Optional supporting context or background for the task'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to associate with the spawned task'),
      initiative_name: z
        .string()
        .optional()
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
      expected_artifacts: z
        .array(z.string())
        .optional()
        .describe('Optional final outputs you expect'),
      deadline: z
        .string()
        .optional()
        .describe('Optional due date or plain-text deadline'),
      style_guidelines: z
        .string()
        .optional()
        .describe('Optional voice, format, or style constraints'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Delegating agent task...',
      'openai/toolInvocation/invoked': 'Agent task delegated',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'track_project_progress',
    title: 'Track Project Progress',
    description:
      'Get health, blockers, milestones, owners, and recent activity for a project or initiative. Also known as: project status, initiative pulse, blockers, roadmap progress, execution health.',
    inputSchema: {
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to check'),
      initiative_name: z
        .string()
        .optional()
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.initiativePulse,
      'openai/toolInvocation/invoking': 'Tracking project progress...',
      'openai/toolInvocation/invoked': 'Project progress retrieved',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.initiativePulse },
    },
  },
  {
    id: 'resume_plan_session',
    title: 'Resume Plan Session',
    description:
      'Resume a planning session by UUID, orgx:// URI, or most recent active session. Also known as: continue plan, reload planning context. USE WHEN: continuing a planning workflow without guessing IDs.',
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
      'Create an actionable task in organizational memory for a project, milestone, or agent. Also known as: add task, create work item. USE WHEN: adding a single actionable task to a workstream, milestone, or initiative. NEXT: use entity_action action=start when execution should begin.',
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
      proof_profile: z
        .enum(['full', 'subcomponent', 'release', 'external_artifact'])
        .optional()
        .describe(
          'Proof-chain profile. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
        ),
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
      'Create a project milestone or phase checkpoint with durable context. Also known as: add milestone, create checkpoint. USE WHEN: adding a phase checkpoint under an initiative or workstream.',
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
      proof_profile: z
        .enum(['full', 'subcomponent', 'release', 'external_artifact'])
        .optional()
        .describe(
          'Proof-chain profile. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
        ),
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
      'Record a decision in organizational memory so agents can recall it later. Also known as: remember decision, decision log, team memory. USE WHEN: surfacing a new approval or judgment point for a workspace or initiative.',
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
      'Inline worker tool for loading a task with hydrated decisions, artifacts, entities, and plan-session context.',
  },
  workspace: {
    id: 'workspace',
    title: 'Workspace',
    description:
      'Inline worker tool for creating, listing, reading, and switching workspace context.',
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
    | 'flywheel'
    | 'contract'
    | 'inline';
};

export function getKnownToolContracts(): KnownToolContract[] {
  const liftInputSchema = (
    inputSchema: unknown
  ): Record<string, z.ZodTypeAny> | undefined => {
    if (!inputSchema) return undefined;
    if (inputSchema instanceof z.ZodObject) {
      return inputSchema.shape as Record<string, z.ZodTypeAny>;
    }
    return inputSchema as Record<string, z.ZodTypeAny>;
  };

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
    inputSchema: liftInputSchema(tool.inputSchema),
    source,
  });

  const typedContracts: KnownToolContract[] = [
    ...CHATGPT_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'chatgpt')),
    ...PLAN_SESSION_TOOLS.map((tool) => liftContract(tool, 'plan_session')),
    ...CLIENT_INTEGRATION_TOOL_DEFINITIONS.map((tool) =>
      liftContract(tool, 'client_integration')
    ),
    ...STREAM_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'stream')),
    ...FLYWHEEL_TOOL_DEFINITIONS.map((tool) => liftContract(tool, 'flywheel')),
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
