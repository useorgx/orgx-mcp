import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { checkAuthRequirements } from '../src/authHelpers';
import { getKnownToolContract } from '../src/contractTools';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';

const publicToolIds = serverManifest.tools.map((tool) => tool.name);

function visibleTools(scopes: readonly string[]) {
  return publicToolIds.filter((toolId) => {
    const contract = getKnownToolContract(toolId);
    if (!contract?.securitySchemes) return false;
    return checkAuthRequirements(
      contract.securitySchemes,
      'oauth-user',
      scopes
    ).isAuthorized;
  });
}

describe('OAuth-aware MCP tool exposure', () => {
  it('gives every public tool an explicit authorization contract', () => {
    for (const toolId of publicToolIds) {
      const contract = getKnownToolContract(toolId);
      expect(contract, `${toolId} is missing from the tool catalog`).not.toBeNull();
      expect(
        contract?.securitySchemes,
        `${toolId} has no authorization scheme`
      ).toBeTruthy();
      const oauthSchemes = contract?.securitySchemes?.filter(
        (scheme) => scheme.type === 'oauth2'
      );
      expect(
        contract?.securitySchemes?.some((scheme) => scheme.type === 'noauth'),
        `${toolId} exposes private OrgX data through noauth`
      ).toBe(false);
      expect(
        oauthSchemes?.every((scheme) => (scheme.scopes?.length ?? 0) > 0),
        `${toolId} uses an unscoped authenticated grant`
      ).toBe(true);
    }
  });

  it('advertises no private tools for an explicit empty grant', () => {
    expect(visibleTools([])).toEqual([]);
  });

  it('keeps mutating tools out of the Read preset', () => {
    const visible = visibleTools(AUTHORIZATION_PRESETS.read.scopes);

    expect(visible).toContain('orgx_search');
    expect(visible).toContain('orgx_inspect');
    expect(visible).toContain('recall_memory');
    expect(visible).not.toContain('orgx_write');
    // Action-polymorphic tools stay discoverable for their read operations;
    // invocation policy blocks spawn/approve actions without write grants.
    expect(visible).toContain('orgx_spawn');
    expect(visible).toContain('orgx_decide');
    expect(visible).toContain('orgx_plan');
    expect(visible).not.toContain('approve_decision');
    expect(visible).not.toContain('scaffold_initiative');
  });

  it('keeps narrow custom grants inside their selected domains', () => {
    const decisions = visibleTools(['decisions:read']);
    expect(decisions).toContain('orgx_search');
    expect(decisions).toContain('orgx_inspect');
    expect(decisions).toContain('orgx_decide');
    expect(decisions).not.toContain('get_agent_status');
    expect(decisions).not.toContain('query_org_memory');
    expect(decisions).not.toContain('get_initiative_pulse');

    const memory = visibleTools(['memory:read']);
    expect(memory).toContain('query_org_memory');
    expect(memory).toContain('recall_memory');
    expect(memory).not.toContain('get_agent_status');
    expect(memory).not.toContain('get_initiative_pulse');
  });

  it('exposes the complete published surface to the Operate preset', () => {
    expect(visibleTools(AUTHORIZATION_PRESETS.operate.scopes).sort()).toEqual(
      [...publicToolIds].sort()
    );
  });

  it('requires every scope for a multi-resource handoff', () => {
    const contract = getKnownToolContract('handoff_task');
    expect(
      checkAuthRequirements(
        contract?.securitySchemes,
        'oauth-user',
        ['agents:write']
      )
    ).toMatchObject({
      isAuthorized: false,
      missingScopeAlternatives: [['initiatives:write']],
    });

    const compactContract = getKnownToolContract('orgx_spawn');
    expect(compactContract?.description).toContain(
      'BOTH agents:write and initiatives:write'
    );
    expect(compactContract?.securitySchemes).toContainEqual({
      type: 'oauth2',
      scopes: ['agents:write', 'initiatives:write'],
    });
  });
});
