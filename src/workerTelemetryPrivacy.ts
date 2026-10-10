import {
  CHATGPT_TOOL_DEFINITIONS, PLAN_SESSION_TOOLS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS, STREAM_TOOL_DEFINITIONS,
} from './toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS, INLINE_TOOL_CONTRACTS } from './contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from './flywheelTools';
import { OAUTH_SCOPES_SUPPORTED } from './authorizationPolicy';
import { MCP_ACTIVATION_MILESTONES } from './mcpActivationTracker';
import { TOOL_PROFILE_NAMES } from './toolProfiles';
import { DEPRECATED_TOOL_IDS } from './deprecatedTools';
import {
  boundedMcpCompatibilityMappingId, boundedMcpCompatibilityToolId,
  MCP_COMPATIBILITY_CONTRACT_VERSIONS, MCP_COMPATIBILITY_MAPPING_STATUSES,
  MCP_COMPATIBILITY_NAMESPACES, MCP_COMPATIBILITY_OUTCOMES,
  MCP_COMPATIBILITY_LEGACY_ACTIONS, MCP_COMPATIBILITY_TOOL_IDS,
} from './mcpCompatibility';

const toolIds = new Set([
  ...CHATGPT_TOOL_DEFINITIONS, ...PLAN_SESSION_TOOLS,
  ...CLIENT_INTEGRATION_TOOL_DEFINITIONS, ...STREAM_TOOL_DEFINITIONS,
  ...CONTRACT_TOOL_DEFINITIONS, ...FLYWHEEL_TOOL_DEFINITIONS,
].map((tool) => tool.id));
Object.keys(INLINE_TOOL_CONTRACTS).forEach((id) => toolIds.add(id));
toolIds.add('orgx_lease');
DEPRECATED_TOOL_IDS.forEach((id) => toolIds.add(id));
MCP_COMPATIBILITY_TOOL_IDS.forEach((id) => toolIds.add(id));
const telemetryScopes = [...OAUTH_SCOPES_SUPPORTED, 'mcp:all', 'mcp:read', 'mcp:write'];

const entityTypes = ['agent', 'artifact', 'decision', 'initiative', 'milestone',
  'objective', 'plan_session', 'run', 'task', 'workspace', 'workstream'];
const errorCodes = ['authentication_required', 'auth_required', 'auth_failed',
  'forbidden', 'permission_denied', 'scope_required', 'insufficient_scope',
  'entity_not_found', 'not_found', 'invalid_input', 'invalid_request',
  'jsonrpc_error', 'mcp_tool_error', 'mcp_transport_error', 'exception',
  'exception_error', 'exception_typeerror', 'exception_aborterror',
  'timeout', 'rate_limit_exceeded', 'upstream_error', 'server_error',
  'workspace_context_missing', 'search_backend_error', 'invalid_search_response', 'spawn_guard_blocked',
  'launch_silent_no_op', 'invalid_scope', 'authorization', 'credential_missing',
  'scaffold_initiative_failed', 'mcp_identity_mismatch', 'billing_scaffold_limit_reached',
  'missing_workspace_context', 'unknown'];
const clients = ['openai-mcp (Codex)', 'openai-mcp', 'codex', 'chatgpt', 'openai',
  'claude', 'claude-code', 'claude_code', 'cursor', 'vscode', 'vs-code',
  'opencode', 'open-code', 'openclaw', 'openclaw-plugin', 'goose', 'api',
  'web', 'web-ui', 'webapp', 'mcp-probe', 'agent-scout', 'brick.blue'];
const enumProperties: Record<string, readonly string[]> = {
  status: ['success', 'error'],
  tool_family: ['chatgpt', 'stream', 'plan_session', 'client_integration', 'bootstrap',
    'scaffold', 'entity_write', 'activity', 'entity_action', 'agent_dispatch', 'decision', 'receipt', 'read', 'mcp_tool'],
  auth_source: ['request', 'session', 'none'],
  source_client: ['claude', 'codex', 'chatgpt', 'cursor', 'vscode', 'goose',
    'opencode', 'openclaw', 'api', 'webapp', 'other'],
  client_name: clients,
  client_name_source: ['initialize_handshake', 'tool_context'],
  client_platform: ['linux', 'macos', 'windows', 'web', 'ios', 'android', 'api'],
  profile: TOOL_PROFILE_NAMES,
  entity_type: entityTypes,
  action: ['start', 'resume', 'improve', 'record_edit', 'complete', 'create',
    'update', 'delete', 'list', 'read', 'get', 'attach', 'detach', 'approve',
    'reject', 'launch', 'pause', 'archive', 'restore', 'auto_run', 'ship', 'ship_batch'],
  replacement_action: ['list', 'auto_run', 'complete_plan'],
  operation_contract_version: MCP_COMPATIBILITY_CONTRACT_VERSIONS,
  compatibility_mapping_status: MCP_COMPATIBILITY_MAPPING_STATUSES,
  compatibility_outcome: MCP_COMPATIBILITY_OUTCOMES,
  tool_namespace: MCP_COMPATIBILITY_NAMESPACES,
  legacy_action: [...MCP_COMPATIBILITY_LEGACY_ACTIONS, 'other'],
  deprecation_retirement_policy: ['coordinated-upgrade'],
  error_kind: errorCodes,
  error_code: errorCodes,
  journey_phase: ['complete'],
  response_size_source: ['body_clone', 'content_length', 'unavailable'],
  response_measurement_point: ['worker_response_clone'],
  edge_rate_limit_source: ['upstash', 'memory', 'bypass'],
  edge_rate_limit_degraded: ['upstash_unavailable'],
  edge_rate_limit_strategy: ['preflight_bypass', 'base_allowance', 'free_limit',
    'paid_allowance', 'enterprise_bypass'],
  search_outcome: ['results', 'empty', 'missing_results'],
  search_scope: ['all', 'artifacts', 'decisions', 'initiatives', 'unknown', 'other'],
  search_mode: ['typed_collection', 'mixed_relevance', 'memory_hybrid', 'unknown'],
  search_delivery_code: ['rendered', 'response_timeout', 'incomplete_response', 'tool_error', 'page_error'],
  widget_protocol: ['chatgpt', 'mcp-apps', 'mcp-apps-sdk'],
  activation_stage: Object.keys(MCP_ACTIVATION_MILESTONES),
  activation_label: Object.values(MCP_ACTIVATION_MILESTONES).map((stage) => stage.label),
  activation_track: ['mcp-skills'],
  provider_requested: ['openai', 'anthropic', 'google', 'azure', 'bedrock', 'local'],
  provider_used: ['openai', 'anthropic', 'google', 'azure', 'bedrock', 'local'],
};
const numericProperties = new Set([
  'latency_ms', 'http_status', 'argument_count', 'estimated_argument_bytes',
  'step_index', 'auth_ms', 'session_ms', 'request_normalization_ms', 'handler_ms',
  'response_headers_ms', 'response_shaping_ms', 'first_response_byte_ms',
  'full_response_ms', 'response_size_bytes', 'response_size_header_bytes',
  'edge_rate_limit_ms', 'edge_rate_limit_backend_ms', 'edge_rate_limit_identity_ms',
  'edge_rate_limit_billing_ms', 'tokens_used', 'cost_usd', 'estimated_cost_usd',
  'search_result_count', 'search_missing_title_count', 'task_count', 'deprecation_window_days',
  'deprecation_min_quiet_days',
]);
const booleanProperties = new Set([
  'has_user_id', 'has_workspace_id', 'has_initiative_id', 'has_workstream_id',
  'has_task_id', 'has_conversation_id', 'has_working_directory',
  'followed_expected_next_tool', 'response_read_error', 'response_parse_truncated',
  'mcp_logical_error', 'session_present', 'ok', 'is_widget_tool',
  'provider_mismatch', 'routed',
  'legacy_tool_call',
  'mcp_response_observed',
]);
const uuidProperties = new Set(['workspace_id', 'initiative_id', 'request_uuid',
  'attempt_id', 'connection_id', 'event_id']);
const toolProperties = new Set(['tool_id', 'previous_tool_id', 'expected_next_tool_id',
  'previous_expected_next_tool_id', 'deprecated_tool_id', 'replacement_tool_id',
  'normalized_tool_id', 'executed_tool_id', 'registered_tool_id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][a-z0-9.-]{1,40})?$/i;

/**
 * Analytics is a closed property boundary. Raw errors, validation paths,
 * conversation/JSON-RPC IDs, prompts, argument names/values, and arbitrary
 * nested data stay out of PostHog. Unknown labels become bounded "other".
 */
export function sanitizeWorkerTelemetryProperties(
  properties: Record<string, unknown> = {}
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    if (numericProperties.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    } else if (booleanProperties.has(key)) {
      if (typeof value === 'boolean') result[key] = value;
    } else if (uuidProperties.has(key)) {
      if (typeof value === 'string' && UUID.test(value)) result[key] = value;
    } else if (key === 'requested_tool_id') {
      result[key] = boundedMcpCompatibilityToolId(value, true);
    } else if (key === 'compatibility_mapping_id') {
      result[key] = boundedMcpCompatibilityMappingId(value);
    } else if (toolProperties.has(key)) {
      if (typeof value === 'string') result[key] = toolIds.has(value) ? value : 'other';
    } else if (key === 'client_version') {
      if (typeof value === 'string' && VERSION.test(value)) result[key] = value;
    } else if (key === 'auth_scope') {
      if (typeof value === 'string') {
        const scopes = value.split(/\s+/).filter(Boolean);
        if (scopes.length && scopes.every((scope) => telemetryScopes.includes(scope))) {
          result[key] = scopes.join(' ');
        }
      }
    } else if (key === 'search_results_by_type' && typeof value === 'object' && !Array.isArray(value)) {
      const counts: Record<string, number> = {};
      for (const [type, count] of Object.entries(value as Record<string, unknown>)) {
        if ([...entityTypes, 'other', 'unknown'].includes(type) &&
          typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[type] = count;
      }
      result[key] = counts;
    } else if (enumProperties[key] && typeof value === 'string') {
      result[key] = enumProperties[key].includes(value) ? value : 'other';
      // JSON-RPC and HTTP numeric errors have a closed, non-free-text format.
      if ((key === 'error_code' || key === 'error_kind') && /^(?:-32\d{3}|http_[1-5]\d{2})$/.test(value)) {
        result[key] = value;
      }
    } else if (key === 'deprecation_sunset_at' &&
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      result[key] = value;
    }
  }
  return result;
}
