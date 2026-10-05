/**
 * The OrgX surface map: every product surface a person uses in the web app,
 * with the tools an agent uses to read it and to change it.
 *
 * `orgx_bootstrap` returns this so an agent can explain where work lives,
 * deep-link the human to the right page, and pick the right tool, and so the
 * workspace-map widget can draw the same map. Tool ids must exist in
 * server.json; tests/surfaceMap.spec.ts enforces that.
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
    read: ['orgx_recommend', 'get_morning_brief', 'orgx_tail'],
    control: ['orgx_act', 'manage_lifecycle'],
  },
  {
    id: 'decisions',
    name: 'Decisions',
    path: '/decisions',
    purpose: 'Choices waiting on a named person, with options and evidence.',
    read: ['orgx_search', 'orgx_inspect', 'orgx_poll_attention'],
    control: [
      'orgx_decide',
      'approve_decision',
      'reject_decision',
      'orgx_request_attention',
      'orgx_request_question',
    ],
  },
  {
    id: 'initiatives',
    name: 'Initiatives',
    path: '/initiatives',
    purpose: 'Outcomes broken into workstreams, milestones, and tasks.',
    read: ['orgx_inspect', 'get_initiative_pulse', 'track_project_progress'],
    control: ['orgx_plan', 'orgx_write', 'scaffold_initiative', 'manage_lifecycle'],
  },
  {
    id: 'live',
    name: 'Live rooms',
    path: '/live',
    purpose: 'Running work per initiative, with its execution graph.',
    read: ['orgx_tail', 'get_agent_status', 'orgx_controller_status'],
    control: ['orgx_emit_activity', 'orgx_emit_execution_graph'],
  },
  {
    id: 'agents',
    name: 'Agents',
    path: '/command/agents',
    purpose: 'Who is working, on what, and with which kit.',
    read: ['get_agent_status'],
    control: ['orgx_spawn', 'delegate_agent_task', 'spawn_agent_task', 'handoff_task'],
  },
  {
    id: 'work-ledger',
    name: 'Work Ledger',
    path: '/work-ledger',
    purpose:
      'The record of agent work across clients: sessions, receipts, decisions, and artifacts.',
    read: ['orgx_search', 'recall_memory', 'query_org_memory', 'get_operator_chronicle'],
    control: ['orgx_submit_receipt', 'orgx_attach'],
  },
  {
    id: 'quality',
    name: 'Quality Studio',
    path: '/settings/quality',
    purpose: 'The checks and judgment an artifact must pass before it ships.',
    read: ['orgx_inspect'],
    control: [
      'orgx_expect',
      'review_artifact',
      'request_independent_artifact_review',
      'approve_agent_work',
    ],
  },
  {
    id: 'execution',
    name: 'Execution',
    path: '/settings/execution',
    purpose: 'Route priority, connected capacity, spend limits, and readiness.',
    read: ['check_execution_readiness', 'orgx_controller_status'],
    control: [],
  },
  {
    id: 'goals',
    name: 'Goals',
    path: '/goals',
    purpose: 'Measurable targets that initiatives roll up to.',
    read: ['orgx_search', 'orgx_inspect'],
    control: ['orgx_write'],
  },
];

/** Only directory sessions project the operation-specific workflow controls. */
const DIRECTORY_SURFACE_TOOLS: Readonly<Record<string, Pick<OrgxSurface, 'read' | 'control'>>> = {
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
    const tools = params.profile === 'claude-directory'
      ? DIRECTORY_SURFACE_TOOLS[surface.id] ?? surface
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
