import { z } from 'zod';

import { CONTRACT_TOOL_DEFINITIONS, INLINE_TOOL_CONTRACTS, type ToolSecuritySchemes } from './contractTools';
import { SECURITY_SCHEMES } from './toolDefinitions';

/**
 * Operation-specific directory adapters. They project an existing contract;
 * their handler is always the canonical implementation, including its input
 * validation, human review gate, budget preflight, and invocation-time OAuth.
 * Keeping read and write operations separate gives Claude accurate permission
 * hints without copying backend workflows or changing other client profiles.
 */
export interface ClaudeDirectoryToolAdapter {
  id: string;
  canonicalToolId: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  securitySchemes: ToolSecuritySchemes;
  toCanonicalArgs: (args: Record<string, unknown>) => Record<string, unknown>;
}

function canonicalContract(id: string) {
  const contract = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === id);
  if (!contract) throw new Error(`Missing canonical directory contract: ${id}`);
  return contract;
}

/** Reuse validators while removing parameter prose about other tool calls. */
function inputProjection(
  canonicalToolId: string,
  fields: readonly string[],
  overrides: Record<string, z.ZodTypeAny> = {}
): Record<string, z.ZodTypeAny> {
  const shape = canonicalContract(canonicalToolId).inputSchema as Record<string, z.ZodTypeAny>;
  return Object.fromEntries(fields.map((field) => {
    let schema = overrides[field] ?? shape[field];
    if (!schema) throw new Error(`Missing ${canonicalToolId} parameter: ${field}`);
    if (schema.description && /\b(?:orgx_|list_entities\b|scaffold_initiative\b)/.test(schema.description)) {
      const descriptions: Record<string, string> = {
        workspace_id: 'Workspace UUID. Defaults to the authenticated session workspace when omitted.',
        goal_ids: 'Objective UUIDs. Required when the workspace enforces a primary objective.',
        session_id: 'Optional OrgX session identifier.',
      };
      schema = schema.describe(descriptions[field] ?? schema.description
        .replace(/(?:orgx_[a-z_]+|list_entities|scaffold_initiative)/g, 'OrgX'));
    }
    return [field, schema];
  }));
}

function adapter(
  id: string,
  canonicalToolId: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  annotations: ClaudeDirectoryToolAdapter['annotations'],
  securitySchemes: ToolSecuritySchemes,
  fixedArgs: Record<string, unknown> = {}
): ClaudeDirectoryToolAdapter {
  return {
    id, canonicalToolId, title, description, inputSchema, annotations, securitySchemes,
    // A supplied discriminator cannot widen an operation adapter's behavior.
    toCanonicalArgs: (args) => ({ ...args, ...fixedArgs }),
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const appendOnly = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const modifiesRecords = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const dispatchesWork = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const entityWriteShape = canonicalContract('orgx_write').inputSchema;
const createFields = Object.keys(entityWriteShape).filter((field) => ![
  'operation', 'id', 'fields', 'status', 'resolution', 'entity_type', 'entity_id',
  'task_id', 'artifact_type', 'artifact_url', 'external_url', 'preview_markdown',
].includes(field));
const dispatchFields = Object.keys(canonicalContract('orgx_spawn').inputSchema).filter((field) => field !== 'action');
// Workspace creation ignores retry keys and can replace the account default.
// Keep directory writes within existing workspaces until that API is bounded.
const createEntityType = z.enum(['initiative', 'workstream', 'milestone', 'task', 'objective', 'skill', 'blocker']);
// The generic API rejects direct blocker PATCHes. Decisions and artifacts have
// dedicated contracts; content editing cannot change approval or work status.
const updateEntityType = z.enum(['workspace', 'initiative', 'workstream', 'milestone', 'task', 'objective', 'skill']);
const contentPatch = z.object({
  title: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_date: z.string().optional(),
  goal_ids: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0, 'At least one content field is required.');
const linkedProofArtifact = z.object({
  artifact_type: z.string().trim().min(1),
  artifact_url: z.string().url().optional(),
  external_url: z.string().url().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  preview_markdown: z.string().optional(),
}).strict().refine(
  (artifact) => Boolean(artifact.artifact_url || artifact.external_url),
  'A proof artifact URL or external URL is required.'
);

export const CLAUDE_DIRECTORY_TOOL_ADAPTERS: readonly ClaudeDirectoryToolAdapter[] = [
  adapter(
    'orgx_create_entity', 'orgx_write', 'Create OrgX Entity',
    'Create one OrgX initiative, workstream, milestone, task, objective, skill, or blocker record within an existing workspace, in its default initial workflow state. Accepts per-type parent IDs, titles, and metadata. Initiative creation can publish a public live link when explicitly requested. Reusing an idempotency key returns the existing record instead of creating a duplicate.',
    inputProjection('orgx_write', createFields, {
      type: createEntityType.describe('Work record type to create.'),
    }),
    { ...appendOnly, openWorldHint: true }, SECURITY_SCHEMES.anyWriteRequiresAuth,
    { operation: 'create' }
  ),
  adapter(
    'orgx_update_entity', 'orgx_write', 'Update OrgX Entity',
    'Update the content of one existing OrgX workspace, initiative, workstream, milestone, task, objective, or skill selected by type and ID. Supports titles, summaries, descriptions, priority, due date, objectives, and metadata. The patch overwrites only supplied fields. It cannot change workflow status, approve work, or mark completion.',
    inputProjection('orgx_write', ['type', 'id', 'fields', 'idempotency_key', 'session_id'], {
      type: updateEntityType.describe('Work record type whose content should change.'),
      id: z.string().min(1).describe('Existing entity UUID.'),
      fields: contentPatch.describe('Nonempty content patch. Workflow status, approval, ownership, and completion fields are not accepted.'),
    }),
    modifiesRecords, SECURITY_SCHEMES.anyWriteRequiresAuth,
    { operation: 'update' }
  ),
  adapter(
    'orgx_start_plan', 'orgx_plan', 'Start OrgX Plan',
    'Create a durable OrgX planning session for a named feature or initiative, optionally seeded with markdown plan content. The plan remains available across sessions and agents. Each successful call creates a new session; read back its returned session ID before retrying an uncertain response.',
    inputProjection('orgx_plan', ['feature_name', 'initial_plan', 'workspace_id'], {
      feature_name: z.string().min(1).describe('Feature or plan name.'),
    }),
    appendOnly, SECURITY_SCHEMES.entityWriteRequiresAuth, { action: 'start' }
  ),
  adapter(
    'orgx_read_plan', 'orgx_plan', 'Read OrgX Plan',
    'Read one durable OrgX plan session by its explicit UUID or plan URI. Does not edit or complete the plan, or select another session automatically.',
    inputProjection('orgx_plan', ['session_id'], {
      session_id: z.string().trim().min(1).describe('Required plan session UUID or orgx://plan_session/<uuid> URI.'),
    }),
    readOnly, SECURITY_SCHEMES.entityReadRequiresAuth, { action: 'resume' }
  ),
  adapter(
    'orgx_improve_plan', 'orgx_plan', 'Improve OrgX Plan',
    'Request AI critique and improvement of a durable OrgX plan using its session ID and current markdown draft. Updates planning session state and can incur model costs. Each call can invoke the model again; read back the session before retrying an uncertain response.',
    inputProjection('orgx_plan', ['session_id', 'plan_content'], {
      session_id: z.string().min(1).describe('Plan session UUID or orgx://plan_session/<uuid> URI.'),
      plan_content: z.string().min(1).describe('Current markdown plan draft to improve.'),
    }),
    { ...modifiesRecords, openWorldHint: true }, SECURITY_SCHEMES.entityWriteRequiresAuth, { action: 'improve' }
  ),
  adapter(
    'orgx_record_plan_edit', 'orgx_plan', 'Record OrgX Plan Edit',
    'Append an edit summary to a durable OrgX planning session. Records the change history without completing the plan. Requires the session ID and a description of the edit.',
    inputProjection('orgx_plan', ['session_id', 'edit_summary'], {
      session_id: z.string().min(1).describe('Plan session UUID or orgx://plan_session/<uuid> URI.'),
      edit_summary: z.string().min(1).describe('Summary of the planning change.'),
    }),
    appendOnly, SECURITY_SCHEMES.entityWriteRequiresAuth, { action: 'record_edit' }
  ),
  adapter(
    'orgx_complete_plan', 'orgx_plan', 'Complete OrgX Plan',
    'Save the final markdown plan and complete its durable OrgX planning session. Can attach the completed plan to one or more initiatives, workstreams, milestones, or tasks. Does not dispatch execution.',
    inputProjection('orgx_plan', ['session_id', 'plan_content', 'attach_to'], {
      session_id: z.string().min(1).describe('Plan session UUID or orgx://plan_session/<uuid> URI.'),
      plan_content: z.string().min(1).describe('Final accepted markdown plan.'),
    }),
    modifiesRecords, SECURITY_SCHEMES.entityWriteRequiresAuth, { action: 'complete' }
  ),
  adapter(
    'orgx_check_delegation', 'orgx_spawn', 'Check OrgX Delegation',
    'Classify task complexity or estimate candidate model routes and cost for OrgX agent work. Requires a title or task ID. These operations do not create a task, consume a dispatch rate-limit allowance, or dispatch a run.',
    inputProjection('orgx_spawn', ['action', 'title', 'task_id', 'initiative_id', 'workspace_id', 'agent_type', 'instructions', 'model_tier', 'model', 'provider', 'runtime', 'budget_mode', 'max_cost_usd'], {
      action: z.enum(['classify', 'estimate']).describe('Task classification or route and cost estimate.'),
    }),
    readOnly, SECURITY_SCHEMES.agentReadRequiresAuth
  ),
  adapter(
    'orgx_delegate_work', 'orgx_spawn', 'Delegate OrgX Work',
    'Dispatch OrgX specialist agent work for an existing task or a new task with a title and instructions. spawn creates or runs delegated work; handoff reassigns an existing task to an agent type. Delegation can incur model costs and interact with connected services. Applies durable assignment, deadline, budget, acceptance, permission, and idempotency constraints.',
    inputProjection('orgx_spawn', ['action', ...dispatchFields], {
      action: z.enum(['spawn', 'handoff']).default('spawn').describe('Dispatch new agent work or hand off an existing task.'),
    }),
    dispatchesWork, SECURITY_SCHEMES.agentRequiresAuth
  ),
  adapter(
    'orgx_list_pending_decisions', 'orgx_decide', 'List Pending OrgX Decisions',
    'Read pending OrgX decisions awaiting human review, optionally scoped to an initiative or workspace. Returns the decision context and review information without resolving decisions or dispatching work.',
    inputProjection('orgx_decide', ['initiative_id', 'workspace_id', 'session_id']),
    readOnly, SECURITY_SCHEMES.decisionReadRequiresAuth, { action: 'list_pending' }
  ),
  adapter(
    'orgx_record_decision', 'orgx_decide', 'Record OrgX Decision',
    'Create or remember a durable OrgX decision with its rationale and provenance. create requires a title and decision text; remember accepts decision text and an optional title. Can associate the record with an initiative and deduplicate retries with an idempotency key. Does not approve a pending decision.',
    inputProjection('orgx_decide', ['action', 'title', 'decision', 'summary', 'context', 'initiative_id', 'workspace_id', 'idempotency_key', 'session_id'], {
      action: z.enum(['create', 'remember']).default('create').describe('Create a named decision or remember decision text.'),
      decision: z.string().min(1).describe('Decision text to record.'),
    }),
    appendOnly, SECURITY_SCHEMES.writeRequiresAuth
  ),
  adapter(
    'orgx_open_decision_review', 'orgx_decide', 'Open OrgX Decision Review',
    'Return the authenticated human review URL for a pending OrgX decision, with an approval or rejection intent. Requires a decision ID; rejection also requires a reason. This operation does not submit the rationale, settle the decision, approve agent work, or resume a run. Final judgment remains in the human review session.',
    inputProjection('orgx_decide', ['action', 'decision_id', 'reason', 'note', 'workspace_id', 'session_id'], {
      action: z.enum(['approve', 'reject']).describe('Requested review intent, without resolving the decision.'),
      decision_id: z.string().min(1).describe('Pending decision UUID.'),
    }),
    // The canonical human-review gate intentionally retains its write grant.
    readOnly, SECURITY_SCHEMES.writeRequiresAuth
  ),
  adapter(
    'orgx_complete_with_proof', 'orgx_act', 'Complete OrgX Work With Proof',
    'Complete an OrgX task, milestone, workstream, or initiative with a linked proof artifact and verification evidence. Requires an artifact type and artifact URL or external URL. Records durable evidence and applies completion checks before changing the work state.',
    inputProjection('orgx_act', ['type', 'id', 'artifact', 'verification', 'quality_score', 'note', 'session_id'], {
      type: z.enum(['task', 'milestone', 'workstream', 'initiative']).describe('Work entity type to complete with proof.'),
      artifact: linkedProofArtifact.describe('Proof artifact with artifact_type and artifact_url or external_url; optional name, description, and preview_markdown. Attached proof remains in review; this operation cannot approve it.'),
    }),
    modifiesRecords, SECURITY_SCHEMES.entityWriteRequiresAuth,
    { action: 'complete_with_proof' }
  ),
  adapter(
    'orgx_change_entity_state', 'orgx_act', 'Change OrgX Entity State',
    'Change the workflow state of an OrgX initiative, workstream, milestone, task, objective, or playbook. Supports starting or launching work, blocking or unblocking, reopening, flagging risk, archiving, activating, or reassigning workstreams where valid for the entity type. Launching can dispatch connected agent work and incur costs. Records a supplied rationale in audit history.',
    inputProjection('orgx_act', ['type', 'id', 'action', 'note', 'idempotency_key', 'session_id'], {
      type: z.enum(['initiative', 'workstream', 'milestone', 'task', 'objective', 'playbook']).describe('Entity type whose workflow state should change.'),
      action: z.enum(['launch', 'start', 'block', 'unblock', 'reopen', 'flag_risk', 'archive', 'reassign_streams', 'activate']).describe('Workflow state change. Must be valid for the selected entity type.'),
    }),
    dispatchesWork, SECURITY_SCHEMES.entityWriteRequiresAuth
  ),
];

export const CLAUDE_DIRECTORY_ADAPTER_IDS = CLAUDE_DIRECTORY_TOOL_ADAPTERS.map((tool) => tool.id);

const resumeAgentRunContract: ClaudeDirectoryToolAdapter = {
  ...INLINE_TOOL_CONTRACTS.resume_agent_run,
  canonicalToolId: 'resume_agent_run',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
  toCanonicalArgs: (args) => args,
};

export function getClaudeDirectoryToolContract(toolId: string): ClaudeDirectoryToolAdapter | undefined {
  return toolId === 'resume_agent_run'
    ? resumeAgentRunContract
    : CLAUDE_DIRECTORY_TOOL_ADAPTERS.find((tool) => tool.id === toolId);
}
