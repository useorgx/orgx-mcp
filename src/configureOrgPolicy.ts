export const CONFIGURE_ORG_POLICY_TYPES = [
  'approvals',
  'notifications',
  'working_hours',
  'budget',
  'artifact_collection',
] as const;

export type ConfigureOrgPolicyType =
  (typeof CONFIGURE_ORG_POLICY_TYPES)[number];

export function resolveConfigureOrgWorkspaceId(args: {
  workspace_id?: unknown;
  command_center_id?: unknown;
}, sessionWorkspaceId?: string | null): {
  workspaceId: string | null;
  error: string | null;
} {
  const explicitWorkspaceId =
    typeof args.workspace_id === 'string' && args.workspace_id.trim().length > 0
      ? args.workspace_id.trim()
      : null;
  const aliasWorkspaceId =
    typeof args.command_center_id === 'string' &&
    args.command_center_id.trim().length > 0
      ? args.command_center_id.trim()
      : null;

  if (
    explicitWorkspaceId &&
    aliasWorkspaceId &&
    explicitWorkspaceId !== aliasWorkspaceId
  ) {
    return {
      workspaceId: null,
      error: 'workspace_id and command_center_id must match when both are provided',
    };
  }

  return {
    workspaceId:
      explicitWorkspaceId ??
      aliasWorkspaceId ??
      (typeof sessionWorkspaceId === 'string' && sessionWorkspaceId.trim().length > 0
        ? sessionWorkspaceId.trim()
        : null),
    error: null,
  };
}

export function describeAppliedPolicy(
  policyType: unknown,
  config: unknown,
  workspaceId?: string | null
): string {
  const scopeText = workspaceId ? ` for workspace ${workspaceId}` : '';
  if (policyType !== 'artifact_collection') {
    return `✓ Applied ${String(policyType)} policy${scopeText}`;
  }

  const configRecord =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  const mode =
    typeof configRecord.mode === 'string' && configRecord.mode.trim().length > 0
      ? configRecord.mode.trim()
      : 'full';
  return `✓ Applied artifact collection policy${scopeText} (${mode} mode)`;
}
