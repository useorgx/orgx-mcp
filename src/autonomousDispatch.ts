import { z } from 'zod';

/** A caller may narrow credential authority, never opt out of inherited policy. */
export const autonomousSpawnSchema = z.literal(true).optional().describe(
  'Set true for unattended or scheduled work. Narrows execution to the existing autonomous credential policy; never grants org-key fallback or additional effects. False is not supported and cannot clear inherited restrictions.'
);

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;

/** Read the existing backend tool catalog; a generic boolean is not this contract. */
export function backendSupportsAutonomousSpawn(catalog: unknown): boolean {
  const tools = record(catalog)?.tools;
  if (!Array.isArray(tools)) return false;
  const entries = tools.map(record).filter((tool): tool is RecordValue =>
    Boolean(tool && (tool.id === 'chatgpt.spawn_agent_task' || tool.id === 'spawn_agent_task'))
  );
  if (entries.length !== 1) return false;
  const properties = record(record(entries[0].parameters)?.properties);
  const field = record(properties?.autonomous);
  if (field?.type !== 'boolean') return false;
  const hasConst = Object.hasOwn(field, 'const');
  const hasEnum = Object.hasOwn(field, 'enum');
  return (hasConst || hasEnum) &&
    (!hasConst || field.const === true) &&
    (!hasEnum || (Array.isArray(field.enum) && field.enum.length === 1 && field.enum[0] === true));
}

export async function checkAutonomousSpawnSupport(
  args: RecordValue,
  loadCatalog: () => Promise<unknown>
): Promise<{ ok: true } | { ok: false; message: string; details: RecordValue }> {
  if (args.autonomous === undefined) return { ok: true };
  if (args.autonomous !== true) {
    return { ok: false, message: 'autonomous must be the literal true; omit it for ordinary work.',
      details: { code: 'invalid_autonomous_declaration' } };
  }
  try {
    if (backendSupportsAutonomousSpawn(await loadCatalog())) return { ok: true };
  } catch {
    // Unavailable discovery cannot prove that the app will enforce the flag.
  }
  return {
    ok: false,
    message: 'The OrgX backend has not confirmed autonomous credential narrowing support. No work was dispatched.',
    details: { code: 'autonomous_dispatch_unsupported', required_backend_tool: 'chatgpt.spawn_agent_task',
      required_field: 'autonomous', required_value: true },
  };
}
