import { checkAuthRequirements, type GrantedScopes } from './authHelpers';
import { SECURITY_SCHEMES, WIDGET_URIS } from './toolDefinitions';
import { READ_ONLY_FALLBACK_PROFILE, resolveToolProfile } from './toolProfiles';

export const CLAUDE_DIRECTORY_WIDGET_URIS = [
  WIDGET_URIS.agentStatus,
  WIDGET_URIS.searchResults,
  WIDGET_URIS.initiativePulse,
  WIDGET_URIS.morningBrief,
] as const;

export interface ProfileDiscoveryPolicy {
  includeInitiativeResource: boolean;
  includeSkillResources: boolean;
  includePrompts: boolean;
  /** null means every registered widget resource remains visible. */
  widgetUris: ReadonlySet<string> | null;
}

export interface ProfileDiscoveryAuthorization {
  userId?: string;
  /** `undefined` preserves legacy/internal authenticated sessions. */
  grantedScopes?: GrantedScopes;
}

/**
 * Keep auxiliary MCP discovery coherent with the negotiated tool profile.
 * The Anthropic directory endpoint is intentionally smaller than the general
 * OrgX surface, so it does not advertise mutation prompts, skill packs that
 * require unavailable tools, or unrelated action widgets. The read-only
 * fallback (unknown profile names) shares that restricted discovery because
 * it exposes the same seven read tools. The ChatGPT review profile keeps its
 * authorized initiative resource and full widget set, but suppresses legacy
 * prompts and skill packs whose required tools are not in its 23-tool surface.
 */
export function resolveProfileDiscoveryPolicy(
  profileName: string | undefined | null,
  authorization?: ProfileDiscoveryAuthorization
): ProfileDiscoveryPolicy {
  const resolved = resolveToolProfile(profileName).name;
  if (resolved === 'claude-directory' || resolved === READ_ONLY_FALLBACK_PROFILE) {
    return {
      includeInitiativeResource: false,
      includeSkillResources: false,
      includePrompts: false,
      widgetUris: new Set(CLAUDE_DIRECTORY_WIDGET_URIS),
    };
  }

  const initiativeResourceAuthorized = authorization
    ? checkAuthRequirements(
        SECURITY_SCHEMES.entityReadRequiresAuth,
        authorization.userId,
        authorization.grantedScopes
      ).isAuthorized
    : true;
  const includeLegacyAuxiliaryContent = resolved !== 'chatgpt';

  return {
    includeInitiativeResource: initiativeResourceAuthorized,
    includeSkillResources: includeLegacyAuxiliaryContent,
    includePrompts: includeLegacyAuxiliaryContent,
    widgetUris: null,
  };
}
