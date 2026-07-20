import { z } from 'zod';

import { getKnownToolContract } from './contractTools';
import { V2_CORE_PUBLIC_SURFACE } from './toolProfiles';

type JsonRecord = Record<string, unknown>;

const CANONICAL_GUIDANCE_TOOLS = new Set<string>(V2_CORE_PUBLIC_SURFACE);
const CALL_LIST_KEYS = new Set([
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

function canonicalizeAlias(
  tool: string,
  args: JsonRecord
): { tool: string; args: JsonRecord } | null {
  switch (tool) {
    case 'list_entities':
      return {
        tool: 'orgx_search',
        args: {
          ...copyDefined(args, [
            'type',
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
          ...copyDefined(args, ['query', 'limit', 'workspace_id', 'session_id']),
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
        args: { operation: 'create', ...args },
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
      return CANONICAL_GUIDANCE_TOOLS.has(tool) ? { tool, args } : null;
  }
}

function callSatisfiesAdvertisedSchema(tool: string, args: JsonRecord): boolean {
  const contract = getKnownToolContract(tool);
  if (!contract?.inputSchema) return false;
  return z.object(contract.inputSchema).passthrough().safeParse(args).success;
}

export function canonicalizeToolCallGuidance(
  value: unknown,
  visibleTools: ReadonlySet<string> | null
): JsonRecord | null {
  const record = asRecord(value);
  if (!record || typeof record.tool !== 'string') return null;
  const rawArgs = asRecord(record.args) ?? asRecord(record.arguments) ?? {};
  const canonical = canonicalizeAlias(record.tool, rawArgs);
  if (!canonical) return null;
  if (!CANONICAL_GUIDANCE_TOOLS.has(canonical.tool)) return null;
  if (visibleTools !== null && !visibleTools.has(canonical.tool)) return null;
  if (!callSatisfiesAdvertisedSchema(canonical.tool, canonical.args)) return null;

  const { arguments: _arguments, args: _args, tool: _tool, ...rest } = record;
  return { ...rest, tool: canonical.tool, args: canonical.args };
}

function sanitizeValue(
  value: unknown,
  visibleTools: ReadonlySet<string> | null,
  parentKey?: string
): unknown {
  if (Array.isArray(value)) {
    if (parentKey && CALL_LIST_KEYS.has(parentKey)) {
      return value
        .map((item) => canonicalizeToolCallGuidance(item, visibleTools))
        .filter((item): item is JsonRecord => item !== null);
    }
    return value.map((item) => sanitizeValue(item, visibleTools));
  }

  const record = asRecord(value);
  if (!record) return value;

  if (parentKey && CALL_KEYS.has(parentKey)) {
    return canonicalizeToolCallGuidance(record, visibleTools);
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
                  CANONICAL_GUIDANCE_TOOLS.has(tool) &&
                  (visibleTools === null || visibleTools.has(tool))
              )
            : [],
        ])
      );
      continue;
    }
    result[key] = sanitizeValue(child, visibleTools, key);
  }
  return result;
}

/**
 * Remove dead or profile-invisible breadcrumbs from a tool result and rewrite
 * compatibility aliases to canonical v2 operations. This is intentionally
 * applied at the registration boundary so inline, widget, and contract tools
 * cannot bypass profile negotiation.
 */
export function sanitizeToolResultGuidance<
  T extends { structuredContent?: unknown } | null | undefined,
>(result: T, visibleTools: ReadonlySet<string> | null): T {
  if (!result || typeof result !== 'object') return result;
  if (result.structuredContent === undefined) return result;
  return {
    ...result,
    structuredContent: sanitizeValue(result.structuredContent, visibleTools),
  } as T;
}
