import { z } from 'zod';
import { modalityProofInputSchema } from './modalityProofInput';

import {
  getKnownToolContract,
  resolveContractToolInvocationSecuritySchemes,
  type ToolSecuritySchemes,
} from './contractTools';
import { SECURITY_SCHEMES, SCAFFOLD_INITIATIVE_WIDGET_META, OUTPUT_TEMPLATE_URIS, WIDGET_URIS } from './toolDefinitions';
import { jsonValueSchema } from './openaiOutputSchemas/shared';

/** A public operation is bound to one implementation, never a caller-selected verb. */
export interface WorkflowBackendRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface WorkflowToolAdapter {
  id: string;
  canonicalToolId: string;
  outputSchemaToolId: string;
  executionKind: 'contract' | 'chatgpt' | 'stream' | 'scaffold' | 'client';
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  };
  securitySchemes: ToolSecuritySchemes;
  _meta: Record<string, unknown>;
  toCanonicalArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  backendRequest?: (args: Record<string, unknown>) => WorkflowBackendRequest;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const appendOnly = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const modifiesRecords = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const dispatchesWork = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const id = z.string().trim().min(1);
const workspaceId = z.string().uuid().optional().describe('Workspace UUID. Defaults to the authenticated session workspace when unambiguous.');
const retryKey = z.string().trim().min(1).max(200).optional().describe('Stable retry key for this request. Reuse it only with identical input.');
const workType = z.enum(['initiative', 'workstream', 'milestone', 'task']);
const planSessionId = z.string().trim().regex(/^(?:orgx:\/\/plan_session\/)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
  .describe('Plan session UUID or orgx://plan_session/<uuid> URI.');
const planMarkdown = z.string().min(1).max(200_000).refine((value) => Boolean(value.trim()), 'Plan markdown must contain text.');
const planVersion = z.number().int().positive().max(2_147_483_646)
  .describe('Authoritative plan_ref.version from the most recent read. Required to prevent overwriting another edit.');
const planAttachment = z.object({
  entity_type: workType,
  entity_id: z.string().uuid(),
  section: z.string().trim().min(1).max(500).optional(),
  label: z.string().trim().min(1).max(500).optional(),
  relevance: z.string().trim().min(1).max(4000).optional(),
}).strict();

function canonical(id: string) {
  const tool = getKnownToolContract(id);
  if (!tool?.inputSchema) throw new Error(`Missing workflow operation contract: ${id}`);
  return tool;
}

/** Reuse validators, with operation-specific descriptions and required inputs. */
function project(
  canonicalId: string,
  fields: readonly string[],
  overrides: Record<string, z.ZodTypeAny> = {}
): Record<string, z.ZodTypeAny> {
  const shape = canonical(canonicalId).inputSchema!;
  const descriptions: Record<string, string> = {
    workspace_id: workspaceId.description!,
    task_id: 'Existing task UUID.',
    initiative_id: 'Initiative UUID used as the parent or scope for this operation.',
    workstream_id: 'Parent workstream UUID.',
    milestone_id: 'Parent milestone UUID. Required when workspace backlog policy requires an explicit milestone.',
    goal_ids: 'Objective UUIDs. Required when workspace policy enforces primary objectives.',
    agent_type: 'Specialist domain, such as engineering, design, sales, marketing, or operations.',
    instructions: 'Delegation instructions. When supplied for existing work, overrides its description for this request.',
    due_date: 'Due date in YYYY-MM-DD form for this supported work type.',
    idempotency_key: retryKey.description!,
    session_id: canonicalId === 'orgx_plan' ? 'Plan session UUID or orgx://plan_session/<uuid> URI.' : 'Optional OrgX conversation-session context.',
    reason: 'Rationale required by the compatibility rejection-review gate. This opener does not persist or submit it.',
  };
  return Object.fromEntries(fields.map((field) => {
    const schema = overrides[field] ?? shape[field];
    if (!schema) throw new Error(`Missing ${canonicalId} input: ${field}`);
    const description = overrides[field]?.description ?? descriptions[field]
      ?? schema.description?.replace(/REQUIRED (?:when|for)[^.]+\./g, '').replace(/(?:orgx_[a-z_]+|list_entities|scaffold_initiative)/g, 'OrgX');
    return [field, description ? schema.describe(description.trim()) : schema];
  }));
}

type AdapterOptions = Partial<Pick<WorkflowToolAdapter, 'annotations' | 'securitySchemes' | 'executionKind' | 'outputSchemaToolId' | 'backendRequest'>> & {
  fixedArgs?: Record<string, unknown>;
  transformArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
};

function operation(
  id: string,
  canonicalToolId: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  options: AdapterOptions = {}
): WorkflowToolAdapter {
  const source = canonical(canonicalToolId);
  const annotations = options.annotations ?? source.annotations ?? appendOnly;
  const fields = new Set([...Object.keys(inputSchema), '_context']);
  const toCanonicalArgs = (args: Record<string, unknown>) => {
    // Even direct internal invocations cannot smuggle a different discriminator,
    // a force override, approval status, or an identity through a wrapper.
    const declared = Object.fromEntries(Object.entries(args).filter(([key]) => fields.has(key)));
    return { ...(options.transformArgs?.(declared) ?? declared), ...options.fixedArgs };
  };
  return {
    id, canonicalToolId, title, description, inputSchema,
    outputSchemaToolId: options.outputSchemaToolId ?? canonicalToolId,
    executionKind: options.executionKind ?? 'contract',
    annotations: annotations as WorkflowToolAdapter['annotations'],
    securitySchemes: options.securitySchemes ?? source.securitySchemes ?? SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      ...source._meta,
      ...(canonicalToolId === 'scaffold_initiative' ? SCAFFOLD_INITIATIVE_WIDGET_META : {}),
      ...(canonicalToolId === 'review_artifact' ? {
        'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.artifactReview,
        ui: { resourceUri: WIDGET_URIS.artifactReview },
      } : {}),
      'openai/readOnlyHint': annotations.readOnlyHint,
      // Router-specific invocation text can describe a different effect, such
      // as bootstrapping a session for the read-only context operation.
      'openai/toolInvocation/invoking': `${title}...`,
      'openai/toolInvocation/invoked': `${title} finished`,
    },
    toCanonicalArgs,
    ...(options.backendRequest ? { backendRequest: (args: Record<string, unknown>) => options.backendRequest!(toCanonicalArgs(args)) } : {}),
  };
}

function query(path: string, args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (key !== '_context' && value !== undefined && value !== null) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function bodyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { _context, idempotency_key, ...body } = args;
  return body;
}

function retryHeaders(args: Record<string, unknown>): Record<string, string> | undefined {
  return typeof args.idempotency_key === 'string' ? { 'Idempotency-Key': args.idempotency_key } : undefined;
}

const contentMetadataSchema = z.object({
  notes: z.string().max(8000).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
}).strict();

export const WORK_CONTENT_PATCH_SCHEMA = z.object({
  title: z.string().min(1).max(240).optional(),
  name: z.string().min(1).max(240).optional(),
  summary: z.string().max(4000).optional(),
  description: z.string().max(20000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  goal_ids: z.array(z.string().uuid()).optional(),
  metadata: contentMetadataSchema.optional(),
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined), 'A nonempty content patch is required.');

const proofArtifactFields = {
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(4000).optional(),
  artifact_type: z.string().trim().min(1).max(120),
  artifact_url: z.string().url().max(2000).optional(),
  external_url: z.string().url().max(2000).optional(),
  preview_markdown: z.string().max(25_000).optional(),
};
const proofArtifactSchema = z.object(proofArtifactFields).strict().refine((value) => Boolean(value.artifact_url || value.external_url), 'A durable artifact_url or external_url is required.');
const completionProofArtifactSchema = z.object({
  ...proofArtifactFields,
  artifact_hash: z.string().trim().min(1).max(240).optional(),
  atomic_unit_type: z.string().trim().min(1).max(120).optional(),
  modality_proof: modalityProofInputSchema.optional().describe('Versioned execution or render evidence for the new artifact. Does not assert an independent evaluation or human acceptance.'),
}).strict().refine((value) => Boolean(value.artifact_url || value.external_url), 'A durable artifact_url or external_url is required.');

const estimateFields = {
  expected_tokens: z.number().int().positive().max(1_000_000).optional(),
  expected_duration_hours: z.number().positive().max(300).optional(),
  expected_budget_usd: z.number().positive().max(1_000_000).optional(),
};
const planTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  detail: z.string().max(4000).nullable().optional(),
  type: z.enum(['research', 'create', 'review', 'implement']).optional(),
  depends_on: z.array(z.string().min(1).max(240)).max(15).optional(),
  agent_id: z.string().min(1).max(120).optional(),
  ...estimateFields,
}).strict();
const planMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4000).nullable().optional(),
  tasks: z.array(planTaskSchema).max(15).optional(),
}).strict();
const planWorkstreamSchema = z.object({
  name: z.string().trim().min(1).max(240),
  goal: z.string().max(4000).nullable().optional(),
  domain: z.enum(['product', 'engineering', 'marketing', 'sales', 'operations', 'design', 'orchestration']).optional(),
  agent_id: z.string().min(1).max(120).optional(),
  agent_name: z.string().min(1).max(120).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().max(2000).optional(),
  depends_on: z.array(z.string().min(1).max(240)).max(20).optional(),
  deliverables: z.array(z.string().min(1).max(500)).max(20).optional(),
  ...estimateFields,
  milestones: z.array(planMilestoneSchema).max(10).optional(),
}).strict();

/** Portable projection of the existing OrgX atomic scaffold vocabulary. */
export const INITIATIVE_PLAN_SCHEMA = z.object({
  initiative: z.object({ title: z.string().trim().min(1).max(240), summary: z.string().max(4000).nullable().optional() }).strict(),
  workstreams: z.array(planWorkstreamSchema).min(1).max(20),
}).strict();

const sourceEvidenceSchema = z.object({
  target_url: z.string().url(),
  verification_state: z.enum(['verified', 'partial', 'unverified']),
  evidence_urls: z.array(z.string().url()),
  notes: z.string().optional(),
}).strict();

const hierarchyInput = {
  workspace_id: workspaceId,
  plan: INITIATIVE_PLAN_SCHEMA.describe('Deterministic initiative hierarchy. Dependencies reference task titles or workstream names supported by OrgX.'),
  source_evidence: sourceEvidenceSchema.optional(),
};
const commonCreateFields = ['title', 'summary', 'description', 'workspace_id', 'goal_ids', 'priority', 'metadata', 'idempotency_key', 'session_id'] as const;
const createTitle = z.string().trim().min(1).max(240).describe('Display title for the new work record.');
const createOverrides = { title: createTitle, metadata: contentMetadataSchema.optional() };
const spawnShape = canonical('orgx_spawn').inputSchema!;
const dispatchFields = Object.keys(spawnShape).filter((field) => field !== 'action' && field !== 'title');
const workActionFields = ['type', 'id', 'note', 'idempotency_key', 'session_id'] as const;

// The legacy batch path remains explicit until all richer hierarchy material
// has parity in the atomic OrgX scaffold command. It never selects a mode.
const legacyNodeFields = {
  title: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  ref: id.optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  domain: z.string().optional(),
  persona: z.string().optional(),
  assigned_agent_ids: z.array(id).optional(),
  assigned_agent_names: z.array(id).optional(),
  goal_ids: z.array(z.string().uuid()).optional(),
  objective_ids: z.array(z.string().uuid()).optional(),
  depends_on: z.array(id).optional(),
  due_date: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  sequence: z.number().int().nonnegative().optional(),
  expected_tokens: z.number().int().positive().optional(),
  expected_duration_hours: z.number().positive().optional(),
  expected_budget_usd: z.number().nonnegative().optional(),
  proof_profile: z.enum(['full', 'subcomponent', 'release', 'external_artifact']).optional(),
  metadata: contentMetadataSchema.optional(),
};
const hasLegacyLabel = (value: { title?: string; name?: string }) => Boolean(value.title || value.name);
const legacyTaskSchema = z.object({
  ...legacyNodeFields,
  task_type: z.enum(['research', 'create', 'review', 'implement']).optional(),
}).strict().refine(hasLegacyLabel, 'A task title or name is required.');
const legacyMilestoneSchema = z.object({
  ...legacyNodeFields, tasks: z.array(legacyTaskSchema).optional(),
}).strict().refine(hasLegacyLabel, 'A milestone title or name is required.');
const legacyWorkstreamSchema = z.object({
  ...legacyNodeFields, milestones: z.array(legacyMilestoneSchema).optional(),
}).strict().refine(hasLegacyLabel, 'A workstream title or name is required.');
const legacyScaffoldInput = {
  title: createTitle,
  summary: z.string().optional(),
  description: z.string().optional(),
  workspace_id: workspaceId,
  goal_ids: z.array(z.string().uuid()).optional(),
  objective_ids: z.array(z.string().uuid()).optional(),
  workstreams: z.array(legacyWorkstreamSchema).optional(),
  source_evidence: sourceEvidenceSchema.optional(),
  context: z.array(z.object({
    entity_type: z.string().min(1), entity_id: id, section: z.string().optional(), label: z.string().optional(), relevance: z.string().optional(),
  }).strict()).optional(),
  coordination_dependency: z.object({ name: id, fromWorkstreamName: id, toWorkstreamName: id }).strict().optional(),
  owner_id: id.optional(),
  idempotency_key: retryKey,
  continue_on_error: z.boolean().optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  external_sync: z.object({ targets: z.array(z.enum(['linear', 'jira'])).min(1), mode: z.enum(['project_and_tasks', 'tasks_only']).optional(), linear_project_id: id.optional() }).strict().optional(),
};

/** Default host-independent workflow catalog, excluding receipt tools (receiptTools.ts). */
export const WORKFLOW_TOOL_ADAPTERS: readonly WorkflowToolAdapter[] = [
  operation('orgx_get_workspace_context', 'orgx_bootstrap', 'Read OrgX Workspace Context',
    'Read the authorized workspace, optional initiative context, and typed references. Does not select a workspace or create a session.',
    { workspace_id: workspaceId, initiative_id: id.optional() }, {
      annotations: readOnly, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
      backendRequest: (args) => ({ method: 'GET', path: query('/api/v1/workflows/workspace-context', args) }),
    }),
  operation('orgx_search', 'orgx_search', 'Search OrgX',
    'Search authorized OrgX work, decisions, artifacts, memory, and plan sessions using typed filters and optional text. Mixed relevance searches record metered MCP allowance usage without changing work records. Follow next_call for pagination. Full context is available through orgx_inspect, priorities through orgx_get_next_actions, and receipt ledger searches through orgx_list_work_receipts.',
    project('orgx_search', ['created_from', 'created_to', 'query', 'type', 'status', 'initiative_id', 'workspace_id', 'limit', 'offset', 'cursor', 'fields', 'session_id']),
    { fixedArgs: { scope: 'entities' } }),
  operation('orgx_inspect', 'orgx_inspect', 'Inspect OrgX Work',
    'Read the current state and linked context of one OrgX work record, decision, artifact, or plan session before acting. Returns its owners, decisions, acceptance checks, and proof where available. Related records are available through orgx_search and priorities through orgx_get_next_actions. Does not mutate the record.',
    canonical('orgx_inspect').inputSchema!),
  operation('orgx_get_operator_brief', 'get_operator_chronicle', 'Read OrgX Operator Brief',
    'Read workspace reporting, decision chronology, progress, proof, priorities, and gaps for a day, week, or 30-day window.',
    project('get_operator_chronicle', ['workspace_id', 'period']), {
      executionKind: 'client', annotations: readOnly,
    }),
  operation('orgx_get_next_actions', 'orgx_recommend', 'Get OrgX Next Actions',
    'Read actionable priorities and blockers for the selected work scope. The compatibility implementation records metered MCP allowance usage without changing work records.',
    project('orgx_recommend', ['entity_type', 'entity_id', 'initiative_id', 'workspace_id', 'limit', 'session_id']), { fixedArgs: { mode: 'next_action' } }),
  operation('orgx_get_agent_status', 'get_agent_status', 'Read OrgX Agent Status',
    'Read active and optionally idle agents in the workspace or initiative. Successful calls record metered MCP allowance usage without changing work records.',
    project('get_agent_status', ['agent_id', 'workspace_id', 'initiative_id', 'include_idle']), { executionKind: 'chatgpt' }),
  operation('orgx_get_initiative_progress', 'get_initiative_pulse', 'Read OrgX Initiative Progress',
    'Read hierarchy progress, health, blockers, and review gates for one initiative. Successful calls record metered MCP allowance usage without changing work records.',
    project('get_initiative_pulse', ['initiative_id'], { initiative_id: id.describe('Initiative UUID.') }), { executionKind: 'chatgpt' }),
  operation('orgx_get_operation_status', 'orgx_command_status', 'Read OrgX Operation Status',
    'Read a durable work command, run, or decision. Prefer operation_id returned by a prior operation; compatibility callers can supply kind and id together. Never starts or settles work.',
    { operation_id: id.optional(), kind: z.enum(['decision', 'run', 'command']).optional(), id: z.string().uuid().optional() }, {
      executionKind: 'chatgpt', annotations: readOnly, securitySchemes: SECURITY_SCHEMES.anyReadRequiresAuth,
      transformArgs: (args) => {
        if (typeof args.operation_id !== 'string') return args;
        const match = /^(decision|run|command):(.+)$/.exec(args.operation_id);
        return match ? { ...args, kind: match[1], id: match[2] } : args;
      },
    }),
  operation('orgx_check_execution_readiness', 'check_execution_readiness', 'Check OrgX Execution Readiness',
    'Read whether the authorized workspace has execution credentials and configuration before dispatching agent work. Never dispatches a run.',
    { workspace_id: workspaceId }, { executionKind: 'client', annotations: readOnly }),
  operation('orgx_start_plan', 'orgx_plan', 'Start OrgX Plan',
    'Create a durable planning draft with a title and optional initial markdown. An optional retry key replays the same unedited draft; conflicting content or a draft edited since creation returns a conflict. Does not create executable work or dispatch agents.',
    { title: createTitle, initial_plan: z.string().max(200_000).optional(), workspace_id: workspaceId, idempotency_key: retryKey }, {
      annotations: { ...appendOnly, idempotentHint: false }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
      backendRequest: (args) => ({ method: 'POST', path: '/api/v1/workflows/save-plan', body: {
        title: args.title, plan: args.initial_plan ?? '', ...(args.workspace_id ? { workspace_id: args.workspace_id } : {}),
      }, headers: retryHeaders(args) }),
    }),
  operation('orgx_read_plan', 'orgx_plan', 'Read OrgX Plan',
    'Read a planning draft by session UUID or plan URI. If omitted, read the most recent active plan in the authenticated workspace.',
    { session_id: planSessionId.optional(), workspace_id: workspaceId }, {
      annotations: readOnly, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
      backendRequest: (args) => ({ method: 'GET', path: query('/api/v1/workflows/read-plan', args) }),
    }),
  operation('orgx_save_plan', 'orgx_plan', 'Save OrgX Plan',
    'Save the full markdown draft in OrgX only if the required expected revision is current. Optionally record an edit summary. Does not complete planning or dispatch work.',
    { session_id: planSessionId, plan_content: planMarkdown, title: createTitle.optional(), edit_summary: z.string().trim().min(1).max(4000).optional(), expected_version: planVersion, workspace_id: workspaceId }, {
      annotations: { ...modifiesRecords, idempotentHint: false }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
      backendRequest: (args) => {
        const { plan_content, ...body } = bodyArgs(args);
        return { method: 'POST', path: '/api/v1/workflows/save-plan', body: { ...body, plan: plan_content }, headers: retryHeaders(args) };
      },
    }),
  operation('orgx_complete_plan', 'orgx_plan', 'Complete OrgX Plan',
    'Save final markdown and complete the planning session only if its expected revision is current. Optionally attach the completed plan to typed work targets; attachment failures are reported separately after completion. Does not start execution. After an uncertain response, read the plan before repeating the completion.',
    { session_id: planSessionId, plan_content: planMarkdown, expected_version: planVersion,
      attach_to: z.array(planAttachment).min(1).max(100).optional(), workspace_id: workspaceId }, {
      annotations: { ...modifiesRecords, idempotentHint: false }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
      backendRequest: (args) => ({ method: 'POST', path: '/api/v1/workflows/complete-plan', body: bodyArgs(args) }),
    }),
  operation('orgx_validate_initiative_plan', 'scaffold_initiative', 'Validate OrgX Initiative Plan',
    'Validate a deterministic hierarchy and source evidence in OrgX; return its digest and structural findings. Does not create records, launch agents, or invoke paid generation.',
    hierarchyInput, { executionKind: 'scaffold', annotations: readOnly, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
      backendRequest: (args) => ({ method: 'POST', path: '/api/v1/workflows/validate-initiative-plan', body: bodyArgs(args) }) }),
  operation('orgx_create_initiative_hierarchy', 'scaffold_initiative', 'Create OrgX Initiative Hierarchy',
    'Atomically commit a deterministic initiative hierarchy in OrgX using a stable retry key. Creates work records without launching agents. Visibility defaults to private; source evidence is retained.',
    { ...hierarchyInput, plan_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), idempotency_key: retryKey.unwrap() }, {
      fixedArgs: { visibility: 'private' }, executionKind: 'scaffold', annotations: appendOnly,
      backendRequest: (args) => ({ method: 'POST', path: '/api/v1/workflows/scaffold-initiative', body: bodyArgs(args), headers: retryHeaders(args) }),
    }),
  operation('orgx_create_initiative', 'orgx_write', 'Create OrgX Initiative',
    'Create one initiative in its initial state without launching work or publishing a live link. Supply objectives when workspace policy requires them.',
    project('orgx_write', commonCreateFields, createOverrides), {
      fixedArgs: { operation: 'create', type: 'initiative', live_visibility: 'private' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_create_workstream', 'orgx_write', 'Create OrgX Workstream',
    'Create a workstream under an existing initiative. Does not dispatch agents or start the workstream.',
    project('orgx_write', [...commonCreateFields, 'initiative_id'], { ...createOverrides, initiative_id: id }), {
      fixedArgs: { operation: 'create', type: 'workstream' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_create_milestone', 'orgx_write', 'Create OrgX Milestone',
    'Create a milestone under an existing workstream. Does not start or complete work.',
    project('orgx_write', [...commonCreateFields, 'initiative_id', 'workstream_id', 'due_date'], { ...createOverrides, workstream_id: id }), {
      fixedArgs: { operation: 'create', type: 'milestone' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_create_task', 'orgx_write', 'Create OrgX Task',
    'Create one task under an existing workstream. Supply a milestone when workspace backlog policy requires one. Does not dispatch the task.',
    project('orgx_write', [...commonCreateFields, 'initiative_id', 'workstream_id', 'milestone_id', 'due_date'], { ...createOverrides, workstream_id: id }), {
      fixedArgs: { operation: 'create', type: 'task' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_update_work', 'orgx_write', 'Update OrgX Work Content',
    'Apply a nonempty typed content patch to initiative, workstream, milestone, or task. Permits text, priority, dates, objectives, notes, and tags; cannot change workflow status, approvals, ownership authority, or execution policy.',
    { type: workType, id, fields: WORK_CONTENT_PATCH_SCHEMA, idempotency_key: retryKey, session_id: id.optional() }, {
      fixedArgs: { operation: 'update' }, annotations: modifiesRecords, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_estimate_agent_task', 'orgx_spawn', 'Estimate OrgX Agent Task',
    'Estimate routing and cost for an existing task or a proposed task. Never creates a task, consumes a dispatch allowance, or starts a run.',
    { task: z.union([z.object({ task_id: id }).strict(), z.object({ title: createTitle, instructions: z.string().min(1).optional() }).strict()]),
      ...project('orgx_spawn', ['initiative_id', 'workspace_id', 'agent_type', 'model_tier', 'model', 'provider', 'runtime', 'budget_mode', 'max_cost_usd']) }, {
      fixedArgs: { action: 'estimate' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
      transformArgs: ({ task, ...args }) => ({ ...args, ...(task as Record<string, unknown>) }),
    }),
  operation('orgx_start_agent_task', 'orgx_spawn', 'Start OrgX Agent Task',
    'Dispatch one existing OrgX task under budget, deadline, acceptance, eligibility, and permission policy. Can incur model costs and act on connected services within the declared effect constraints.',
    project('orgx_spawn', dispatchFields, { task_id: id.describe('Existing task UUID to dispatch.') }), {
      fixedArgs: { action: 'spawn' }, annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    }),
  operation('orgx_handoff_task', 'orgx_spawn', 'Hand Off OrgX Task',
    'Reassign an existing task to a specialist through the canonical handoff and dispatch lifecycle. Can incur model costs and connected-service effects; requires agent and initiative write grants.',
    project('orgx_spawn', dispatchFields, { task_id: id, agent_type: id.describe('Specialist domain receiving the task.') }), {
      fixedArgs: { action: 'handoff' }, annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    }),
  operation('orgx_launch_initiative', 'orgx_act', 'Launch OrgX Initiative',
    'Launch an existing initiative after OrgX approval, budget, and readiness checks. May dispatch agents, incur model costs, and interact with connected services.',
    { initiative_id: id.describe('Existing initiative UUID to launch.'), ...project('orgx_act', ['note', 'idempotency_key', 'session_id']) }, {
      fixedArgs: { type: 'initiative', action: 'launch' }, annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
      transformArgs: ({ initiative_id, ...args }) => ({ ...args, id: initiative_id }),
    }),
  ...(['pause', 'resume', 'retry', 'cancel'] as const).map((action) => operation(
    `orgx_${action}_work`, 'manage_lifecycle', `${action[0].toUpperCase()}${action.slice(1)} OrgX Work`,
    action === 'pause' || action === 'cancel'
      ? `${action === 'pause' ? 'Pause' : 'Cancel'} a hierarchy node through OrgX lifecycle control, propagating to descendant work and stopping active runs. Does not mark work complete.`
      : `${action === 'retry' ? 'Retry eligible' : 'Resume paused'} work through canonical OrgX recovery, preserving attempt lineage and redispatching where permitted. Can incur costs and connected-service effects.`,
    project('manage_lifecycle', ['level', 'id']), {
      fixedArgs: { action }, executionKind: 'stream', annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    })),
  operation('orgx_capture_decision', 'orgx_decide', 'Capture OrgX Decision',
    'Capture decision text, rationale, and context for human review. Returns its authoritative review state. Capturing a decision does not approve it or establish an accepted historical judgment.',
    project('orgx_decide', ['decision', 'title', 'summary', 'context', 'initiative_id', 'workspace_id', 'idempotency_key', 'session_id'], { decision: z.string().min(1) }), {
      fixedArgs: { action: 'remember' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    }),
  operation('orgx_list_pending_decisions', 'orgx_decide', 'List Pending OrgX Decisions',
    'Read pending decisions awaiting human review in the selected workspace or initiative. Does not resolve decisions or dispatch work.',
    project('orgx_decide', ['initiative_id', 'workspace_id', 'session_id']), {
      fixedArgs: { action: 'list_pending' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.decisionReadRequiresAuth,
    }),
  operation('orgx_open_decision_review', 'orgx_decide', 'Open OrgX Decision Review',
    'Open the complete human review surface for one pending decision. The person selects the ruling; this operation does not approve, reject, or resume work.',
    { decision_id: id, workspace_id: workspaceId }, {
      annotations: readOnly, securitySchemes: SECURITY_SCHEMES.decisionReadRequiresAuth,
      backendRequest: (args) => ({ method: 'GET', path: query(`/api/v1/workflows/decision-review/${encodeURIComponent(String(args.decision_id))}`, { workspace_id: args.workspace_id, widget_meta: 1 }) }),
    }),
  operation('orgx_attach_artifact', 'orgx_attach', 'Attach OrgX Artifact',
    'Register a named deliverable and provenance on an OrgX work target. A durable artifact URL is required. May trigger automatic evaluation using external model providers and incur model costs. Registered proof awaits review; attaching does not approve or complete work.',
    { ...project('orgx_attach', ['type', 'id', 'name', 'artifact_type', 'description', 'preview_markdown', 'agent_type', 'company_stage', 'business_outcome', 'owner', 'review_date', 'verification', 'idempotency_key', 'session_id'], { type: workType }),
      location: z.union([z.object({ artifact_url: z.string().min(1) }).strict(), z.object({ external_url: z.string().url() }).strict()]).describe('Durable internal or external artifact URL.') }, {
      fixedArgs: { status: 'in_review' }, annotations: { ...appendOnly, openWorldHint: true },
      transformArgs: ({ location, ...args }) => ({ ...args, ...(location as Record<string, unknown>) }),
    }),
  operation('orgx_open_artifact_review', 'review_artifact', 'Open OrgX Artifact Review',
    'Read an artifact review packet and open the review widget. Supply an artifact ID, scope the next pending artifact to an entity, or use the authenticated workspace pending queue.',
    project('review_artifact', ['artifact_id', 'entity_id', 'workspace_id']), { executionKind: 'chatgpt', annotations: readOnly }),
  operation('orgx_request_independent_artifact_review', 'request_independent_artifact_review', 'Request Independent OrgX Artifact Review',
    'Queue an independent evaluator for a completed artifact. OrgX chooses the evaluator and persists the assessment. May incur model costs or use external providers; the producing agent cannot choose the score.',
    project('request_independent_artifact_review', ['artifact_id']), {
      executionKind: 'client', annotations: { ...appendOnly, openWorldHint: true },
    }),
  operation('orgx_complete_work_with_proof', 'orgx_act', 'Complete OrgX Work With Proof',
    'Register typed proof, verify completion requirements, and apply the allowed work completion transition. May return proof recorded with completion blocked or awaiting review. Verification and human acceptance remain separate facts.',
    { ...project('orgx_act', ['type', 'id', 'artifact', 'verification', 'quality_score', 'note', 'idempotency_key', 'session_id'], {
      type: workType, id: z.string().uuid(), artifact: completionProofArtifactSchema,
      verification: z.array(z.string().trim().min(1).max(2000)).max(30).optional().describe('Verification notes. A client with a cached schema can encode one producer modality_proof as orgx:modality-proof:v1: followed by the same closed JSON envelope; OrgX validates it before recording.'),
      note: z.string().trim().max(4000).optional(),
    }), workspace_id: workspaceId }, {
      fixedArgs: { action: 'complete_with_proof' }, annotations: { ...modifiesRecords, openWorldHint: true }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
];

function exactWorkAction(action: string, targets: readonly [string, ...string[]], title: string, description: string, extra: Record<string, z.ZodTypeAny> = {}, toolId = `orgx_${action}_work`): WorkflowToolAdapter {
  return operation(toolId, 'orgx_act', title, description,
    { ...project('orgx_act', workActionFields, { type: z.enum(targets) }), ...extra }, {
      fixedArgs: { action }, annotations: modifiesRecords, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
      backendRequest: (args) => {
        const { type, id, action: _action, session_id, ...body } = bodyArgs(args);
        return { method: 'POST', path: `/api/entities/${encodeURIComponent(String(type))}/${encodeURIComponent(String(id))}/${action}`, body, headers: retryHeaders(args) };
      },
    });
}

/** Individually discoverable compatibility operations, outside the curated default catalog. */
export const EXTENDED_WORKFLOW_TOOL_ADAPTERS: readonly WorkflowToolAdapter[] = [
  operation('orgx_create_and_launch_initiative_hierarchy', 'scaffold_initiative', 'Create and Launch OrgX Initiative Hierarchy',
    'Create a rich hierarchy through the existing compatibility batch path and launch follow-up work. May generate missing hierarchy, publish a live link, incur model costs, and synchronize an explicitly configured external tracker. Preserves objectives, references, dependencies, assignments, and proof profiles until atomic OrgX creation has full parity.',
    legacyScaffoldInput, {
      fixedArgs: { mode: 'launch', launch_after_create: true, response_mode: 'complete' }, executionKind: 'scaffold',
      annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    }),
  operation('orgx_request_plan_critique', 'orgx_plan', 'Request OrgX Plan Critique',
    'Submit a markdown draft for OrgX critique and update the planning session. May invoke an external model and incur costs. Does not dispatch executable work.',
    project('orgx_plan', ['session_id', 'plan_content', 'idempotency_key'], { session_id: id, plan_content: z.string().min(1) }), {
      fixedArgs: { action: 'improve' }, annotations: { ...modifiesRecords, openWorldHint: true }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_record_plan_edit', 'orgx_plan', 'Record OrgX Plan Edit Summary',
    'Append a change or feedback summary to the durable plan history. This records guidance only; it does not replace the markdown content or complete the plan.',
    project('orgx_plan', ['session_id', 'edit_summary', 'idempotency_key'], { session_id: id, edit_summary: z.string().min(1) }), {
      fixedArgs: { action: 'record_edit' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
  operation('orgx_check_agent_delegation', 'orgx_spawn', 'Check OrgX Agent Delegation',
    'Read delegation eligibility, quality gates, and rate-limit context for a specialist. Does not dispatch work or consume a dispatch allowance.',
    project('orgx_spawn', ['agent_type', 'task_id', 'title', 'instructions', 'workspace_id'], { agent_type: id }), {
      fixedArgs: { action: 'guard' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
    }),
  operation('orgx_classify_agent_task', 'orgx_spawn', 'Classify OrgX Agent Task',
    'Read complexity classification and model routing for a proposed task. Does not create or dispatch work.',
    project('orgx_spawn', ['title', 'instructions', 'agent_type', 'model_tier', 'provider', 'budget_mode', 'max_cost_usd'], { title: createTitle }), {
      fixedArgs: { action: 'classify' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
    }),
  operation('orgx_create_and_start_agent_task', 'orgx_spawn', 'Create and Start OrgX Agent Task',
    'Create an ad hoc delegated task and dispatch it in one compatibility operation. Can incur costs and interact with connected services under the declared constraints. Prefer separate creation and dispatch for reviewed work.',
    project('orgx_spawn', ['title', ...dispatchFields.filter((field) => field !== 'task_id')], { title: createTitle, instructions: z.string().min(1) }), {
      fixedArgs: { action: 'spawn' }, annotations: dispatchesWork, securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    }),
  operation('orgx_create_decision', 'orgx_decide', 'Create Named OrgX Decision',
    'Create a named decision with its text and rationale for human review. Does not approve the decision.',
    project('orgx_decide', ['title', 'decision', 'summary', 'context', 'initiative_id', 'workspace_id', 'idempotency_key', 'session_id'], { title: createTitle, decision: z.string().min(1) }), {
      fixedArgs: { action: 'create' }, annotations: appendOnly, securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    }),
  operation('orgx_open_decision_approval_review', 'orgx_decide', 'Open OrgX Decision Approval Review',
    'Open human review for a decision with an approval intent. Does not submit an approval, save a rationale, or resume work. The person makes the final choice in the review surface.',
    project('orgx_decide', ['decision_id', 'workspace_id', 'session_id'], { decision_id: id }), {
      fixedArgs: { action: 'approve' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    }),
  operation('orgx_open_decision_rejection_review', 'orgx_decide', 'Open OrgX Decision Rejection Review',
    'Open human review with a rejection intent. A reason is required by the compatibility gate but is not persisted or submitted. The person enters the final rationale and makes the ruling in the review surface.',
    project('orgx_decide', ['decision_id', 'reason', 'workspace_id', 'session_id'], { decision_id: id, reason: z.string().min(1) }), {
      fixedArgs: { action: 'reject' }, annotations: readOnly, securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    }),
  exactWorkAction('start', ['milestone', 'workstream', 'task'], 'Start OrgX Work', 'Start an existing task, milestone, or workstream using its exact supported state transition. Does not launch an initiative.'),
  exactWorkAction('complete', ['initiative', 'workstream', 'milestone', 'task', 'objective'], 'Complete OrgX Entity', 'Apply the supported entity completion transition after OrgX completion gates. Does not attach new proof or supply human approval. Ledger command completion uses the separate orgx_complete_work runtime contract.', {}, 'orgx_complete_entity'),
  exactWorkAction('archive', ['initiative', 'objective', 'playbook'], 'Archive OrgX Work', 'Archive an existing initiative, objective, or playbook through its exact supported transition.'),
  exactWorkAction('block', ['task', 'workstream'], 'Block OrgX Work', 'Mark a task or workstream blocked and retain its audit rationale.', { note: z.string().min(1) }),
  exactWorkAction('unblock', ['task'], 'Unblock OrgX Work', 'Clear the supported blocked state of a task after its blocker is resolved.'),
  exactWorkAction('reopen', ['task'], 'Reopen OrgX Work', 'Reopen a completed task through OrgX lifecycle validation.'),
  exactWorkAction('flag_risk', ['milestone'], 'Flag OrgX Milestone Risk', 'Flag a milestone at risk with an audit rationale. Does not pause active runs.', { note: z.string().min(1) }),
  exactWorkAction('activate', ['playbook'], 'Activate OrgX Playbook', 'Activate a playbook through the exact supported playbook transition.'),
  exactWorkAction('reassign_streams', ['initiative'], 'Reassign OrgX Initiative Workstreams', 'Recompute or apply supported workstream agent assignments within an initiative through OrgX policy.'),
  exactWorkAction('ship_batch', ['milestone'], 'Ship OrgX Milestone Task Batch', 'Complete eligible milestone tasks using a shared typed proof artifact and OrgX proof-chain checks.', { artifact: proofArtifactSchema, verification: z.array(z.string()).optional(), quality_score: z.number().min(0).max(5).optional() }),
  exactWorkAction('delete', ['workspace', 'initiative', 'workstream', 'milestone', 'task', 'objective', 'playbook'], 'Permanently Delete OrgX Work', 'Permanently delete an authorized work record. Intended for an explicit administrative profile; dependent-record rules remain enforced by OrgX.', { note: z.string().min(1) }),
  operation('orgx_validate_studio_content', 'orgx_act', 'Validate OrgX Studio Video Specification',
    'Check the required template and structured content of one studio video specification before rendering. Returns the OrgX validation result.',
    { id, spec: z.object({ template: z.string().min(1), version: z.string().optional(), title: z.string().optional(), content: z.record(jsonValueSchema), aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(), metadata: contentMetadataSchema.optional() }).strict(), note: z.string().optional() }, {
      fixedArgs: { type: 'studio_content', action: 'validate' }, annotations: { ...readOnly, idempotentHint: true }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    }),
];

export const WORKFLOW_TOOL_IDS = WORKFLOW_TOOL_ADAPTERS.map((tool) => tool.id);
export const EXTENDED_WORKFLOW_TOOL_IDS = EXTENDED_WORKFLOW_TOOL_ADAPTERS.map((tool) => tool.id);

const workflowApiMetaSchema = z.object({
  apiVersion: z.literal('1'), workspaceId: z.string(), created: z.boolean().optional(), duplicate: z.boolean().optional(),
}).strict();
const workflowPlanResultSchema = z.object({
  id: z.string(), session_id: z.string(), uuid: z.string(), uri: z.string(),
  accepted_id_forms: z.array(z.string()), plan_version: z.number().int().positive(),
  plan_ref: z.object({ type: z.literal('plan_session'), id: z.string(), workspace_id: z.string(), version: z.number().int().positive() }).strict(),
  title: z.string(), feature_name: z.string().nullable(), current_plan: z.string(), status: z.string(), updated_at: z.string(),
  edit_record: z.union([
    z.object({ status: z.literal('not_requested') }).strict(),
    z.object({ status: z.literal('recorded'), id: z.string() }).strict(),
    z.object({ status: z.literal('failed'), message: z.string() }).strict(),
  ]).optional(),
}).strict();
const planEnvelopeSchema = z.object({ data: workflowPlanResultSchema, meta: workflowApiMetaSchema }).strict();

/**
 * Direct services return their own versioned envelope. Do not pretend they are
 * the legacy router payload solely because they reuse its widget template.
 * Root registration applies the normal error-compatible transport wrapper.
 */
export const WORKFLOW_OUTPUT_SCHEMAS: Readonly<Record<string, z.AnyZodObject>> = {
  orgx_start_plan: planEnvelopeSchema,
  orgx_read_plan: planEnvelopeSchema,
  orgx_save_plan: planEnvelopeSchema,
  orgx_complete_plan: z.object({
    data: workflowPlanResultSchema.extend({
      status: z.literal('completed'),
      partial: z.boolean().optional(),
      context_attachments: z.object({
        requested: z.number().int().nonnegative(), attached_count: z.number().int().nonnegative(), skipped_count: z.number().int().nonnegative(),
        errors: z.array(z.object({ entity_type: workType, entity_id: z.string(), error: z.string() }).strict()),
      }).strict().optional(),
    }),
    meta: workflowApiMetaSchema,
  }).strict(),
  orgx_get_workspace_context: z.object({
    data: z.object({
      workspace: z.object({ id: z.string(), name: z.string().optional() }).catchall(jsonValueSchema),
      initiative: z.object({ id: z.string() }).catchall(jsonValueSchema).nullable().optional(),
      capabilities: z.record(jsonValueSchema).optional(),
      references: z.array(z.object({ type: z.string(), id: z.string() }).catchall(jsonValueSchema)).optional(),
    }).catchall(jsonValueSchema),
    meta: workflowApiMetaSchema,
  }).strict(),
  orgx_open_decision_review: z.object({
    data: z.object({
      decision_id: z.string(), decision: z.object({ id: z.string() }).catchall(jsonValueSchema),
      review_url: z.string(), requires_human_review: z.literal(true),
    }).catchall(jsonValueSchema),
    meta: workflowApiMetaSchema,
  }).strict(),
  orgx_validate_initiative_plan: z.object({
    data: z.object({
      valid: z.boolean(), plan_digest: z.string(), findings: z.array(jsonValueSchema).optional(),
    }).catchall(jsonValueSchema),
    meta: workflowApiMetaSchema,
  }).strict(),
  orgx_create_initiative_hierarchy: z.object({
    data: z.object({
      initiativeId: z.string(), receiptId: z.string(), eventId: z.string(), aggregateVersion: z.number(),
      eventHash: z.string(), duplicate: z.boolean(), initiative: z.record(jsonValueSchema),
      created: z.object({
        workstreams: z.number(), milestones: z.number(), tasks: z.number(), dependency_edges: z.number(), agents_assigned: z.number(),
      }).strict(),
    }).strict(),
    meta: workflowApiMetaSchema,
  }).strict(),
};

export function getWorkflowToolContract(toolId: string): WorkflowToolAdapter | undefined {
  return [...WORKFLOW_TOOL_ADAPTERS, ...EXTENDED_WORKFLOW_TOOL_ADAPTERS].find((tool) => tool.id === toolId);
}

/** Scope discovery is permissive by domain; invocation checks the fixed operation. */
export function resolveWorkflowInvocationSecuritySchemes(toolId: string, args: Record<string, unknown>): ToolSecuritySchemes | undefined {
  const tool = getWorkflowToolContract(toolId);
  if (!tool) return undefined;
  const canonicalArgs = tool.toCanonicalArgs(args);
  if (toolId === 'orgx_get_operation_status') {
    return canonicalArgs.kind === 'decision' ? SECURITY_SCHEMES.decisionReadRequiresAuth
      : canonicalArgs.kind === 'run' ? SECURITY_SCHEMES.agentReadRequiresAuth
        : canonicalArgs.kind === 'command' ? SECURITY_SCHEMES.entityReadRequiresAuth
          : SECURITY_SCHEMES.allReadRequiresAuth;
  }
  // Direct OrgX services have their own exact advertised scope. Resolving
  // their presentation identity as a legacy router would widen it incorrectly.
  if (tool.backendRequest) return tool.securitySchemes;
  return resolveContractToolInvocationSecuritySchemes(tool.canonicalToolId, canonicalArgs, tool.securitySchemes);
}
