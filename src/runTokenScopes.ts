/**
 * Tool scopes carried by a v2 run token (`oxrun2`, claim `scp`).
 *
 * A run token is handed to runtimes OrgX does not control (hosted managed
 * agents, sandboxes), so its grant is the ceiling, not a hint: the session
 * sees only tools that are both in the requested profile and in `scp`. An
 * empty `scp` means no tools. v1 tokens carry no scopes and keep the
 * profile's tools, as before.
 *
 * Registration is the enforcement point: a tool that is not registered on
 * the session cannot be listed or called.
 */
export function applyRunTokenScopes(
  allowed: ReadonlySet<string> | null,
  scopes: readonly string[] | undefined
): Set<string> | null {
  if (!Array.isArray(scopes)) return allowed ? new Set(allowed) : null;
  const granted = new Set(scopes);
  if (!allowed) return granted;
  return new Set([...allowed].filter((toolId) => granted.has(toolId)));
}
