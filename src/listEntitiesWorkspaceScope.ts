const INITIATIVE_SCOPED_CHILD_TYPES = new Set([
  'milestone',
  'workstream',
  'stream',
  'task',
  'decision',
]);

export function isInitiativeScopedChildListQuery(
  type: string,
  initiativeId: unknown
): boolean {
  return (
    typeof initiativeId === 'string' &&
    initiativeId.trim().length > 0 &&
    INITIATIVE_SCOPED_CHILD_TYPES.has(type)
  );
}

export function resolveListEntitiesWorkspaceScope(args: {
  type: string;
  initiativeId?: unknown;
  explicitWorkspaceId?: string | null;
  explicitCommandCenterId?: string | null;
  sessionWorkspaceId?: string | null;
}): string | null {
  if (args.explicitWorkspaceId) return args.explicitWorkspaceId;
  if (args.explicitCommandCenterId) return args.explicitCommandCenterId;
  if (isInitiativeScopedChildListQuery(args.type, args.initiativeId)) {
    return null;
  }
  return args.sessionWorkspaceId ?? null;
}
