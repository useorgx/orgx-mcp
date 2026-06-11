import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE,
  V2_PUBLIC_TOOL_IDS,
  getBootstrapSafeFirstCalls,
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

  it('keeps workspace as the canonical bootstrap entity type', () => {
    const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const bootstrapBranch = indexSource.match(
      /case 'orgx_bootstrap': \{[\s\S]*?case 'orgx_inspect':/
    )?.[0];

    expect(bootstrapBranch).toContain("'workspace'");
    expect(bootstrapBranch).not.toContain("'command_center'");
  });
});
