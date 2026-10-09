import { inferMcpContractVersion } from './mcpCompatibility';
import { READ_ONLY_FALLBACK_PROFILE, resolveToolProfile } from './toolProfiles';

export const SESSION_TOOL_CONTRACT_KEY = 'orgx:session-tool-contract';
export type SessionToolContract = { profile: string; contract_version: string };

export interface SessionAuthenticatedGrant {
  userId?: string;
  scope?: string;
  authSource?: string;
  runId?: string;
  scopes?: readonly string[];
  workspace_id?: string;
}

function canonicalGrant(grant: SessionAuthenticatedGrant): string {
  const run = grant.authSource === 'run_token';
  const scopes = typeof grant.scope === 'string'
    ? [...new Set(grant.scope.split(/\s+/).filter(Boolean))].sort() : null;
  return JSON.stringify({
    source: run ? 'run_token' : 'oauth',
    scopes,
    ...(run ? {
      run_id: grant.runId ?? null,
      workspace_id: grant.workspace_id ?? null,
      tool_scopes: Array.isArray(grant.scopes) ? [...new Set(grant.scopes)].sort() : null,
    } : {}),
  });
}

/** Warm SDK instances retain their original props and registry; a new grant needs a new session. */
export function assertMcpSessionGrant(previous: SessionAuthenticatedGrant, incoming: SessionAuthenticatedGrant): void {
  if (canonicalGrant(previous) !== canonicalGrant(incoming)) throw new McpSessionGrantConflictError();
}

export class McpSessionGrantConflictError extends Error {
  constructor() {
    super('This MCP session uses a different authenticated grant. Reconnect without a session ID to refresh OrgX permissions.');
    this.name = 'McpSessionGrantConflictError';
  }
}

/** Bind current discovery once. Pre-operation sessions reconnect after the coordinated cutover. */
export function selectSessionToolContract(input: {
  stored?: SessionToolContract | null;
  initialized: boolean;
  requestedProfile?: string;
  internalRun?: boolean;
}): SessionToolContract {
  if (input.stored) {
    const resolved = resolveToolProfile(input.stored.profile);
    if (resolved.fellBack || input.stored.contract_version !== inferMcpContractVersion(resolved.name)) {
      throw new McpSessionProfileConflictError();
    }
    // A persisted internal profile is never an external authorization grant.
    if (resolved.name === 'full' && !input.internalRun) throw new McpSessionProfileConflictError();
    return { profile: resolved.name, contract_version: input.stored.contract_version };
  }
  if (input.initialized) throw new McpSessionProfileConflictError();
  const resolved = resolveToolProfile(input.requestedProfile).name;
  const profile = resolved === 'full' && !input.internalRun ? READ_ONLY_FALLBACK_PROFILE : resolved;
  return { profile, contract_version: inferMcpContractVersion(profile) };
}

export class McpSessionProfileConflictError extends Error {
  constructor() {
    super('This MCP session uses a stale or different tool profile. Reconnect without a session ID to refresh OrgX tools.');
    this.name = 'McpSessionProfileConflictError';
  }
}

/** A session never transfers its persisted workspace or cached credentials to another actor. */
export function assertMcpSessionIdentity(previousUserId?: string, incomingUserId?: string): void {
  if (previousUserId && previousUserId !== incomingUserId) {
    throw new McpSessionIdentityConflictError();
  }
}

export class McpSessionIdentityConflictError extends Error {
  constructor() {
    super('This MCP session belongs to another authenticated identity. Reconnect without a session ID.');
    this.name = 'McpSessionIdentityConflictError';
  }
}
