/**
 * Versioned OAuth authorization policy shared by discovery, consent, and
 * runtime enforcement.
 *
 * Scope values are intentionally kept backward compatible with existing OrgX
 * grants. Product-facing copy calls write access "Operate" because those
 * scopes can change organizational state or dispatch work.
 */

export const AUTHORIZATION_POLICY_VERSION = '2026-08-15.v1' as const;

export const OAUTH_SCOPE = {
  decisionsRead: 'decisions:read',
  decisionsWrite: 'decisions:write',
  agentsRead: 'agents:read',
  agentsWrite: 'agents:write',
  initiativesRead: 'initiatives:read',
  initiativesWrite: 'initiatives:write',
  memoryRead: 'memory:read',
  offlineAccess: 'offline_access',
} as const;

export type OAuthScope = (typeof OAUTH_SCOPE)[keyof typeof OAUTH_SCOPE];

/** Exact scope vocabulary and stable discovery order. */
export const OAUTH_SCOPES_SUPPORTED = [
  OAUTH_SCOPE.decisionsRead,
  OAUTH_SCOPE.decisionsWrite,
  OAUTH_SCOPE.agentsRead,
  OAUTH_SCOPE.agentsWrite,
  OAUTH_SCOPE.initiativesRead,
  OAUTH_SCOPE.initiativesWrite,
  OAUTH_SCOPE.memoryRead,
  OAUTH_SCOPE.offlineAccess,
] as const satisfies readonly OAuthScope[];

export type AuthorizationAccessLevel = 'read' | 'operate';

export interface AuthorizationAction {
  readonly id: string;
  readonly label: string;
  readonly access: AuthorizationAccessLevel;
  readonly scope: OAuthScope;
  readonly description: string;
}

export interface AuthorizationResource {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly actions: readonly AuthorizationAction[];
}

/**
 * Canonical resource/action catalog used to explain what a grant can do.
 * `*:write` remains the wire-level scope while `operate` is the user-facing
 * action name.
 */
export const AUTHORIZATION_RESOURCE_ACTION_CATALOG = [
  {
    id: 'decisions',
    label: 'Decisions',
    description: 'Organizational decisions, approvals, and decision history.',
    actions: [
      {
        id: 'read',
        label: 'Read',
        access: 'read',
        scope: OAUTH_SCOPE.decisionsRead,
        description: 'View decisions, approvals, and their history.',
      },
      {
        id: 'operate',
        label: 'Operate',
        access: 'operate',
        scope: OAUTH_SCOPE.decisionsWrite,
        description: 'Create, approve, reject, or update decisions.',
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Delegated agent work, status, handoffs, and lifecycle.',
    actions: [
      {
        id: 'read',
        label: 'Read',
        access: 'read',
        scope: OAUTH_SCOPE.agentsRead,
        description: 'View agent work, status, and execution history.',
      },
      {
        id: 'operate',
        label: 'Operate',
        access: 'operate',
        scope: OAUTH_SCOPE.agentsWrite,
        description: 'Delegate, hand off, retry, pause, resume, or cancel work.',
      },
    ],
  },
  {
    id: 'initiatives',
    label: 'Initiatives',
    description: 'Initiatives, milestones, tasks, artifacts, and receipts.',
    actions: [
      {
        id: 'read',
        label: 'Read',
        access: 'read',
        scope: OAUTH_SCOPE.initiativesRead,
        description: 'View initiatives, work state, artifacts, and receipts.',
      },
      {
        id: 'operate',
        label: 'Operate',
        access: 'operate',
        scope: OAUTH_SCOPE.initiativesWrite,
        description: 'Create or update work and attach artifacts or proof.',
      },
    ],
  },
  {
    id: 'memory',
    label: 'Organizational memory',
    description: 'Durable organizational context and recalled knowledge.',
    actions: [
      {
        id: 'read',
        label: 'Read',
        access: 'read',
        scope: OAUTH_SCOPE.memoryRead,
        description: 'Search and recall organizational memory.',
      },
    ],
  },
] as const satisfies readonly AuthorizationResource[];

/** OAuth capability that is deliberately separate from data access presets. */
export const AUTHORIZATION_SESSION_CAPABILITIES = [
  {
    id: 'offline_access',
    label: 'Stay connected',
    scope: OAUTH_SCOPE.offlineAccess,
    description: 'Allow the client to refresh access after the current session.',
  },
] as const;

const READ_PRESET_SCOPES = [
  OAUTH_SCOPE.decisionsRead,
  OAUTH_SCOPE.agentsRead,
  OAUTH_SCOPE.initiativesRead,
  OAUTH_SCOPE.memoryRead,
] as const;

const OPERATE_PRESET_SCOPES = [
  OAUTH_SCOPE.decisionsRead,
  OAUTH_SCOPE.decisionsWrite,
  OAUTH_SCOPE.agentsRead,
  OAUTH_SCOPE.agentsWrite,
  OAUTH_SCOPE.initiativesRead,
  OAUTH_SCOPE.initiativesWrite,
  OAUTH_SCOPE.memoryRead,
] as const;

export const AUTHORIZATION_PRESETS = {
  read: {
    id: 'read',
    label: 'Read',
    selection: 'fixed',
    description: 'View organizational work without changing it.',
    scopes: READ_PRESET_SCOPES,
  },
  operate: {
    id: 'operate',
    label: 'Operate',
    selection: 'fixed',
    description: 'View and change work, including delegated agent actions.',
    scopes: OPERATE_PRESET_SCOPES,
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    selection: 'custom',
    description: 'Choose access separately for each resource.',
    scopes: [] as const,
  },
} as const;

/** Complete versioned contract for generated consent and documentation views. */
export const AUTHORIZATION_POLICY = {
  version: AUTHORIZATION_POLICY_VERSION,
  scopesSupported: OAUTH_SCOPES_SUPPORTED,
  resources: AUTHORIZATION_RESOURCE_ACTION_CATALOG,
  sessionCapabilities: AUTHORIZATION_SESSION_CAPABILITIES,
  presets: AUTHORIZATION_PRESETS,
} as const;

const SUPPORTED_SCOPE_SET = new Set<string>(OAUTH_SCOPES_SUPPORTED);

export function isSupportedOAuthScope(scope: string): scope is OAuthScope {
  return SUPPORTED_SCOPE_SET.has(scope);
}
