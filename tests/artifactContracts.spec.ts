import { describe, expect, it } from 'vitest';

import {
  buildFounderTeamArtifactMetadata,
  FOUNDER_TEAM_ARTIFACT_TYPES,
} from '../src/artifactContracts';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';

describe('founder/team artifact contracts', () => {
  it('keeps practical artifact types available across every OrgX agent domain', () => {
    expect(FOUNDER_TEAM_ARTIFACT_TYPES).toEqual(
      expect.arrayContaining([
        'orchestration.next_initiative',
        'eng.pull_request',
        'eng.deploy_proof',
        'sales.strategy',
        'sales.conversion_gates',
        'sales.send_plan',
        'marketing.launch_asset',
        'marketing.positioning_brief',
        'marketing.proof_distribution_plan',
        'marketing.interview_pr_plan',
        'product.customer_discovery',
        'product.pricing_hypothesis',
        'design.audit',
        'ops.operator_brief',
        'ops.budget_envelope',
      ])
    );
  });

  it('compacts founder/team receipt metadata without empty fields', () => {
    expect(
      buildFounderTeamArtifactMetadata({
        agent_type: ' sales ',
        company_stage: 'early_founder',
        business_outcome: ' Start founder-led sales ',
        owner: '',
        review_date: '2026-05-27',
        verification: [' ICP reviewed ', '', 'sequence drafted'],
      })
    ).toEqual({
      artifact_contract: {
        agent_type: 'sales',
        company_stage: 'early_founder',
        business_outcome: 'Start founder-led sales',
        review_date: '2026-05-27',
        verification: ['ICP reviewed', 'sequence drafted'],
      },
    });
  });

  it('surfaces artifact contract fields in attach and receipt tool schemas', () => {
    const attach = CONTRACT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'orgx_attach'
    );
    const receipt = CONTRACT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'orgx_submit_receipt'
    );

    expect(attach?.inputSchema).toHaveProperty('business_outcome');
    expect(attach?.inputSchema).toHaveProperty('company_stage');
    expect(attach?.inputSchema).toHaveProperty('verification');
    expect(JSON.stringify(attach)).toContain('sales.strategy');

    expect(receipt?.inputSchema).toHaveProperty('artifact_type');
    expect(receipt?.inputSchema).toHaveProperty('business_outcome');
    expect(receipt?.inputSchema).toHaveProperty('verification_status');
    expect(JSON.stringify(receipt)).toContain('ops.operator_brief');
  });
});
