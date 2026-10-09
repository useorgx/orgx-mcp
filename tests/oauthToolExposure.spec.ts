import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { checkAuthRequirements } from '../src/authHelpers';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';

const publicToolIds = serverManifest.tools.map((tool) => tool.name);

function visibleTools(scopes: readonly string[]) {
  return publicToolIds.filter((toolId) => {
    const contract = getPublicOperationContract(toolId);
    if (!contract?.securitySchemes) return false;
    return checkAuthRequirements(contract.securitySchemes, 'oauth-user', scopes).isAuthorized;
  });
}

describe('OAuth-aware MCP operation exposure', () => {
  it('gives every public operation an explicit scoped contract, except payload-only validation', () => {
    for (const toolId of publicToolIds) {
      const contract = getPublicOperationContract(toolId);
      expect(contract, `${toolId} is missing from the actual operation catalog`).not.toBeNull();
      expect(contract?.securitySchemes, `${toolId} has no authorization scheme`).toBeTruthy();
      const noauth = contract?.securitySchemes?.some((scheme) => scheme.type === 'noauth');
      if (toolId === 'orgx_validate_work_receipt') {
        expect(contract?.securitySchemes).toEqual([{ type: 'noauth' }]);
        expect(contract?.annotations).toMatchObject({ readOnlyHint: true });
        expect(contract?.inputSchema).not.toHaveProperty('workspace_id');
        expect(contract?.inputSchema).not.toHaveProperty('receipt_id');
      } else {
        expect(noauth, `${toolId} exposes private OrgX data through noauth`).toBe(false);
        const oauth = contract?.securitySchemes?.filter((scheme) => scheme.type === 'oauth2');
        expect(oauth?.length, `${toolId} has no OAuth grant`).toBeGreaterThan(0);
        expect(oauth?.every((scheme) => (scheme.scopes?.length ?? 0) > 0), `${toolId} uses an unscoped grant`).toBe(true);
      }
    }
  });

  it('advertises only payload validation for an explicit empty grant', () => {
    expect(visibleTools([])).toEqual(['orgx_validate_work_receipt']);
  });

  it('exposes named reads and keeps domain writes out of the Read preset', () => {
    const visible = visibleTools(AUTHORIZATION_PRESETS.read.scopes);
    for (const tool of ['orgx_search', 'orgx_inspect', 'orgx_read_plan', 'orgx_list_pending_decisions', 'orgx_estimate_agent_task', 'orgx_list_work_receipts']) {
      expect(visible, tool).toContain(tool);
    }
    for (const tool of ['orgx_create_task', 'orgx_update_work', 'orgx_start_plan', 'orgx_save_plan', 'orgx_complete_plan', 'orgx_capture_decision', 'orgx_start_agent_task', 'orgx_handoff_task', 'orgx_launch_initiative', 'orgx_submit_work_receipt', 'orgx_widget_approve_artifact']) {
      expect(visible, tool).not.toContain(tool);
    }
    for (const router of ['orgx_write', 'orgx_spawn', 'orgx_decide', 'orgx_plan', 'approve_decision', 'scaffold_initiative']) expect(visible).not.toContain(router);
  });

  it('keeps narrow custom read grants inside their selected domains', () => {
    const decisions = visibleTools(['decisions:read']);
    expect(decisions).toContain('orgx_search');
    expect(decisions).toContain('orgx_inspect');
    expect(decisions).toContain('orgx_list_pending_decisions');
    expect(decisions).not.toContain('orgx_get_agent_status');
    expect(decisions).not.toContain('orgx_get_initiative_progress');
    expect(decisions).not.toContain('orgx_capture_decision');

    const memory = visibleTools(['memory:read']);
    expect(memory).toContain('orgx_search');
    expect(memory).toContain('orgx_inspect');
    expect(memory).not.toContain('orgx_list_pending_decisions');
    expect(memory).not.toContain('orgx_get_agent_status');
    expect(memory).not.toContain('orgx_get_initiative_progress');
  });

  it('exposes the complete published surface to the Operate preset', () => {
    expect(visibleTools(AUTHORIZATION_PRESETS.operate.scopes).sort()).toEqual([...publicToolIds].sort());
  });

  it('requires every scope for a named multi-resource handoff', () => {
    const contract = getPublicOperationContract('orgx_handoff_task');
    expect(contract?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['agents:write', 'initiatives:write'] }]);
    for (const [granted, missing] of [['agents:write', 'initiatives:write'], ['initiatives:write', 'agents:write']]) {
      expect(checkAuthRequirements(contract?.securitySchemes, 'oauth-user', [granted!])).toMatchObject({
        isAuthorized: false, missingScopeAlternatives: [[missing]],
      });
    }
    expect(checkAuthRequirements(contract?.securitySchemes, 'oauth-user', ['agents:write', 'initiatives:write']).isAuthorized).toBe(true);
  });

  it('does not substitute a write grant from another domain', () => {
    const decisions = visibleTools(['decisions:write']);
    expect(decisions).toContain('orgx_capture_decision');
    expect(decisions).not.toContain('orgx_create_initiative');
    expect(decisions).not.toContain('orgx_start_plan');
    const initiatives = visibleTools(['initiatives:write']);
    expect(initiatives).toContain('orgx_create_initiative');
    expect(initiatives).toContain('orgx_start_plan');
    expect(initiatives).not.toContain('orgx_capture_decision');
    expect(initiatives).not.toContain('orgx_handoff_task');
  });
});
