import { z } from 'zod';

import { getKnownToolContract } from './contractTools';
import { getClaudeDirectoryToolContract } from './claudeDirectoryTools';
import { getPublicOperationContract } from './publicOperationContracts';
import { resolveProfileToolSet } from './toolProfiles';
import { isWidgetOnlyTool } from './widgetToolContract';

type JsonRecord = Record<string, unknown>;

/** Boolean callers retain their API; actual profile names disambiguate legacy schemas. */
type GuidanceProfile = string | boolean;
const profileName = (profile: GuidanceProfile) => typeof profile === 'string'
  ? profile
  : profile ? 'claude-directory' : 'v2';

function isAvailable(tool: string, visibleTools: ReadonlySet<string> | null, profile: GuidanceProfile): boolean {
  const inventory = resolveProfileToolSet(profileName(profile));
  return !isWidgetOnlyTool(tool) && (inventory === null || inventory.has(tool)) &&
    (visibleTools === null || visibleTools.has(tool));
}
const CALL_LIST_KEYS = new Set([
  'next_calls',
  'safe_first_calls',
  'suggested_next_calls',
  'preferred_next_calls',
]);
const CALL_KEYS = new Set(['next_call', 'next_action']);
const WORKFLOW_KEYS = new Set(['recommended_workflows']);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function copyDefined(
  source: JsonRecord,
  keys: readonly string[]
): JsonRecord {
  const result: JsonRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function canonicalizeLegacyAlias(
  tool: string,
  args: JsonRecord,
): { tool: string; args: JsonRecord } | null {
  switch (tool) {
    case 'list_entities':
      return {
        tool: 'orgx_search',
        args: {
          ...copyDefined(args, [
            'type',
            'created_from',
            'created_to',
            'status',
            'initiative_id',
            'workspace_id',
            'limit',
            'offset',
            'cursor',
            'fields',
            'session_id',
          ]),
          ...(args.search !== undefined ? { query: args.search } : {}),
        },
      };
    case 'query_org_memory':
    case 'recall_memory': {
      const scope = typeof args.scope === 'string' ? args.scope : 'all';
      const type =
        scope === 'decisions'
          ? 'decision'
          : scope === 'artifacts'
          ? 'artifact'
          : scope === 'initiatives'
          ? 'initiative'
          : undefined;
      return {
        tool: 'orgx_search',
        args: {
          ...copyDefined(args, ['query', 'limit', 'workspace_id', 'session_id', 'created_from', 'created_to']),
          ...(type ? { type } : {}),
        },
      };
    }
    case 'recommend_next_action':
      return {
        tool: 'orgx_recommend',
        args: {
          mode: 'next_action',
          ...copyDefined(args, ['entity_type', 'limit', 'workspace_id', 'session_id']),
          ...(args.entity_id !== undefined ? { entity_id: args.entity_id } : {}),
        },
      };
    case 'get_morning_brief':
    case 'get_operator_chronicle':
      return {
        tool: 'orgx_recommend',
        args: {
          mode: 'morning_brief',
          period: args.period ?? '30d',
          ...copyDefined(args, ['workspace_id', 'session_id']),
        },
      };
    case 'get_initiative_pulse':
    case 'track_project_progress':
      return {
        tool: 'orgx_recommend',
        args: {
          mode: 'next_action',
          entity_type: 'initiative',
          ...(args.initiative_id !== undefined
            ? { entity_id: args.initiative_id }
            : {}),
          ...copyDefined(args, ['workspace_id', 'limit', 'session_id']),
        },
      };
    case 'get_pending_decisions':
      return {
        tool: 'orgx_decide',
        args: {
          action: 'list_pending',
          ...copyDefined(args, ['initiative_id', 'workspace_id', 'session_id']),
        },
      };
    case 'approve_agent_work':
      if (args.action === 'list' || args.action === undefined) {
        return {
          tool: 'orgx_decide',
          args: {
            action: 'list_pending',
            ...copyDefined(args, ['initiative_id', 'workspace_id', 'session_id']),
          },
        };
      }
      return null;
    case 'approve_decision':
      return {
        tool: 'orgx_decide',
        args: {
          action: 'approve',
          ...copyDefined(args, ['decision_id', 'note', 'idempotency_key', 'session_id']),
        },
      };
    case 'reject_decision':
      return {
        tool: 'orgx_decide',
        args: {
          action: 'reject',
          ...copyDefined(args, [
            'decision_id',
            'reason',
            'idempotency_key',
            'session_id',
          ]),
        },
      };
    case 'create_entity':
      return {
        tool: 'orgx_write',
        args: { ...args, operation: 'create' },
      };
    case 'entity_action':
      return {
        tool: 'orgx_act',
        args: {
          ...args,
          ...(args.entity_id !== undefined && args.id === undefined
            ? { id: args.entity_id }
            : {}),
        },
      };
    default:
      return null;
  }
}

function canonicalizeOperationAlias(tool: string, args: JsonRecord): { tool: string; args: JsonRecord } | null {
  switch (tool) {
    case 'orgx_recommend':
      if (args.mode !== undefined && !['morning_brief', 'next_action'].includes(String(args.mode))) return null;
      return args.mode === 'morning_brief'
        ? { tool: 'orgx_get_operator_brief', args: copyDefined(args, ['workspace_id', 'period']) }
        : { tool: 'orgx_get_next_actions', args: copyDefined(args, ['entity_type', 'entity_id', 'initiative_id', 'workspace_id', 'limit', 'session_id']) };
    case 'recommend_next_action':
      return { tool: 'orgx_get_next_actions', args: copyDefined(args, ['entity_type', 'entity_id', 'initiative_id', 'workspace_id', 'limit', 'session_id']) };
    case 'get_morning_brief':
    case 'get_operator_chronicle':
      return { tool: 'orgx_get_operator_brief', args: { period: args.period ?? '30d', ...copyDefined(args, ['workspace_id']) } };
    case 'get_agent_status':
      return { tool: 'orgx_get_agent_status', args: copyDefined(args, ['agent_id', 'workspace_id', 'initiative_id', 'include_idle']) };
    case 'get_initiative_pulse':
    case 'track_project_progress':
      return { tool: 'orgx_get_initiative_progress', args: copyDefined(args, ['initiative_id']) };
    case 'orgx_command_status':
      return { tool: 'orgx_get_operation_status', args: copyDefined(args, ['operation_id', 'kind', 'id']) };
    case 'check_execution_readiness':
      return { tool: 'orgx_check_execution_readiness', args: copyDefined(args, ['workspace_id']) };
    case 'get_pending_decisions':
      return { tool: 'orgx_list_pending_decisions', args: copyDefined(args, ['initiative_id', 'workspace_id', 'session_id']) };
    case 'approve_agent_work':
      return args.action === 'list' || args.action === undefined
        ? { tool: 'orgx_list_pending_decisions', args: copyDefined(args, ['initiative_id', 'workspace_id', 'session_id']) }
        : null;
    case 'approve_decision':
    case 'reject_decision':
      return { tool: 'orgx_open_decision_review', args: copyDefined(args, ['decision_id', 'workspace_id']) };
    case 'create_entity':
    case 'orgx_write': {
      const { type, operation, ...fields } = args;
      if (tool === 'orgx_write' && operation === 'update') return { tool: 'orgx_update_work', args: { ...fields, type } };
      if (operation !== undefined && operation !== 'create') return null;
      return typeof type === 'string' && ['initiative', 'workstream', 'milestone', 'task'].includes(type)
        ? { tool: `orgx_create_${type}`, args: fields }
        : null;
    }
    case 'orgx_plan': {
      const { action, ...fields } = args;
      if (action === 'start') {
        const { feature_name, ...rest } = fields;
        return { tool: 'orgx_start_plan', args: { ...rest, title: feature_name } };
      }
      const target = { resume: 'orgx_read_plan', record_edit: 'orgx_record_plan_edit', complete: 'orgx_complete_plan', improve: 'orgx_request_plan_critique' }[String(action)];
      return target ? { tool: target, args: fields } : null;
    }
    case 'orgx_spawn': {
      const { action, ...fields } = args;
      if (action === 'estimate') {
        const { task_id, title, instructions, ...scope } = fields;
        return { tool: 'orgx_estimate_agent_task', args: { ...scope, task: task_id ? { task_id } : { title, ...(instructions ? { instructions } : {}) } } };
      }
      const target = { spawn: 'orgx_start_agent_task', handoff: 'orgx_handoff_task', guard: 'orgx_check_agent_delegation', classify: 'orgx_classify_agent_task' }[String(action)];
      return target ? { tool: target, args: fields } : null;
    }
    case 'orgx_decide': {
      const { action, ...fields } = args;
      if (action === 'approve' || action === 'reject') return { tool: 'orgx_open_decision_review', args: copyDefined(fields, ['decision_id', 'workspace_id']) };
      const target = { list_pending: 'orgx_list_pending_decisions', remember: 'orgx_capture_decision', create: 'orgx_create_decision' }[String(action)];
      return target ? { tool: target, args: fields } : null;
    }
    case 'manage_lifecycle': {
      const { action, ...fields } = args;
      return ['pause', 'resume', 'retry', 'cancel'].includes(String(action))
        ? { tool: `orgx_${action}_work`, args: fields }
        : null;
    }
    case 'entity_action':
    case 'orgx_act': {
      const { action, type, id, entity_id, ...fields } = args;
      const targetId = id ?? entity_id;
      if (action === 'launch' && type === 'initiative') return { tool: 'orgx_launch_initiative', args: { ...fields, initiative_id: targetId } };
      if (['pause', 'resume', 'retry', 'cancel'].includes(String(action))) return { tool: `orgx_${action}_work`, args: { level: type, id: targetId } };
      if (action === 'complete_with_proof') return { tool: 'orgx_complete_work_with_proof', args: { ...fields, type, id: targetId } };
      return typeof action === 'string' ? { tool: `orgx_${action}_work`, args: { ...fields, type, id: targetId } } : null;
    }
    default:
      return null;
  }
}

function callSatisfiesAdvertisedSchema(tool: string, args: JsonRecord, profile: GuidanceProfile): boolean {
  const adapter = profileName(profile) === 'claude-directory-legacy' ? getClaudeDirectoryToolContract(tool) : undefined;
  const contract = adapter ?? getPublicOperationContract(tool) ?? getKnownToolContract(tool);
  if (!contract?.inputSchema) return false;
  const schema = z.object(contract.inputSchema);
  if (tool === 'orgx_get_operation_status' && !args.operation_id && !(args.kind && args.id)) return false;
  const strict = adapter || !('source' in contract);
  return (strict ? schema.strict() : schema.passthrough()).safeParse(args).success;
}

export function canonicalizeToolCallGuidance(
  value: unknown,
  visibleTools: ReadonlySet<string> | null,
  profile: GuidanceProfile = false
): JsonRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.tool !== 'string') return null;
  const rawArgs = asRecord(record.args) ?? asRecord(record.arguments) ?? {};
  const candidates = [
    { tool: record.tool, args: rawArgs },
    canonicalizeOperationAlias(record.tool, rawArgs),
    canonicalizeLegacyAlias(record.tool, rawArgs),
  ];
  const canonical = candidates.find((candidate) => candidate &&
    isAvailable(candidate.tool, visibleTools, profile) &&
    callSatisfiesAdvertisedSchema(candidate.tool, candidate.args, profile));
  if (!canonical) return null;

  const { arguments: _arguments, args: _args, tool: _tool, ...rest } = record;
  return { ...rest, tool: canonical.tool, args: canonical.args };
}

function sanitizeValue(
  value: unknown,
  visibleTools: ReadonlySet<string> | null,
  profile: GuidanceProfile,
  parentKey?: string
): unknown {
  if (Array.isArray(value)) {
    if (parentKey && CALL_LIST_KEYS.has(parentKey)) {
      return value
        .map((item) => canonicalizeToolCallGuidance(item, visibleTools, profile))
        .filter((item): item is JsonRecord => item !== null);
    }
    return value.map((item) => sanitizeValue(item, visibleTools, profile));
  }

  const record = asRecord(value);
  if (!record) return value;

  // `next_action` also carries a scored business recommendation or activation
  // state. Only objects declaring a tool are call breadcrumbs. Treating every
  // recommendation as a call erased valid next-action data to null.
  if (parentKey && CALL_KEYS.has(parentKey) &&
    (parentKey === 'next_call' || Object.hasOwn(record, 'tool'))) {
    return canonicalizeToolCallGuidance(record, visibleTools, profile);
  }

  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(record)) {
    if (WORKFLOW_KEYS.has(key)) {
      const workflows = asRecord(child);
      if (!workflows) continue;
      result[key] = Object.fromEntries(
        Object.entries(workflows).map(([name, tools]) => [
          name,
          Array.isArray(tools)
            ? tools.filter(
                (tool): tool is string =>
                  typeof tool === 'string' &&
                  isAvailable(tool, visibleTools, profile) &&
                  Boolean(getPublicOperationContract(tool) || getClaudeDirectoryToolContract(tool))
              )
            : [],
        ])
      );
      continue;
    }
    result[key] = sanitizeValue(child, visibleTools, profile, key);
  }
  return result;
}

/**
 * Remove dead or profile-invisible breadcrumbs from a tool result and rewrite
 * compatibility aliases to the visible, advertised operation. This is intentionally
 * applied at the registration boundary so inline, widget, and contract tools
 * cannot bypass profile negotiation.
 */
export function sanitizeToolResultGuidance<
  T extends { structuredContent?: unknown } | null | undefined,
>(result: T, visibleTools: ReadonlySet<string> | null, profile: GuidanceProfile = false): T {
  if (!result || typeof result !== 'object') return result;
  if (result.structuredContent === undefined) return result;
  return {
    ...result,
    structuredContent: sanitizeValue(result.structuredContent, visibleTools, profile),
  } as T;
}
