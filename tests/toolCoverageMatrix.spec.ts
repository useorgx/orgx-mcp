import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import { FOUNDER_TEAM_ARTIFACT_TYPES } from '../src/artifactContracts';
import { V2_PUBLIC_TOOL_IDS } from '../src/bootstrapPayload';

type CoverageTier =
  | 'live_read_verified'
  | 'contract_and_unit'
  | 'transport_and_compat'
  | 'schema_only_needs_live_auth'
  | 'live_blocked_external_auth'
  | 'local_registered_not_installed_public'
  | 'compatibility_alias'
  | 'public_discovery';

type CoverageEntry = {
  tier: CoverageTier;
  evidence: string[];
  remaining?: string;
};

type PostDeployRecheck = {
  tool: string;
  probe: string;
  expected: string;
  blocks: string[];
};

const POST_DEPLOY_RECHECKS: PostDeployRecheck[] = [
  {
    tool: 'orgx_bootstrap',
    probe: 'Call orgx_bootstrap with workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8.',
    expected: 'Response workspace is non-null and carries the requested workspace id or equivalent active workspace context.',
    blocks: ['workspace:null on live server 0.3.0-7fc0bdc0'],
  },
  {
    tool: 'orgx_plan',
    probe: 'Inspect live schema and call action=start with workspace_id plus idempotency_key against a disposable plan session.',
    expected: 'Live schema accepts workspace_id and returned plan session is workspace-scoped.',
    blocks: ['live schema does not expose workspace_id on orgx_plan action=start'],
  },
  {
    tool: 'orgx_act',
    probe: 'Call action=update dry_run=true against a disposable or no-op fixture and inspect the entity before/after.',
    expected: 'Response returns would_update/dry-run content and the target entity is unchanged.',
    blocks: ['prior live dry_run update mutated an initiative by delegating to orgx_write'],
  },
  {
    tool: 'orgx_write',
    probe: 'Inspect live schema and run draft/disposable create validation for initiative/task/artifact constraints.',
    expected: 'Live schema documents workspace_id+goal_ids, priority low|medium|high|urgent only, no initiative due_date, milestone-backed tasks, and artifact_url/external_url requirement.',
    blocks: ['live schema still advertises preview_markdown as a standalone artifact create input'],
  },
  {
    tool: 'orgx_attach',
    probe: 'Inspect live schema descriptions for founder/team artifact examples.',
    expected: 'Live artifact examples include sales.conversion_gates, marketing.positioning_brief, marketing.proof_distribution_plan, and marketing.interview_pr_plan.',
    blocks: ['live schema still omits the new GTM artifact types'],
  },
  {
    tool: 'consolidate_pr',
    probe: 'Call consolidate_pr against a harmless closed PR fixture after OrgX server-side GitHub credentials are configured.',
    expected: 'Returns an orchestration.consolidation_pass artifact or a structured non-auth blocker.',
    blocks: ['GitHub token unavailable'],
  },
];

const TOOL_COVERAGE: Record<string, CoverageEntry> = {
  account_status: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpWorker.accountTools.spec.ts'],
  },
  account_upgrade: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpWorker.accountTools.spec.ts', 'tests/mcpTransport.spec.ts'],
  },
  account_usage_report: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpWorker.accountTools.spec.ts'],
  },
  approve_agent_work: {
    tier: 'live_read_verified',
    evidence: ['live approve_agent_work action=list returned zero pending decisions, then found and approved disposable decision a25acdb6-cb60-4400-a11c-63fadd14d0a3, 2026-05-28', 'tests/toolDiscoverySnapshot.spec.ts'],
  },
  approve_decision: {
    tier: 'live_read_verified',
    evidence: ['live approve_decision approved disposable decision b26df9ab-f444-4e2b-ad8e-365b88cf4deb, 2026-05-28', 'tests/decisionToolsContract.spec.ts'],
    remaining: 'Prefer orgx_decide for new clients; keep alias callable.',
  },
  batch_action: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise dry-run bulk lifecycle calls with authenticated MCP.',
  },
  batch_create_entities: {
    tier: 'transport_and_compat',
    evidence: ['tests/batchCreatePayloadContract.spec.ts', 'tests/mcpTransport.spec.ts'],
  },
  batch_delete_entities: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise dry-run delete/validation path with authenticated MCP.',
  },
  check_spawn_guard: {
    tier: 'live_read_verified',
    evidence: ['live orgx_spawn action=guard routed to check_spawn_guard and blocked without task, 2026-05-27', 'tests/agentSpawnBudgetControls.spec.ts'],
  },
  classify_task_model: {
    tier: 'compatibility_alias',
    evidence: ['tests/agentSpawnBudgetControls.spec.ts'],
  },
  comment_on_entity: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; expose or exercise through a profile that registers inline entity comments.',
  },
  complete_plan: {
    tier: 'contract_and_unit',
    evidence: ['tests/planSessionContract.spec.ts'],
  },
  configure_org: {
    tier: 'contract_and_unit',
    evidence: ['tests/configureOrgPolicy.spec.ts'],
  },
  configure_outcome_type: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise with a non-production workspace outcome fixture.',
  },
  consolidate_pr: {
    tier: 'live_blocked_external_auth',
    evidence: ['live consolidate_pr on https://github.com/useorgx/orgx-mcp/pull/206 returned GitHub token unavailable, 2026-05-28', 'tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Configure OrgX server-side GitHub credentials, then rerun against a harmless closed PR fixture.',
  },
  create_decision: {
    tier: 'compatibility_alias',
    evidence: ['tests/decisionToolsContract.spec.ts'],
  },
  create_entity: {
    tier: 'contract_and_unit',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/mcpWorker.toolRegistration.spec.ts'],
  },
  create_milestone: {
    tier: 'contract_and_unit',
    evidence: ['tests/contractTools.spec.ts'],
  },
  create_task: {
    tier: 'contract_and_unit',
    evidence: ['tests/contractTools.spec.ts'],
  },
  delegate_agent_task: {
    tier: 'live_read_verified',
    evidence: ['live delegate_agent_task rejected unknown agent without dispatching work, 2026-05-28', 'tests/toolDiscoverySnapshot.spec.ts'],
  },
  entity_action: {
    tier: 'contract_and_unit',
    evidence: [
      'tests/mcpWorker.entityActionAttach.spec.ts',
      'tests/mcpWorker.entityActionShipBatch.spec.ts',
    ],
  },
  get_active_sessions: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise authenticated read against current workspace sessions.',
  },
  get_agent_status: {
    tier: 'live_read_verified',
    evidence: ['live get_agent_status returned no active agents, 2026-05-28', 'tests/agentStatusPayload.spec.ts', 'tests/agentStatusWidget.spec.ts'],
  },
  get_decision_history: {
    tier: 'transport_and_compat',
    evidence: ['tests/mcpTransport.spec.ts'],
  },
  get_initiative_pulse: {
    tier: 'live_read_verified',
    evidence: ['live get_initiative_pulse e617b132-78dd-4bea-a213-5a841b484ee2, 2026-05-27', 'tests/initiativeWidgetPayload.spec.ts'],
  },
  get_initiative_stream_state: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a scaffolded draft initiative.',
  },
  get_morning_brief: {
    tier: 'live_read_verified',
    evidence: ['live get_morning_brief workspace read, 2026-05-27', 'tests/morningBriefValue.spec.ts'],
  },
  get_operator_chronicle: {
    tier: 'contract_and_unit',
    evidence: ['tests/operatorChronicleFallback.spec.ts', 'tests/reporting.mcp-tools.spec.ts'],
    remaining: 'Live read against prod chronicle endpoint not yet captured.',
  },
  check_execution_readiness: {
    tier: 'contract_and_unit',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Live read against prod credentials/status endpoint not yet captured.',
  },
  manage_lifecycle: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpLifecycleActionAliases.spec.ts'],
    remaining: 'Live lifecycle transition against prod not yet captured.',
  },
  get_my_trust_context: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise authenticated user trust context read.',
  },
  get_org_snapshot: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise authenticated workspace snapshot read.',
  },
  get_outcome_attribution: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise authenticated outcome attribution read.',
  },
  get_pending_decisions: {
    tier: 'transport_and_compat',
    evidence: ['tests/mcpTransport.spec.ts', 'tests/decisionToolsContract.spec.ts'],
  },
  get_relevant_learnings: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise authenticated learning search.',
  },
  get_scoring_signals: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a known initiative scoring fixture.',
  },
  get_task_with_context: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpWorker.taskContextHydrator.spec.ts'],
  },
  handoff_task: {
    tier: 'compatibility_alias',
    evidence: ['tests/agentSpawnBudgetControls.spec.ts'],
  },
  improve_plan: {
    tier: 'contract_and_unit',
    evidence: ['tests/planSessionContract.spec.ts'],
  },
  list_entities: {
    tier: 'contract_and_unit',
    evidence: ['tests/listEntitiesWorkspaceScope.spec.ts', 'live scoped orgx_search task read, 2026-05-27'],
  },
  list_entity_comments: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise after comment_on_entity is exposed or through a profile that registers inline entity comments.',
  },
  orgx_act: {
    tier: 'contract_and_unit',
    evidence: ['live dry_run mutation found and patched, 2026-05-27', 'tests/mcpWorker.toolRegistration.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Re-run orgx_act update dry_run against live MCP after deployment to prove no mutation.',
  },
  orgx_apply_changeset: {
    tier: 'live_read_verified',
    evidence: ['live orgx_apply_changeset task.update run a28c5217..., 2026-05-27', 'tests/toolDiscoverySnapshot.spec.ts', 'tests/reporting.mcp-tools.spec.ts'],
  },
  orgx_attach: {
    tier: 'live_read_verified',
    evidence: ['live artifact 785cb123-9168-46c2-8262-95e8d007f66a attached to initiative, 2026-05-27', 'tests/artifactContracts.spec.ts', 'tests/mcpWorker.entityActionAttach.spec.ts'],
    remaining: 'Re-run live orgx_attach schema/discovery after deployment to verify founder/team artifact examples include the new GTM artifact types.',
  },
  orgx_bootstrap: {
    tier: 'live_read_verified',
    evidence: ['live orgx_bootstrap exposed workspace:null despite workspace_id on server 0.3.0-7fc0bdc0, patched locally 2026-05-27 and rechecked 2026-05-28', 'live orgx_bootstrap still returned workspace:null on server 0.3.0-7fc0bdc0 with workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8, 2026-05-28', 'tests/bootstrapPayload.spec.ts'],
    remaining: 'Re-run live orgx_bootstrap with workspace_id after deployment to verify workspace is bound in the payload.',
  },
  orgx_decide: {
    tier: 'live_read_verified',
    evidence: ['live orgx_decide list_pending found disposable decision a25acdb6-cb60-4400-a11c-63fadd14d0a3 before approval and returned zero pending after approval, 2026-05-28', 'tests/decisionToolsContract.spec.ts'],
  },
  orgx_describe_action: {
    tier: 'public_discovery',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
  },
  orgx_describe_tool: {
    tier: 'contract_and_unit',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
  },
  orgx_emit_activity: {
    tier: 'live_read_verified',
    evidence: ['live events evt_1779925592864_dc7a83cc and evt_1779925941304_8dd45ad4, 2026-05-27', 'tests/toolDiscoverySnapshot.spec.ts'],
  },
  orgx_emit_execution_graph: {
    tier: 'contract_and_unit',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/smitheryMetadata.spec.ts'],
  },
  orgx_poll_question: {
    tier: 'contract_and_unit',
    evidence: [
      'tests/reporting.mcp-tools.spec.ts',
      'tests/mcpWorker.toolRegistration.spec.ts',
    ],
    remaining:
      'Deploy and live-verify a resolved answer receipt resuming Claude Code, Codex, and Cursor sessions.',
  },
  orgx_request_question: {
    tier: 'contract_and_unit',
    evidence: [
      'tests/reporting.mcp-tools.spec.ts',
      'tests/mcpWorker.toolRegistration.spec.ts',
    ],
    remaining:
      'Deploy and live-verify question creation from Claude Code, Codex, and Cursor against the production decision queue.',
  },
  orgx_free_audit: {
    tier: 'contract_and_unit',
    evidence: ['tests/freeAudit.spec.ts'],
  },
  orgx_inspect: {
    tier: 'live_read_verified',
    evidence: ['live initiative inspect, 2026-05-27'],
  },
  orgx_plan: {
    tier: 'live_read_verified',
    evidence: ['live orgx_plan resume b8abfae8-e5d8-4592-8855-adbb816a8204 succeeded but showed workspace_id:null, patched start locally 2026-05-27 and rechecked 2026-05-28', 'tests/planSessionContract.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Re-run live orgx_plan action=start with workspace_id after deployment to verify workspace-scoped plan sessions.',
  },
  orgx_recommend: {
    tier: 'live_read_verified',
    evidence: ['live orgx_recommend initiative read, 2026-05-27'],
  },
  orgx_search: {
    tier: 'live_read_verified',
    evidence: ['live orgx_search scoped task read, 2026-05-27'],
  },
  orgx_spawn: {
    tier: 'live_read_verified',
    evidence: ['live orgx_spawn estimate without dispatch, 2026-05-27', 'live orgx_spawn guard blocked no-task dispatch, 2026-05-27', 'tests/agentSpawnBudgetControls.spec.ts'],
  },
  orgx_submit_receipt: {
    tier: 'live_read_verified',
    evidence: ['live receipts ff98c6e1-96ba-4bd2-83ad-eda79b6204d3 and dbd94570-f8fc-4a61-8abb-cd5660661430'],
  },
  orgx_write: {
    tier: 'live_read_verified',
    evidence: ['live orgx_write restored initiative after dry_run mutation, 2026-05-27', 'live orgx_write created disposable pending decision a25acdb6-cb60-4400-a11c-63fadd14d0a3 with workspace_id on initiative e617b132-78dd-4bea-a213-5a841b484ee2, 2026-05-28', 'tests/descriptionQuality.spec.ts', 'tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Exercise draft-only create path after deployment with workspace_id/goal_ids/milestone rules.',
  },
  pin_workstream: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a draft workstream.',
  },
  query_org_memory: {
    tier: 'live_read_verified',
    evidence: ['live query_org_memory, 2026-05-27'],
  },
  queue_action: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise dry-run queue action if available.',
  },
  recall_memory: {
    tier: 'live_read_verified',
    evidence: ['live recall_memory query, 2026-05-27', 'tests/mcpTransport.spec.ts'],
  },
  recommend_next_action: {
    tier: 'compatibility_alias',
    evidence: ['live orgx_recommend initiative read, 2026-05-27'],
  },
  record_outcome: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise outcome write against a test artifact.',
  },
  record_plan_edit: {
    tier: 'contract_and_unit',
    evidence: ['tests/planSessionContract.spec.ts'],
  },
  record_quality_score: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a draft artifact.',
  },
  reject_decision: {
    tier: 'live_read_verified',
    evidence: ['live reject_decision declined disposable decision 180707dd-448f-47ac-b331-65e7934d27b2, 2026-05-28', 'tests/decisionToolsContract.spec.ts'],
  },
  remember_decision: {
    tier: 'compatibility_alias',
    evidence: ['tests/decisionToolsContract.spec.ts'],
  },
  resume_agent_run: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a resumable non-production run.',
  },
  resume_plan_session: {
    tier: 'contract_and_unit',
    evidence: ['tests/planSessionContract.spec.ts'],
  },
  review_artifact: {
    tier: 'live_read_verified',
    evidence: ['live review_artifact 785cb123-9168-46c2-8262-95e8d007f66a, 2026-05-27', 'tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Exercise approve/reject mutation flow against a disposable draft artifact only when explicitly safe.',
  },
  save_artifact: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/contractTools.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; orgx_attach covers the public v2 artifact path, but this deprecated compatibility wrapper still needs a profile-exposed live call.',
  },
  scaffold_initiative: {
    tier: 'live_read_verified',
    evidence: ['live scaffold e617b132-78dd-4bea-a213-5a841b484ee2', 'live scaffold_initiative mode=draft 7-entity plan, 2026-05-27', 'tests/scaffoldInitiative.spec.ts'],
  },
  score_next_up_queue: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against workspace queue fixture.',
  },
  scoring_config: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise read and write-safe scoring config path.',
  },
  spawn_agent_task: {
    tier: 'live_read_verified',
    evidence: ['live spawn_agent_task rejected unknown agent without dispatching work, 2026-05-28', 'tests/agentSpawnBudgetControls.spec.ts'],
  },
  start_autonomous_session: {
    tier: 'contract_and_unit',
    evidence: ['tests/autonomousSessionBudget.spec.ts'],
    remaining: 'Exercise draft/low-budget guard path only.',
  },
  start_plan_session: {
    tier: 'contract_and_unit',
    evidence: ['tests/planSessionContract.spec.ts'],
  },
  stats: {
    tier: 'public_discovery',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
  },
  submit_learning: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a non-production learning fixture.',
  },
  sync_client_state: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise with a harmless client-state payload.',
  },
  track_project_progress: {
    tier: 'live_read_verified',
    evidence: ['live track_project_progress e617b132-78dd-4bea-a213-5a841b484ee2, 2026-05-27', 'tests/toolDiscoverySnapshot.spec.ts'],
  },
  update_entity: {
    tier: 'contract_and_unit',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts', 'tests/mcpWorker.toolRegistration.spec.ts'],
  },
  update_stream_progress: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise against a draft stream.',
  },
  validate_studio_content: {
    tier: 'local_registered_not_installed_public',
    evidence: ['tests/toolDiscoverySnapshot.spec.ts'],
    remaining: 'Not visible in installed v2 plugin surface on server 0.3.0-7fc0bdc0; exercise with local fixture content.',
  },
  verify_entity_completion: {
    tier: 'contract_and_unit',
    evidence: ['tests/mcpLifecycleActionAliases.spec.ts'],
  },
  workspace: {
    tier: 'contract_and_unit',
    evidence: ['tests/workspaceTool.spec.ts'],
  },
};

const REQUIRED_GTM_ARTIFACT_TYPES = [
  'sales.strategy',
  'sales.icp_offer_sequence',
  'sales.send_plan',
  'sales.conversion_gates',
  'marketing.positioning_brief',
  'marketing.launch_asset',
  'marketing.channel_hypothesis',
  'marketing.proof_distribution_plan',
  'marketing.interview_pr_plan',
] as const;

function collectInlineRegisteredToolIds(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolvePath(here, '..', 'src', 'index.ts');
  const src = readFileSync(indexPath, 'utf8');
  const ids = new Set<string>();
  const re = /this\.server\.registerTool\(\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) ids.add(match[1]!);
  const appRe = /registerAppTool\(\s*this\.server,\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  while ((match = appRe.exec(src))) ids.add(match[1]!);
  return ids;
}

function collectAllToolIds(): string[] {
  const ids = new Set<string>();
  const sources = [
    CHATGPT_TOOL_DEFINITIONS,
    PLAN_SESSION_TOOLS,
    STREAM_TOOL_DEFINITIONS,
    CLIENT_INTEGRATION_TOOL_DEFINITIONS,
    CONTRACT_TOOL_DEFINITIONS,
    FLYWHEEL_TOOL_DEFINITIONS,
  ] as ReadonlyArray<ReadonlyArray<{ id?: string }>>;
  for (const source of sources) {
    for (const tool of source) {
      if (typeof tool.id === 'string') ids.add(tool.id);
    }
  }
  for (const id of collectInlineRegisteredToolIds()) ids.add(id);
  return [...ids].sort();
}

describe('MCP tool coverage matrix', () => {
  it('classifies every registered tool with evidence and explicit remaining work', () => {
    const allToolIds = collectAllToolIds();
    const matrixIds = Object.keys(TOOL_COVERAGE).sort();

    expect(matrixIds).toEqual(allToolIds);

    for (const [toolId, coverage] of Object.entries(TOOL_COVERAGE)) {
      expect(coverage.evidence, `${toolId} must cite test/live evidence`).not.toEqual([]);
      if (coverage.tier === 'schema_only_needs_live_auth') {
        expect(coverage.remaining, `${toolId} needs an explicit live-auth gap`).toBeTruthy();
      }
    }
  });

  it('makes authenticated live gaps queryable instead of hidden in prose', () => {
    const liveAuthGaps = Object.entries(TOOL_COVERAGE)
      .filter(([, coverage]) => Boolean(coverage.remaining))
      .map(([toolId]) => toolId);

    expect(liveAuthGaps).toEqual(expect.arrayContaining([
      'orgx_act',
      'orgx_write',
      'consolidate_pr',
      'validate_studio_content',
    ]));
  });

  it('keeps post-deploy live rechecks executable and mapped to coverage gaps', () => {
    const recheckTools = POST_DEPLOY_RECHECKS.map((recheck) => recheck.tool);
    expect(recheckTools).toEqual([
      'orgx_bootstrap',
      'orgx_plan',
      'orgx_act',
      'orgx_write',
      'orgx_attach',
      'consolidate_pr',
    ]);

    for (const recheck of POST_DEPLOY_RECHECKS) {
      const coverage = TOOL_COVERAGE[recheck.tool];
      expect(coverage, `${recheck.tool} must stay in the coverage matrix`).toBeDefined();
      expect(
        coverage?.remaining,
        `${recheck.tool} must remain explicitly marked until its live probe passes`
      ).toBeTruthy();
      expect(recheck.probe, `${recheck.tool} needs a concrete probe`).toMatch(
        /Call|Inspect/
      );
      expect(recheck.expected, `${recheck.tool} needs a pass condition`).toMatch(
        /schema|Response|Returns|include|unchanged|documents|accepts/i
      );
      expect(recheck.blocks, `${recheck.tool} needs current blocker evidence`).not.toEqual([]);
    }
  });

  it('does not classify hidden local tools as public live-auth gaps', () => {
    const publicToolIds = new Set<string>(V2_PUBLIC_TOOL_IDS);

    for (const [toolId, coverage] of Object.entries(TOOL_COVERAGE)) {
      if (coverage.tier === 'schema_only_needs_live_auth') {
        expect(publicToolIds.has(toolId), `${toolId} should be public-visible`).toBe(true);
      }

      if (coverage.tier === 'local_registered_not_installed_public') {
        expect(publicToolIds.has(toolId), `${toolId} should not be public-visible`).toBe(false);
        expect(coverage.remaining, `${toolId} needs profile/deployment guidance`).toMatch(
          /visible|surface|profile|installed|public|expose|fixture|authenticated|dry-run|workspace|artifact|draft|run|local/i
        );
      }
    }
  });

  it('keeps external-auth blockers distinct from untested public tools', () => {
    for (const [toolId, coverage] of Object.entries(TOOL_COVERAGE)) {
      if (coverage.tier === 'live_blocked_external_auth') {
        expect(coverage.evidence.join(' '), `${toolId} needs live blocker evidence`).toMatch(
          /token|credential|auth|unavailable/i
        );
        expect(coverage.remaining, `${toolId} needs a concrete unblocker`).toMatch(
          /configure|credential|token|rerun/i
        );
      }
    }
  });

  it('treats GTM, sales, and PR mechanics as required receipt artifacts', () => {
    for (const artifactType of REQUIRED_GTM_ARTIFACT_TYPES) {
      expect(FOUNDER_TEAM_ARTIFACT_TYPES).toContain(artifactType);
    }
  });
});
