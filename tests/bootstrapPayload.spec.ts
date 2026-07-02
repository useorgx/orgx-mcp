import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE,
  V2_PUBLIC_TOOL_IDS,
  getBootstrapSafeFirstCalls,
  pickBootstrapWorkspaceFallback,
  resolveBootstrapSessionContext,
} from '../src/bootstrapPayload';

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
];

describe('bootstrap payload routing hints', () => {
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
      'orgx_bootstrap',
      'scaffold_initiative',
      'orgx_inspect',
      'orgx_search',
      'orgx_write',
      'orgx_spawn',
      'orgx_submit_receipt',
    ]);
  });

  it('falls back to full profile safe first calls', () => {
    expect(getBootstrapSafeFirstCalls('unknown-profile')).toBe(
      BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE.full
    );
  });

  it('binds bootstrap workspace_id into session context before payload rendering', () => {
    expect(
      resolveBootstrapSessionContext(
        { workspace_id: ' ws-123 ' },
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
