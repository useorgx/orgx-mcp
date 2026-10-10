import { DEPRECATED_TOOL_IDS } from './deprecatedTools';
import { getPublicOperationContracts } from './publicOperationContracts';
import { RECEIPT_OPERATION_TOOLS } from './receiptOperationTools';
import { WIDGET_ONLY_TOOL_IDS } from './widgetToolContract';
import { EXTENDED_WORKFLOW_TOOL_IDS, WORKFLOW_TOOL_IDS } from './workflowTools';

/** Wire contract versions are independent of the Worker, plugin and receipt versions. */
export const MCP_OPERATION_CONTRACT_VERSION = 'orgx-mcp-operations/1';
export const MCP_LEGACY_CONTRACT_VERSION = 'orgx-mcp-legacy/1';
export const MCP_COMPATIBILITY_CONTRACT_VERSIONS = [
  MCP_OPERATION_CONTRACT_VERSION, MCP_LEGACY_CONTRACT_VERSION, 'unknown',
] as const;

export const MCP_COMPATIBILITY_MAPPING_STATUSES = [
  'none', 'retained', 'mapped', 'unsupported', 'unknown',
] as const;
export type McpCompatibilityMappingStatus = typeof MCP_COMPATIBILITY_MAPPING_STATUSES[number];
export const MCP_COMPATIBILITY_OUTCOMES = ['attempt', 'success', 'error'] as const;
export const MCP_COMPATIBILITY_NAMESPACES = [
  'none', 'mcp__orgx__', 'mcp__orgx-mcp__', 'orgx-mcp', 'orgx', 'other',
] as const;

export const MCP_COMPATIBILITY_TOOL_IDS = new Set([
  ...getPublicOperationContracts().map((tool) => tool.id),
  ...DEPRECATED_TOOL_IDS,
]);
const currentToolIds = new Set<string>([
  ...WORKFLOW_TOOL_IDS, ...EXTENDED_WORKFLOW_TOOL_IDS,
  ...RECEIPT_OPERATION_TOOLS.map((tool) => tool.id),
  ...WIDGET_ONLY_TOOL_IDS, 'orgx_record_plan_edit',
]);
const legacyProfiles = new Set([
  'legacy', 'claude-directory-legacy', 'claude-code-legacy', 'claude-plugin', 'memory', 'commander',
  'executor', 'observer', 'planner', 'reviewer', 'full',
]);
export const MCP_COMPATIBILITY_LEGACY_ACTIONS = [
  'start', 'resume', 'improve', 'record_edit', 'complete', 'create', 'update',
  'delete', 'read', 'list', 'get', 'attach', 'detach', 'approve', 'reject',
  'launch', 'pause', 'retry', 'cancel', 'archive', 'restore', 'auto_run',
  'ship', 'ship_batch', 'capture', 'list_pending', 'list_history', 'estimate',
  'spawn', 'guard', 'classify', 'validate', 'set', 'stop', 'complete_plan',
] as const;
const legacyActions = new Set<string>(MCP_COMPATIBILITY_LEGACY_ACTIONS);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function knownNamespace(name: string): { id: string; namespace: string; wireName: string } | null {
  for (const [pattern, namespace] of [
    [/^mcp__orgx-mcp__/i, 'mcp__orgx-mcp__'],
    [/^mcp__orgx__/i, 'mcp__orgx__'],
    [/^orgx-mcp[._:/-]/i, 'orgx-mcp'],
    [/^orgx[.:/-]/i, 'orgx'],
  ] as const) {
    if (!pattern.test(name)) continue;
    const id = name.replace(pattern, '');
    if (!MCP_COMPATIBILITY_TOOL_IDS.has(id)) return null;
    // Preserve the recognizable namespace without arbitrary case or user text.
    return { id, namespace, wireName: name.slice(0, name.length - id.length).toLowerCase() + id };
  }
  return MCP_COMPATIBILITY_TOOL_IDS.has(name)
    ? { id: name, namespace: 'none', wireName: name } : null;
}

/** No arbitrary names, credentials, arguments or unknown prefixes cross the analytics boundary. */
export function boundedMcpCompatibilityToolId(value: unknown, preserveNamespace = false): string {
  if (typeof value !== 'string') return 'other';
  const result = knownNamespace(value);
  return result ? preserveNamespace ? result.wireName : result.id : 'other';
}

export function boundedMcpCompatibilityMappingId(value: unknown): string {
  if (value === 'none') return 'none';
  if (typeof value !== 'string' || value.length > 200) return 'other';
  const [source, target, extra] = value.split('=>');
  return extra === undefined && source && target &&
    MCP_COMPATIBILITY_TOOL_IDS.has(source) && MCP_COMPATIBILITY_TOOL_IDS.has(target)
    ? value : 'other';
}

export function isLegacyMcpToolId(toolId: unknown): boolean {
  const bounded = boundedMcpCompatibilityToolId(toolId);
  return bounded !== 'other' && !currentToolIds.has(bounded);
}

export function inferMcpContractVersion(profile?: string | null): string {
  return profile && legacyProfiles.has(profile)
    ? MCP_LEGACY_CONTRACT_VERSION : MCP_OPERATION_CONTRACT_VERSION;
}

export type McpCompatibilityMetadataInput = {
  requestedToolId: unknown;
  normalizedToolId: unknown;
  executedToolId?: unknown;
  /** Handler registration identity, distinct from a transport-remapped identity. */
  registeredToolId?: unknown;
  profile: string;
  contractVersion?: string | null;
  mappingId?: string;
  mappingStatus?: McpCompatibilityMappingStatus;
  outcome?: typeof MCP_COMPATIBILITY_OUTCOMES[number];
  legacyAction?: unknown;
};

/**
 * Spread these labels FIRST in invocation metadata. The existing OrgX intake
 * has a 32-field limit; transport timing fields must not displace migration evidence.
 * This function classifies observations only and never authorizes or routes a call.
 */
export function buildMcpCompatibilityMetadata(input: McpCompatibilityMetadataInput): Record<string, string | boolean> {
  const requested = knownNamespace(typeof input.requestedToolId === 'string' ? input.requestedToolId : '');
  const normalized = boundedMcpCompatibilityToolId(input.normalizedToolId);
  const executed = input.executedToolId === undefined ? normalized
    : boundedMcpCompatibilityToolId(input.executedToolId);
  const inferredStatus = normalized === 'other' || executed === 'other' ? 'unknown'
    : normalized !== executed ? 'mapped'
      : isLegacyMcpToolId(normalized) ? 'retained' : 'none';
  const contractVersion = MCP_COMPATIBILITY_CONTRACT_VERSIONS.includes(
    input.contractVersion as typeof MCP_COMPATIBILITY_CONTRACT_VERSIONS[number]
  ) ? input.contractVersion! : input.contractVersion ? 'unknown' : inferMcpContractVersion(input.profile);
  const mappingStatus = input.mappingStatus && MCP_COMPATIBILITY_MAPPING_STATUSES.includes(input.mappingStatus)
    ? input.mappingStatus : inferredStatus;
  const mappingId = input.mappingId !== undefined
    ? boundedMcpCompatibilityMappingId(input.mappingId)
    : normalized !== executed && normalized !== 'other' && executed !== 'other'
      ? `${normalized}=>${executed}` : 'none';
  return {
    requested_tool_id: requested?.wireName ?? 'other',
    normalized_tool_id: normalized,
    executed_tool_id: executed,
    ...(input.registeredToolId === undefined ? {} : {
      registered_tool_id: boundedMcpCompatibilityToolId(input.registeredToolId),
    }),
    operation_contract_version: contractVersion,
    compatibility_mapping_status: mappingStatus,
    compatibility_mapping_id: mappingId,
    compatibility_outcome: input.outcome && MCP_COMPATIBILITY_OUTCOMES.includes(input.outcome) ? input.outcome : 'attempt',
    tool_namespace: requested?.namespace ?? 'other',
    ...(input.legacyAction === undefined ? {} : {
      legacy_action: typeof input.legacyAction === 'string' && legacyActions.has(input.legacyAction) ? input.legacyAction : 'other',
    }),
    legacy_tool_call: contractVersion === MCP_LEGACY_CONTRACT_VERSION ||
      isLegacyMcpToolId(normalized) || isLegacyMcpToolId(executed) ||
      (mappingStatus !== 'none'),
    // Profile is already resolved at the authorization boundary; privacy sanitization
    // still bounds it to the declared inventory before sending to analytics.
    profile: input.profile,
  };
}

export type McpCompatibilityInvocation = {
  occurredAt: string;
  toolId: string;
  clientName: string | null;
  clientVersion: string | null;
  mcpSessionId: string | null;
  status: 'success' | 'error';
  metadata: Record<string, unknown>;
};

/** Accept the existing durable agent_tool_invocations row shape. */
export function parseMcpCompatibilityInvocationRow(value: unknown): McpCompatibilityInvocation | null {
  const row = asRecord(value);
  const occurredAt = typeof row.created_at === 'string' ? row.created_at : '';
  if (!Number.isFinite(Date.parse(occurredAt)) || typeof row.tool_id !== 'string' ||
    (row.status !== 'success' && row.status !== 'error')) return null;
  const stringOrNull = (item: unknown) => typeof item === 'string' ? item : null;
  return {
    occurredAt, toolId: row.tool_id, clientName: stringOrNull(row.client_name),
    clientVersion: stringOrNull(row.client_version), mcpSessionId: stringOrNull(row.mcp_session_id),
    status: row.status, metadata: asRecord(row.metadata),
  };
}

/** Missing legacy markers on historical rows are conservative, never proof of inactivity. */
export function isMcpCompatibilityActivity(invocation: McpCompatibilityInvocation): boolean {
  const meta = invocation.metadata;
  if (meta.legacy_tool_call === true) return true;
  if (meta.operation_contract_version === MCP_LEGACY_CONTRACT_VERSION ||
    meta.operation_contract_version === 'unknown') return true;
  if (typeof meta.profile === 'string' && legacyProfiles.has(meta.profile)) return true;
  if (typeof meta.compatibility_mapping_status === 'string' &&
    meta.compatibility_mapping_status !== 'none') return true;
  const names = [invocation.toolId, meta.requested_tool_id, meta.normalized_tool_id,
    meta.executed_tool_id, meta.registered_tool_id].filter((value) => value !== undefined);
  if (names.some((value) => boundedMcpCompatibilityToolId(value) === 'other' || isLegacyMcpToolId(value))) return true;
  // A previous v2 orgx_search row is not evidence that the new catalog was used.
  return meta.operation_contract_version !== MCP_OPERATION_CONTRACT_VERSION;
}
