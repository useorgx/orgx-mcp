export const SESSION_AUTH_STORAGE_KEY = 'session_auth_v1';
export const SESSION_CONTEXT_STORAGE_KEY = 'session_context_v1';

export type SessionAuth = {
  userId: string;
  // Internal Supabase user UUID resolved at MCP login (identity-token mint).
  // Optional — absent on sessions minted before the UUID-forward change; those
  // resolve via the userId (Clerk id) + email path on the API side.
  orgxUserId?: string;
  scope?: string;
  email?: string;
  authenticatedAt?: number;
};

export type SessionContext = {
  workspaceId?: string;
  workspaceName?: string;
  initiativeId?: string;
  // MCP initialize handshake identity (clientInfo.name/version). Captured
  // server-side so attribution survives agents that never send _context.
  clientName?: string;
  clientVersion?: string;
};

type StoredAuth = {
  user_id?: unknown;
  userId?: unknown;
  orgx_user_id?: unknown;
  orgxUserId?: unknown;
  scope?: unknown;
  email?: unknown;
  authenticated_at?: unknown;
  authenticatedAt?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
};

type StoredContext = {
  workspace_id?: unknown;
  workspaceId?: unknown;
  workspace_name?: unknown;
  workspaceName?: unknown;
  initiative_id?: unknown;
  initiativeId?: unknown;
  client_name?: unknown;
  clientName?: unknown;
  client_version?: unknown;
  clientVersion?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
};

export function parseStoredSessionAuth(stored: unknown): SessionAuth | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as StoredAuth;

  const userId =
    typeof record.user_id === 'string'
      ? record.user_id
      : typeof record.userId === 'string'
      ? record.userId
      : null;
  if (!userId || userId.trim().length === 0) return null;

  const orgxUserId =
    typeof record.orgx_user_id === 'string'
      ? record.orgx_user_id
      : typeof record.orgxUserId === 'string'
      ? record.orgxUserId
      : undefined;
  const scope = typeof record.scope === 'string' ? record.scope : undefined;
  const email = typeof record.email === 'string' ? record.email : undefined;
  const authenticatedAtRaw = record.authenticated_at ?? record.authenticatedAt;
  const authenticatedAt =
    typeof authenticatedAtRaw === 'number' ? authenticatedAtRaw : undefined;

  return { userId, orgxUserId, scope, email, authenticatedAt };
}

export function toStoredSessionAuth(
  auth: SessionAuth,
  now: number = Date.now()
): Record<string, unknown> {
  return {
    user_id: auth.userId,
    orgx_user_id: auth.orgxUserId ?? null,
    scope: auth.scope ?? null,
    email: auth.email ?? null,
    authenticated_at: auth.authenticatedAt ?? now,
    updated_at: now,
  };
}

export function parseStoredSessionContext(stored: unknown): SessionContext | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as StoredContext;

  const workspaceId =
    typeof record.workspace_id === 'string'
      ? record.workspace_id
      : typeof record.workspaceId === 'string'
      ? record.workspaceId
      : undefined;
  const workspaceName =
    typeof record.workspace_name === 'string'
      ? record.workspace_name
      : typeof record.workspaceName === 'string'
      ? record.workspaceName
      : undefined;
  const initiativeId =
    typeof record.initiative_id === 'string'
      ? record.initiative_id
      : typeof record.initiativeId === 'string'
      ? record.initiativeId
      : undefined;
  const clientName =
    typeof record.client_name === 'string'
      ? record.client_name
      : typeof record.clientName === 'string'
      ? record.clientName
      : undefined;
  const clientVersion =
    typeof record.client_version === 'string'
      ? record.client_version
      : typeof record.clientVersion === 'string'
      ? record.clientVersion
      : undefined;

  if (!workspaceId && !workspaceName && !initiativeId && !clientName) {
    return null;
  }
  return { workspaceId, workspaceName, initiativeId, clientName, clientVersion };
}

export function toStoredSessionContext(
  context: SessionContext,
  now: number = Date.now()
): Record<string, unknown> {
  return {
    workspace_id: context.workspaceId ?? null,
    workspace_name: context.workspaceName ?? null,
    initiative_id: context.initiativeId ?? null,
    client_name: context.clientName ?? null,
    client_version: context.clientVersion ?? null,
    updated_at: now,
  };
}

