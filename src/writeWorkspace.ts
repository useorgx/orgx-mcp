/**
 * Which workspace a create (decision, task, milestone) writes into.
 *
 * Tool contracts say workspace_id "defaults to the MCP session's workspace".
 * A fresh session that skipped orgx_bootstrap has none bound, so the ladder is:
 * explicit workspace_id, then the deprecated command_center_id alias, then the
 * session binding, then an inferred workspace (the app's active workspace, else
 * the caller's single default), which the caller should bind to the session.
 * Null means no unambiguous choice exists; the caller must ask, never guess.
 */
export type WriteWorkspace =
  | { workspaceId: string; source: 'explicit' | 'session' }
  | { workspaceId: string; source: 'inferred'; name: string | null }
  | { workspaceId: null; source: 'none' };

const trimmed = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export async function resolveWriteWorkspace(input: {
  args: Record<string, unknown>;
  sessionWorkspaceId: string | null | undefined;
  infer: () => Promise<{ id: string; name: string | null } | null>;
}): Promise<WriteWorkspace> {
  const explicit = trimmed(input.args.workspace_id) ?? trimmed(input.args.command_center_id);
  if (explicit) return { workspaceId: explicit, source: 'explicit' };
  const session = trimmed(input.sessionWorkspaceId);
  if (session) return { workspaceId: session, source: 'session' };
  const inferred = await input.infer();
  if (inferred?.id) return { workspaceId: inferred.id, source: 'inferred', name: inferred.name };
  return { workspaceId: null, source: 'none' };
}
