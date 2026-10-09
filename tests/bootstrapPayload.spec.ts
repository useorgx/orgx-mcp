import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE,
  CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS,
  LEGACY_BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  LEGACY_CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS,
  V2_PUBLIC_TOOL_IDS,
  buildBootstrapToolRouting,
  getBootstrapRecommendedWorkflows,
  getBootstrapSafeFirstCalls,
  pickBootstrapWorkspaceFallback,
  resolveBootstrapSessionContext,
  resolveBootstrapSessionModel,
} from '../src/bootstrapPayload';
import { CLAUDE_DIRECTORY_SURFACE, resolveProfileToolSet } from '../src/toolProfiles';
import { isWidgetOnlyTool } from '../src/widgetToolContract';

const DEPRECATED_BOOTSTRAP_GUIDANCE = [
  'workspace',
  'get_org_snapshot',
  'query_org_memory',
  'get_active_sessions',
  'sync_client_state',
  'start_plan_session',
  'improve_plan',
  'record_plan_edit',
  'complete_plan',
  'get_task_with_context',
  'check_spawn_guard',
  'spawn_agent_task',
  'orgx_plan', 'orgx_spawn', 'orgx_write', 'orgx_act', 'orgx_decide', 'manage_lifecycle',
];

describe('bootstrap payload routing hints', () => {
  it('routes directory planning, execution, decisions, and proof through its visible operation contracts', () => {
    const visibleTools = CLAUDE_DIRECTORY_SURFACE.filter((tool) => !isWidgetOnlyTool(tool));
    const routing = buildBootstrapToolRouting({
      requestedProfile: 'claude-directory', visibleTools,
      widgetOnlyTools: CLAUDE_DIRECTORY_SURFACE.filter(isWidgetOnlyTool),
    });
    expect(routing.recommended_workflows).toEqual(CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS);
    expect(routing.recommended_workflows.execute_task).toContain('orgx_start_agent_task');
    expect(routing.recommended_workflows.plan_feature).toContain('orgx_complete_plan');
    expect(routing.recommended_workflows.human_decision_review).toEqual([
      'orgx_list_pending_decisions', 'orgx_open_decision_review',
    ]);
    expect(Object.values(routing.recommended_workflows).flat()).not.toContain('resume_agent_run');
    for (const call of routing.safe_first_calls) {
      expect(['orgx_get_workspace_context', 'orgx_search', 'orgx_get_operator_brief']).toContain(call.tool);
    }
  });

  it('omits unauthorized directory writes from every bootstrap workflow', () => {
    const visible = new Set(['orgx_search', 'orgx_inspect', 'orgx_read_plan', 'orgx_list_pending_decisions']);
    const workflows = getBootstrapRecommendedWorkflows(visible, 'claude-directory');
    expect(workflows.plan_feature).toEqual(['orgx_read_plan']);
    expect(workflows.human_decision_review).toEqual(['orgx_list_pending_decisions']);
    expect(workflows.control_execution).toEqual([]);
    for (const tool of Object.values(workflows).flat()) expect(visible.has(tool)).toBe(true);
  });

  it('shares current workflow stages across hosts while filtering every operation to the negotiated inventory', () => {
    const canonical = getBootstrapRecommendedWorkflows();
    for (const profile of ['chatgpt', 'v2', 'claude-directory', 'extended']) {
      expect(getBootstrapRecommendedWorkflows(null, profile)).toEqual(canonical);
    }
    expect(Object.values(canonical).flat()).not.toContain('orgx_delegate_work');
    expect(Object.values(canonical).flat()).toContain('orgx_start_plan');
    for (const tool of Object.values(getBootstrapRecommendedWorkflows(null, 'read-only')).flat()) {
      expect(resolveProfileToolSet('read-only')?.has(tool), tool).toBe(true);
    }
    expect(getBootstrapRecommendedWorkflows(null, 'read-only').control_execution).toEqual(['orgx_get_agent_status', 'orgx_get_operation_status']);
  });

  it('preserves original router and historical directory workflows under explicit compatibility profiles', () => {
    expect(getBootstrapRecommendedWorkflows(null, 'legacy')).toEqual(LEGACY_BOOTSTRAP_RECOMMENDED_WORKFLOWS);
    expect(getBootstrapRecommendedWorkflows(null, 'claude-directory-legacy')).toEqual(LEGACY_CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS);
    const plugin = getBootstrapRecommendedWorkflows(null, 'claude-plugin');
    for (const tool of Object.values(plugin).flat()) expect(resolveProfileToolSet('claude-plugin')?.has(tool), tool).toBe(true);
    expect(Object.values(plugin).flat()).not.toContain('orgx_spawn');
  });

  it('advertises only v2 tools in safe first calls', () => {
    const publicTools = new Set<string>(V2_PUBLIC_TOOL_IDS);

    for (const calls of Object.values(BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE)) {
      for (const call of calls) {
        expect(publicTools.has(call.tool), `${call.tool} should be a v2 tool`).toBe(true);
        expect(DEPRECATED_BOOTSTRAP_GUIDANCE).not.toContain(call.tool);
      }
    }
  });

  it('advertises only v2 tools in recommended workflows', () => {
    const publicTools = new Set<string>(V2_PUBLIC_TOOL_IDS);
    const workflows = Object.values(BOOTSTRAP_RECOMMENDED_WORKFLOWS).flat();

    for (const tool of workflows) {
      expect(publicTools.has(tool), `${tool} should be a v2 tool`).toBe(true);
      expect(DEPRECATED_BOOTSTRAP_GUIDANCE).not.toContain(tool);
    }
  });

  it('advertises the scaffold hierarchy workflow agents need for chaining', () => {
    expect(BOOTSTRAP_RECOMMENDED_WORKFLOWS.scaffold_hierarchy).toEqual([
      'orgx_get_workspace_context',
      'orgx_start_plan',
      'orgx_save_plan',
      'orgx_validate_initiative_plan',
      'orgx_create_initiative_hierarchy',
      'orgx_inspect',
      'orgx_validate_work_receipt',
      'orgx_submit_work_receipt',
    ]);
  });

  it('fails unknown profiles closed to the current informational guidance', () => {
    expect(getBootstrapSafeFirstCalls('unknown-profile')).toEqual(
      BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE['read-only']
    );
  });

  it('binds bootstrap workspace_id into session context before payload rendering', () => {
    expect(
      resolveBootstrapSessionContext(
        { workspace_id: ' ws-123 ', initiative_id: 'init-1' },
        { initiativeId: 'init-1' },
        'Revenue Ops'
      )
    ).toEqual({
      requestedWorkspaceId: 'ws-123',
      changed: true,
      context: {
        workspaceId: 'ws-123',
        workspaceName: 'Revenue Ops',
        initiativeId: 'init-1',
      },
    });
  });

  it('binds bootstrap command_center_id as a legacy workspace alias', () => {
    expect(
      resolveBootstrapSessionContext(
        { command_center_id: ' ws-legacy ' },
        {},
        'Legacy Workspace'
      )
    ).toEqual({
      requestedWorkspaceId: 'ws-legacy',
      changed: true,
      context: {
        workspaceId: 'ws-legacy',
        workspaceName: 'Legacy Workspace',
      },
    });
  });

  it('clears stale workspace names when bootstrap switches workspaces without a fetched name', () => {
    expect(
      resolveBootstrapSessionContext(
        { workspace_id: 'ws-2' },
        { workspaceId: 'ws-1', workspaceName: 'Old Workspace' }
      )
    ).toEqual({
      requestedWorkspaceId: 'ws-2',
      changed: true,
      context: {
        workspaceId: 'ws-2',
      },
    });
  });

  it('binds an explicit initiative into the current workspace context', () => {
    expect(
      resolveBootstrapSessionContext(
        { initiative_id: ' init-2 ' },
        { workspaceId: 'ws-1', initiativeId: 'init-1' }
      )
    ).toEqual({
      requestedWorkspaceId: null,
      changed: true,
      context: {
        workspaceId: 'ws-1',
        initiativeId: 'init-2',
      },
    });
  });

  it('clears a stale initiative when bootstrap switches workspaces without one', () => {
    expect(
      resolveBootstrapSessionContext(
        { workspace_id: 'ws-2' },
        {
          workspaceId: 'ws-1',
          workspaceName: 'Old Workspace',
          initiativeId: 'init-old',
        },
        'New Workspace'
      )
    ).toEqual({
      requestedWorkspaceId: 'ws-2',
      changed: true,
      context: {
        workspaceId: 'ws-2',
        workspaceName: 'New Workspace',
      },
    });
  });

  it('falls back to the default workspace from accessible workspace candidates', () => {
    expect(
      pickBootstrapWorkspaceFallback([
        { id: 'ws-1', name: 'First Workspace' },
        { id: 'ws-2', title: 'Default Workspace', is_default: true },
      ])
    ).toEqual({
      workspaceId: 'ws-2',
      workspaceName: 'Default Workspace',
    });
  });

  it('falls back to a sole accessible workspace when no default is marked', () => {
    expect(
      pickBootstrapWorkspaceFallback([{ id: 'ws-only', name: 'Only Workspace' }])
    ).toEqual({
      workspaceId: 'ws-only',
      workspaceName: 'Only Workspace',
    });
  });

  it('does not fallback-bind an ambiguous workspace list', () => {
    expect(
      pickBootstrapWorkspaceFallback([
        { id: 'ws-1', name: 'First Workspace' },
        { id: 'ws-2', name: 'Second Workspace' },
      ])
    ).toBeNull();
  });

  it('picks the marked default even when buried in canary/test workspaces', () => {
    // Reproduces the account shape that broke the live scaffold demo: the
    // workspace list is mostly canary/test/proof harnesses, with the real
    // workspace flagged as default. Resolution must find it, not give up.
    expect(
      pickBootstrapWorkspaceFallback([
        { id: 'ws-canary-1', name: 'canary-harness' },
        { id: 'ws-test-2', name: 'proof-fixture' },
        { id: 'ws-prod', name: 'OrgX', is_default: true },
        { id: 'ws-test-3', name: 'e2e-canary' },
      ])
    ).toEqual({ workspaceId: 'ws-prod', workspaceName: 'OrgX' });
  });

  it('keeps workspace as the canonical bootstrap entity type', () => {
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const bootstrapBranch = indexSource.match(
      /case 'orgx_bootstrap': \{[\s\S]*?case 'orgx_inspect':/
    )?.[0];

    expect(bootstrapBranch).toContain("'workspace'");
    expect(bootstrapBranch).not.toContain("'command_center'");
  });

  it('scaffold_initiative auto-resolves a missing workspace like bootstrap does', () => {
    // Regression: scaffold_initiative used to hard-fail with
    // missing_workspace_context whenever the session had no workspace bound
    // (e.g. the agent scaffolded before running orgx_bootstrap). It must now
    // run the same resolution ladder so "create an initiative" just works.
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    // Scope to the scaffold_initiative handler body: from its tool
    // registration to the start of the next registerAppTool call.
    const scaffoldStart = indexSource.indexOf("      'scaffold_initiative',");
    const nextRegister = indexSource.indexOf(
      'registerAppTool(',
      scaffoldStart + 1
    );
    const scaffoldBranch =
      scaffoldStart > -1 && nextRegister > scaffoldStart
        ? indexSource.slice(scaffoldStart, nextRegister)
        : undefined;

    expect(scaffoldBranch).toBeTruthy();
    // Resolution runs before the missing-workspace hard-fail, and binds the
    // inferred workspace into the session for subsequent tools.
    expect(scaffoldBranch).toContain('inferSessionWorkspace');
    expect(scaffoldBranch).toContain('workspace_auto_resolved');
    const inferIdx = scaffoldBranch!.indexOf('inferSessionWorkspace');
    const failIdx = scaffoldBranch!.indexOf("error_kind: 'missing_workspace_context'");
    expect(inferIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeGreaterThan(inferIdx);

    // The shared resolver reuses the bootstrap ladder rather than reinventing it.
    const inferHelper = indexSource.match(
      /private async inferSessionWorkspace[\s\S]*?\n  }\n/
    )?.[0];
    expect(inferHelper).toContain('fetchClientBootstrapWorkspace');
    expect(inferHelper).toContain('pickBootstrapWorkspaceFallback');
  });

  it('bootstrap delegates default workspace selection to the app bootstrap route', () => {
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const bootstrapBranch = indexSource.match(
      /case 'orgx_bootstrap': \{[\s\S]*?case 'orgx_inspect':/
    )?.[0];
    const bootstrapWorkspaceHelper = indexSource.match(
      /private async fetchClientBootstrapWorkspace[\s\S]*?private async recordMcpActivationObservation/
    )?.[0];

    expect(bootstrapBranch).toContain('fetchClientBootstrapWorkspace');
    expect(bootstrapBranch).toContain('pickBootstrapWorkspaceFallback');
    expect(bootstrapBranch).toContain("type: 'workspace'");
    expect(bootstrapWorkspaceHelper).toContain(
      '/api/client/bootstrap?source_client=mcp'
    );
    expect(bootstrapWorkspaceHelper).not.toContain('if (!userId) return null');
  });
});

describe('resolveBootstrapSessionModel', () => {
  it('records the model named at bootstrap', () => {
    expect(resolveBootstrapSessionModel({ model: ' claude-opus-5-5 ' }, {})).toEqual({ model: 'claude-opus-5-5', changed: true });
    expect(resolveBootstrapSessionModel({ model: 'x', model_provider: 'acme' }, {})).toEqual({ model: 'x', modelProvider: 'acme', changed: true });
  });
  it('keeps the session model when a later bootstrap names none', () => {
    expect(resolveBootstrapSessionModel({ workspace_id: 'ws' }, { model: 'gpt-6-luna', modelProvider: 'openai' })).toEqual({ model: 'gpt-6-luna', modelProvider: 'openai', changed: false });
  });
  it('is unchanged when the same model is named again', () => {
    expect(resolveBootstrapSessionModel({ model: 'gpt-6-luna' }, { model: 'gpt-6-luna', modelProvider: 'openai' })).toEqual({ model: 'gpt-6-luna', modelProvider: 'openai', changed: false });
  });
  it('drops the old provider when a different model is named', () => {
    expect(resolveBootstrapSessionModel({ model: 'claude-sonnet-5' }, { model: 'my-finetune', modelProvider: 'acme' })).toEqual({ model: 'claude-sonnet-5', changed: true });
  });
});
