export const SESSION_AUTH_STORAGE_KEY = 'session_auth_v1';
export const SESSION_CONTEXT_STORAGE_KEY = 'session_context_v1';

export type SessionAuth = {
  userId: string;
  scope?: string;
  email?: string;
  authenticatedAt?: number;
};

export type SessionContext = {
  workspaceId?: string;
  workspaceName?: string;
  initiativeId?: string;
};

type StoredAuth = {
  user_id?: unknown;
  userId?: unknown;
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

  const scope = typeof record.scope === 'string' ? record.scope : undefined;
  const email = typeof record.email === 'string' ? record.email : undefined;
  const authenticatedAtRaw = record.authenticated_at ?? record.authenticatedAt;
  const authenticatedAt =
    typeof authenticatedAtRaw === 'number' ? authenticatedAtRaw : undefined;

  return { userId, scope, email, authenticatedAt };
}

export function toStoredSessionAuth(
  auth: SessionAuth,
  now: number = Date.now()
): Record<string, unknown> {
  return {
    user_id: auth.userId,
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

  if (!workspaceId && !workspaceName && !initiativeId) return null;
  return { workspaceId, workspaceName, initiativeId };
}

export function toStoredSessionContext(
  context: SessionContext,
  now: number = Date.now()
): Record<string, unknown> {
  return {
    workspace_id: context.workspaceId ?? null,
    workspace_name: context.workspaceName ?? null,
    initiative_id: context.initiativeId ?? null,
    updated_at: now,
  };
}

