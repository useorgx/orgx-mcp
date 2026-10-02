/**
 * Argument aliases callers really send.
 *
 * Clients built against an older or neighbouring tool shape send a different
 * argument name for the same thing (live QA, 2026-10-02): `reason` for a
 * handoff note, `initiative_id` for a recommendation scope, `initiativeId` /
 * `initiative` for the bootstrap binding. Zod strips unknown keys, so those
 * calls silently lost the value. Each alias is declared on the tool's input
 * schema (so the host keeps it) and mapped here onto the canonical argument.
 *
 * Rules: an explicit canonical argument always wins; an alias never
 * overwrites one. Aliases are removed after mapping so downstream handlers see
 * one shape.
 */

type Args = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function withoutKeys(args: Args, keys: readonly string[]): Args {
  const next: Args = { ...args };
  for (const key of keys) delete next[key];
  return next;
}

function mapInitiativeScope(args: Args): Args {
  const initiativeId = nonEmptyString(args.initiative_id);
  if (!initiativeId) return args;
  const rest = withoutKeys(args, ['initiative_id']);
  // An explicit entity scope wins; the shortcut only fills an empty one.
  if (nonEmptyString(args.entity_id) || nonEmptyString(args.entity_type)) {
    return rest;
  }
  return { ...rest, entity_type: 'initiative', entity_id: initiativeId };
}

const ALIAS_MAPPERS: Record<string, (args: Args) => Args> = {
  // handoff_task: `reason` → `note`.
  handoff_task: (args) => {
    const reason = nonEmptyString(args.reason);
    const rest = withoutKeys(args, ['reason']);
    if (!reason || nonEmptyString(args.note)) return rest;
    return { ...rest, note: reason };
  },
  // orgx_recommend / recommend_next_action: `initiative_id` →
  // entity_type="initiative" + entity_id.
  orgx_recommend: mapInitiativeScope,
  recommend_next_action: mapInitiativeScope,
  // orgx_bootstrap: `initiativeId` / `initiative` → `initiative_id`.
  orgx_bootstrap: (args) => {
    const alias = nonEmptyString(args.initiativeId) ?? nonEmptyString(args.initiative);
    const rest = withoutKeys(args, ['initiativeId', 'initiative']);
    if (!alias || nonEmptyString(args.initiative_id)) return rest;
    return { ...rest, initiative_id: alias };
  },
};

export const TOOLS_WITH_ARGUMENT_ALIASES = Object.freeze(
  Object.keys(ALIAS_MAPPERS)
);

export function applyToolArgumentAliases(toolId: string, args: Args): Args {
  const mapper = Object.prototype.hasOwnProperty.call(ALIAS_MAPPERS, toolId)
    ? ALIAS_MAPPERS[toolId]
    : undefined;
  return mapper && args && typeof args === 'object' ? mapper(args) : args;
}
