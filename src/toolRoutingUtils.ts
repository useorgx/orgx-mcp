export type ToolArgs = Record<string, unknown>;

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function compactArgs(args: ToolArgs): ToolArgs {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );
}
