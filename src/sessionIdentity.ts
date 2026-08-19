/**
 * Session identity resolution for the MCP worker.
 *
 * SECURITY CONTRACT: the acting identity of an MCP tool call is derived ONLY
 * from the authenticated connection — the per-request OAuth/run-token props, or
 * the session auth persisted at initial authentication. Tool arguments never
 * participate.
 *
 * This matters because the resolved id is forwarded to the OrgX API as
 * `X-Orgx-User-Id` and signed into `X-Orgx-Actor-Token` behind the service key.
 * The API trusts those on the service path, so any caller-supplied value that
 * reached this function would let an authenticated session act as another user.
 *
 * The function deliberately takes no "explicit override" parameter. Do not add
 * one: ownership fields such as `owner_id` belong in the request *payload*,
 * where the API authorizes them, never in the identity headers.
 */
export interface McpSessionIdentitySource {
  props?: {
    userId?: string | null;
    email?: string | null;
    orgxUserId?: string | null;
  } | null;
  sessionAuth?: {
    userId?: string | null;
    email?: string | null;
    orgxUserId?: string | null;
  } | null;
}

/**
 * Resolve the acting user id with priority:
 * 1. Current request props (per-request auth token)
 * 2. Persisted session auth (from initial OAuth)
 * 3. null (the API falls back to the service user)
 */
export function resolveSessionUserId(
  source: McpSessionIdentitySource
): string | null {
  return source.props?.userId ?? source.sessionAuth?.userId ?? null;
}

/**
 * Resolve the acting user email from the authenticated connection only.
 */
export function resolveSessionUserEmail(
  source: McpSessionIdentitySource
): string | null {
  return source.props?.email ?? source.sessionAuth?.email ?? null;
}
