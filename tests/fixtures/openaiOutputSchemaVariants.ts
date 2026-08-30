import {
  buildCompactScaffoldResult,
  buildScaffoldDraftResult,
} from '../../src/scaffoldResponse';

export const ORGX_ACT_OUTPUT_VARIANTS = [
  {
    success: true,
    dry_run: true,
    type: 'task',
    action: 'update',
    fields: { title: 'Ship schemas' },
    updated_fields: ['title'],
    message: 'task would be updated',
    data: { id: 'task-1', updated: false, would_update: true },
    _v2_tool: 'orgx_act',
    _action: 'update',
    entity_type: 'task',
    entity_id: 'task-1',
  },
  {
    success: true,
    dry_run: true,
    type: 'task',
    action: 'delete',
    message: 'task would be deleted permanently',
    data: { id: 'task-1', deleted: false, would_delete: true },
    _v2_tool: 'orgx_act',
    _action: 'delete',
    entity_type: 'task',
    entity_id: 'task-1',
  },
  {
    type: 'task',
    data: { id: 'task-1' },
    initiative_activation: { status: 'active' },
    stream_reassignment: { status: 'assigned' },
    normalization_warnings: [
      {
        path: 'orgx_write.status',
        from: 'active',
        to: 'in_progress',
        reason: 'Task lifecycle normalization.',
      },
    ],
    _v2_tool: 'orgx_write',
    operation: 'update',
  },
  {
    ok: true,
    artifact: { id: 'artifact-1' },
    _v2_tool: 'orgx_attach',
    _action: 'attach',
  },
  { valid: true, errors: [], _action: 'validate' },
  {
    success: true,
    type: 'task',
    action: 'complete',
    message: 'task completed',
    data: { id: 'task-1' },
    transition: { from: 'in_progress', to: 'done' },
    _v2_tool: 'orgx_act',
    _action: 'complete',
    entity_type: 'task',
    entity_id: 'task-1',
  },
  {
    ok: false,
    _v2_tool: 'orgx_act',
    _action: 'complete_with_proof',
    entity_type: 'task',
    entity_id: 'task-1',
    proof_attached: true,
    attach_result: { ok: true, artifact: { id: 'artifact-1' } },
    verification: { verified: false, blockers: ['Missing review'] },
    diagnostic: {
      code: 'missing_completion_proof',
      reason: 'Proof is not approved.',
      safe_to_retry: true,
    },
  },
  {
    success: true,
    transition: { from: 'in_progress', to: 'done' },
    forced_proof_completion: true,
    _v2_tool: 'orgx_act',
    _action: 'complete_with_proof',
    entity_type: 'task',
    entity_id: 'task-1',
    proof_attached: true,
    attach_result: { ok: true, artifact: { id: 'artifact-1' } },
    verification: { verified: true, blockers: [] },
    message: 'Completed task with proof',
  },
];

const PLAN_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_REF = {
  session_id: PLAN_SESSION_ID,
  uuid: PLAN_SESSION_ID,
  uri: `orgx://plan_session/${PLAN_SESSION_ID}`,
  accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'],
};
const CANONICAL_PLAN_SESSION = {
  ...PLAN_REF,
  id: PLAN_SESSION_ID,
  current_plan: '# plan',
  status: 'active',
  domains_detected: ['product'],
  last_edit_at: '2026-08-30T12:00:00.000Z',
};

export const ORGX_PLAN_OUTPUT_VARIANTS = [
  { id: PLAN_SESSION_ID, title: 'Plan', ...PLAN_REF },
  {
    sessions: [],
    accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'],
  },
  {
    sessions: [{ id: PLAN_SESSION_ID, title: 'Plan', ...PLAN_REF }],
    accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'],
    selected_session: { id: PLAN_SESSION_ID, title: 'Plan', ...PLAN_REF },
  },
  {
    suggestions: [],
    domains_detected: ['product'],
    skills_applied: [{ id: 'skill-1', name: 'Evidence loop' }],
    learned_from_past: 1,
    analysis_summary: 'No changes required.',
    generation: { status: 'complete' },
    ...PLAN_REF,
    plan_session: CANONICAL_PLAN_SESSION,
  },
  {
    id: 'edit-1',
    edit_type: 'change_approach',
    section_path: 'Execution',
    before_content: '# plan',
    after_content: '# changed',
    user_reason: 'Narrow scope',
    ai_suggestion: true,
    learning_extracted: true,
    ...PLAN_REF,
    plan_session: { ...CANONICAL_PLAN_SESSION, current_plan: '# changed' },
  },
  {
    ...PLAN_REF,
    status: 'completed',
    current_plan: '# final',
    plan_session: { ...CANONICAL_PLAN_SESSION, status: 'completed' },
    completion: { status: 'completed' },
    skill_suggestions: [],
    context_attachments: {
      attached_count: 2,
      skipped_count: 1,
      errors: [],
    },
    message: 'Plan completed.',
  },
  {
    ok: true,
    data: {
      sessions: [
        {
          ...CANONICAL_PLAN_SESSION,
          title: 'OpenAI submission plan',
          feature_name: 'OpenAI submission',
          plan_version: 2,
          started_at: '2026-08-30T11:00:00.000Z',
        },
      ],
      selected_session: {
        ...CANONICAL_PLAN_SESSION,
        title: 'OpenAI submission plan',
      },
    },
    sessions: [],
    accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'],
  },
];

export const ORGX_SPAWN_DURABLE_OUTPUT = {
  _v2_tool: 'orgx_spawn',
  _action: 'handoff',
  routed_tool: 'handoff_task',
  delegation_contract: 'durable_delegation_v2',
  task_id: 'task-123',
  run_id: 'run-456',
  job_id: 'job-789',
  dispatch_receipt: {
    dispatch: 'cloud_claimed',
    jobStatus: 'running',
    acceptedAt: '2026-08-30T12:00:00.000Z',
    publishId: 'inngest-event-1',
  },
};

export const ORGX_DECIDE_OUTPUT_VARIANTS = [
  {
    id: 'decision-1',
    type: 'decision',
    title: 'Keep scope narrow',
    initiative_id: null,
    normalization_warnings: [],
  },
  {
    decisions: [],
    total_pending: 0,
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
    message: 'All clear.',
  },
  {
    ok: false,
    tool_id: 'get_pending_decisions',
    error: 'Unable to load decisions.',
    error_type: 'tool_execution_failed',
  },
];

const SCAFFOLD_ERROR_VARIANTS = [
  {
    ok: false,
    error_kind: 'mcp_identity_mismatch',
    identity_warning: {
      code: 'mcp_placeholder_identity',
      message: 'Reconnect the MCP account.',
    },
  },
  {
    ok: false,
    error_kind: 'billing_scaffold_limit_reached',
    billing_url: 'https://useorgx.com/settings/billing',
    pricing_url: 'https://useorgx.com/pricing',
    usage: {
      scaffoldsUsed: 1,
      scaffoldsIncluded: 1,
      hasScaffolds: false,
    },
  },
  {
    ok: false,
    error_kind: 'missing_workspace_context',
    missing: ['workspace_id'],
    suggested_next_calls: [
      {
        tool: 'orgx_search',
        arguments: { type: 'workspace', query: 'workspace' },
        purpose: 'Find the workspace for this scaffold.',
      },
    ],
  },
  {
    ok: false,
    error_kind: 'scaffold_initiative_failed',
    error: 'Workspace context could not be resolved.',
    resolution_hint: 'workspace_id_required',
  },
];

export function buildScaffoldOutputVariants() {
  const draft = buildScaffoldDraftResult({
    batch: [
      { type: 'initiative', title: 'OpenAI submission', ref: 'initiative' },
      { type: 'workstream', title: 'Readiness', ref: 'readiness' },
    ],
    workspaceId: 'workspace-1',
    contractWarnings: [
      { code: 'normalized_mode', message: 'Mode normalized.' },
    ],
    dependencyEdges: [],
  });
  const created = buildCompactScaffoldResult({
    mode: 'launch',
    initiativeId: 'initiative-1',
    workspaceId: 'workspace-1',
    result: {
      summary: 'Created 1/1 entities',
      total: 1,
      created_count: 1,
      failed_count: 0,
      warnings: [],
      failed: [],
      ref_map: { initiative: 'initiative-1' },
      created: [
        {
          index: 0,
          type: 'initiative',
          id: 'initiative-1',
          ref: 'initiative',
        },
      ],
      results: [],
    },
    hierarchy: {
      initiative: { id: 'initiative-1', title: 'OpenAI submission' },
      workstreams: [],
    },
  });
  return [...SCAFFOLD_ERROR_VARIANTS, draft, created];
}

export const COMMON_STRUCTURED_TOOL_ERROR = {
  error: {
    code: 'invalid_input',
    status: 400,
    message: 'Invalid request.',
    details: { field: 'id', retryable: false },
  },
};
