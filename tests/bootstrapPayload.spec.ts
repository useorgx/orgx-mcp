import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE,
  V2_PUBLIC_TOOL_IDS,
  getBootstrapSafeFirstCalls,
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
});
