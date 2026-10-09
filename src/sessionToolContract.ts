import { inferMcpContractVersion } from './mcpCompatibility';
import { READ_ONLY_FALLBACK_PROFILE, resolveToolProfile } from './toolProfiles';

export const SESSION_TOOL_CONTRACT_KEY = 'orgx:session-tool-contract';
export type SessionToolContract = { profile: string; contract_version: string };

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
