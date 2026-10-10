/**
 * The OrgX surface map: every product surface a person uses in the web app,
 * with the tools an agent uses to read it and to change it.
 *
 * Workspace context returns this so an agent can explain where work lives,
 * deep-link the human to the right page, and pick the right tool, and so the
 * workspace-map widget can draw the same map. Tool ids must exist in
 * the current public catalog; tests/surfaceMap.spec.ts enforces that. Legacy
 * connections retain their original tool names through an explicit profile.
 */

export interface OrgxSurface {
  id: string;
  name: string;
  /** Web app path, joined to ORGX_WEB_URL. */
  path: string;
  /** One line: what the surface is for. */
  purpose: string;
  /** Tools that read this surface. */
  read: readonly string[];
  /** Tools that change it. */
  control: readonly string[];
}

export const ORGX_SURFACES: readonly OrgxSurface[] = [
  {
    id: 'command',
    name: 'Command',
    path: '/command',
    purpose: 'What needs you now, and what is running.',
    read: ['orgx_get_workspace_context', 'orgx_get_next_actions', 'orgx_get_operator_brief', 'orgx_get_operation_status'],
    control: ['orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work', 'orgx_cancel_work'],
  },
  {
    id: 'decisions',
    name: 'Decisions',
    path: '/decisions',
    purpose: 'Choices waiting on a named person, with options and evidence.',
    read: ['orgx_search', 'orgx_inspect', 'orgx_list_pending_decisions', 'orgx_open_decision_review'],
    control: ['orgx_capture_decision'],
  },
  {
    id: 'initiatives',
    name: 'Initiatives',
    path: '/initiatives',
    purpose: 'Outcomes broken into workstreams, milestones, and tasks.',
    read: ['orgx_get_workspace_context', 'orgx_inspect', 'orgx_get_initiative_progress', 'orgx_read_plan', 'orgx_validate_initiative_plan'],
    control: [
      'orgx_start_plan', 'orgx_save_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
      'orgx_create_initiative_hierarchy', 'orgx_create_initiative', 'orgx_create_workstream',
      'orgx_create_milestone', 'orgx_create_task', 'orgx_update_work',
      'orgx_launch_initiative', 'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work',
      'orgx_cancel_work', 'orgx_complete_work_with_proof',
    ],
  },
  {
    id: 'live',
    name: 'Live rooms',
    path: '/live',
    purpose: 'Running work per initiative, with its execution graph.',
    read: ['orgx_get_agent_status', 'orgx_get_initiative_progress', 'orgx_get_operation_status'],
    control: ['orgx_start_agent_task', 'orgx_handoff_task', 'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work', 'orgx_cancel_work'],
  },
  {
    id: 'agents',
    name: 'Agents',
    path: '/command/agents',
    purpose: 'Who is working, on what, and with which kit.',
    read: ['orgx_get_agent_status', 'orgx_estimate_agent_task', 'orgx_check_execution_readiness', 'orgx_get_operation_status'],
    control: ['orgx_start_agent_task', 'orgx_handoff_task'],
  },
  {
    id: 'work-ledger',
    name: 'Work Ledger',
    path: '/work-ledger',
    purpose:
      'The record of agent work across clients: sessions, receipts, decisions, and artifacts.',
    read: ['orgx_search', 'orgx_get_operator_brief', 'orgx_get_work_receipt', 'orgx_list_work_receipts', 'orgx_get_receipt_review_queue'],
    control: ['orgx_submit_work_receipt', 'orgx_attach_artifact'],
  },
  {
    id: 'quality',
    name: 'Quality Studio',
    path: '/settings/quality',
    purpose: 'The checks and judgment an artifact must pass before it ships.',
    read: ['orgx_inspect', 'orgx_open_artifact_review', 'orgx_validate_work_receipt', 'orgx_get_receipt_review_queue'],
    control: ['orgx_attach_artifact', 'orgx_request_independent_artifact_review', 'orgx_complete_work_with_proof', 'orgx_submit_work_receipt'],
  },
  {
    id: 'execution',
    name: 'Execution',
    path: '/settings/execution',
    purpose: 'Route priority, connected capacity, spend limits, and readiness.',
    read: ['orgx_check_execution_readiness', 'orgx_estimate_agent_task', 'orgx_get_operation_status'],
    control: [],
  },
  {
    id: 'goals',
    name: 'Goals',
    path: '/goals',
    purpose: 'Measurable targets that initiatives roll up to.',
    read: ['orgx_search', 'orgx_inspect'],
    control: [],
  },
];

/** The original router-based controls remain available only to compatibility profiles. */
const LEGACY_SURFACE_TOOLS: Readonly<Record<string, Pick<OrgxSurface, 'read' | 'control'>>> = {
  command: {
    read: ['orgx_recommend', 'get_morning_brief', 'orgx_tail'],
    control: ['orgx_act', 'manage_lifecycle'],
  },
  decisions: {
    read: ['orgx_search', 'orgx_inspect', 'orgx_poll_attention'],
    control: ['orgx_decide', 'approve_decision', 'reject_decision', 'orgx_request_attention', 'orgx_request_question'],
  },
  initiatives: {
    read: ['orgx_inspect', 'get_initiative_pulse', 'track_project_progress'],
    control: ['orgx_plan', 'orgx_write', 'scaffold_initiative', 'manage_lifecycle'],
  },
  live: {
    read: ['orgx_tail', 'get_agent_status', 'orgx_controller_status'],
    control: ['orgx_emit_activity', 'orgx_emit_execution_graph'],
  },
  agents: {
    read: ['get_agent_status'],
    control: ['orgx_spawn', 'delegate_agent_task', 'spawn_agent_task', 'handoff_task'],
  },
  'work-ledger': {
    read: ['orgx_search', 'recall_memory', 'query_org_memory', 'get_operator_chronicle'],
    control: ['orgx_submit_receipt', 'orgx_attach'],
  },
  quality: {
    read: ['orgx_inspect'],
    control: ['orgx_expect', 'review_artifact', 'request_independent_artifact_review', 'approve_agent_work'],
  },
  execution: {
    read: ['check_execution_readiness', 'orgx_controller_status'],
    control: [],
  },
  goals: {
    read: ['orgx_search', 'orgx_inspect'],
    control: ['orgx_write'],
  },
};

/** The historical directory schema is selected by its explicit migration profile. */
const LEGACY_DIRECTORY_SURFACE_TOOLS: Readonly<Record<string, Pick<OrgxSurface, 'read' | 'control'>>> = {
  command: {
    read: ['orgx_recommend', 'get_morning_brief', 'orgx_command_status'],
    control: ['orgx_change_entity_state', 'manage_lifecycle'],
  },
  decisions: {
    read: ['orgx_search', 'orgx_inspect', 'orgx_list_pending_decisions', 'orgx_open_decision_review'],
    control: ['orgx_record_decision'],
  },
  initiatives: {
    read: ['orgx_inspect', 'get_initiative_pulse', 'orgx_read_plan'],
    control: [
      'orgx_start_plan', 'orgx_improve_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
      'orgx_create_entity', 'orgx_update_entity', 'orgx_change_entity_state',
      'orgx_complete_with_proof', 'manage_lifecycle',
    ],
  },
  live: {
    read: ['get_agent_status', 'orgx_command_status'],
    control: ['manage_lifecycle'],
  },
  agents: {
    read: ['get_agent_status', 'orgx_check_delegation', 'check_execution_readiness'],
    control: ['orgx_delegate_work', 'manage_lifecycle'],
  },
  'work-ledger': {
    read: ['orgx_search', 'get_operator_chronicle'],
    control: ['orgx_submit_receipt', 'orgx_attach'],
  },
  quality: {
    read: ['orgx_inspect', 'review_artifact'],
    control: ['orgx_attach', 'orgx_complete_with_proof', 'orgx_submit_receipt'],
  },
  execution: {
    read: ['check_execution_readiness', 'orgx_check_delegation', 'orgx_command_status'],
    control: [],
  },
  goals: {
    read: ['orgx_search', 'orgx_inspect'],
    control: ['orgx_create_entity', 'orgx_update_entity'],
  },
};

export interface OrgxSurfaceEntry {
  id: string;
  name: string;
  url: string;
  purpose: string;
  read: string[];
  control: string[];
}

const DEFAULT_WEB_URL = 'https://useorgx.com';

const LEGACY_SURFACE_PROFILES = new Set([
  'legacy', 'claude-plugin', 'memory', 'commander', 'planner', 'executor', 'observer',
]);

/**
 * The surface map for this session: links resolved against the web app and
 * tool lists filtered to what the session can actually call. Surfaces stay in
 * the map even when no tool is visible, so an agent can still send the human
 * to the page.
 */
export function buildSurfaceMap(params: {
  visibleTools: readonly string[];
  webUrl?: string | null;
  profile?: string | null;
}): OrgxSurfaceEntry[] {
  const visible = new Set(params.visibleTools);
  let base: URL;
  try {
    base = new URL(params.webUrl || DEFAULT_WEB_URL);
  } catch {
    base = new URL(DEFAULT_WEB_URL);
  }
  return ORGX_SURFACES.map((surface) => {
    const tools = params.profile === 'claude-directory-legacy'
      ? LEGACY_DIRECTORY_SURFACE_TOOLS[surface.id] ?? surface
      : LEGACY_SURFACE_PROFILES.has(params.profile ?? '')
        ? LEGACY_SURFACE_TOOLS[surface.id] ?? surface
        : surface;
    return {
      id: surface.id,
      name: surface.name,
      url: new URL(surface.path, base).toString(),
      purpose: surface.purpose,
      read: tools.read.filter((tool) => visible.has(tool)),
      control: tools.control.filter((tool) => visible.has(tool)),
    };
  });
}
