export const FOUNDER_TEAM_COMPANY_STAGES = [
  'early_founder',
  'founder_led_company',
  'operating_team',
] as const;

export const FOUNDER_TEAM_ARTIFACT_TYPES = [
  'orchestration.next_initiative',
  'eng.pull_request',
  'eng.deploy_proof',
  'eng.structured_blocker',
  'sales.strategy',
  'sales.icp_offer_sequence',
  'sales.send_plan',
  'sales.conversion_gates',
  'marketing.launch_asset',
  'marketing.channel_hypothesis',
  'marketing.positioning_brief',
  'marketing.proof_distribution_plan',
  'marketing.interview_pr_plan',
  'product.customer_discovery',
  'product.prd',
  'product.pricing_hypothesis',
  'product.decision_record',
  'design.audit',
  'design.component_spec',
  'design.token_package',
  'ops.operator_brief',
  'ops.runbook',
  'ops.budget_envelope',
  'ops.incident_status',
  'proof.link',
] as const;

export const FOUNDER_TEAM_ARTIFACT_TYPE_SUMMARY =
  FOUNDER_TEAM_ARTIFACT_TYPES.join(', ');

export type FounderTeamCompanyStage =
  (typeof FOUNDER_TEAM_COMPANY_STAGES)[number];

export type FounderTeamArtifactMetadataInput = {
  agent_type?: string;
  company_stage?: FounderTeamCompanyStage;
  business_outcome?: string;
  owner?: string;
  review_date?: string;
  verification?: string[];
};

export function buildFounderTeamArtifactMetadata(
  input: FounderTeamArtifactMetadataInput
): Record<string, unknown> | null {
  const artifactContract: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      const filtered = value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
      if (filtered.length > 0) artifactContract[key] = filtered;
      continue;
    }

    if (typeof value === 'string' && value.trim()) {
      artifactContract[key] = value.trim();
    }
  }

  return Object.keys(artifactContract).length > 0
    ? { artifact_contract: artifactContract }
    : null;
}
