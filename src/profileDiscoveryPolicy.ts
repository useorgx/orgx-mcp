import { checkAuthRequirements, type GrantedScopes } from './authHelpers';
import { SECURITY_SCHEMES, WIDGET_URIS } from './toolDefinitions';
import { READ_ONLY_FALLBACK_PROFILE, resolveToolProfile } from './toolProfiles';

// One widget per template a directory tool declares (orgx_inspect renders the
// entity card, get_operator_chronicle the work ledger), so no listed tool
// points at a resource the profile does not serve.
export const INFORMATIONAL_WIDGET_URIS = [
  WIDGET_URIS.agentStatus,
  WIDGET_URIS.searchResults,
  WIDGET_URIS.initiativePulse,
  WIDGET_URIS.morningBrief,
  WIDGET_URIS.entityCard,
  WIDGET_URIS.workLedger,
] as const;

export const CLAUDE_DIRECTORY_WIDGET_URIS = [
  ...INFORMATIONAL_WIDGET_URIS,
  WIDGET_URIS.workspaceMap,
  WIDGET_URIS.proofReceipt,
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
 * Claude's operation-specific surface omits legacy mutation prompts, skill
 * packs that require unavailable routers, and incompatible action widgets.
 * The fallback retains only the original informational widgets. ChatGPT keeps its
 * authorized initiative resource and full widget set, but suppresses legacy
 * prompts and skill packs whose required tools are not on its surface.
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
      widgetUris: new Set(resolved === READ_ONLY_FALLBACK_PROFILE
        ? INFORMATIONAL_WIDGET_URIS
        : CLAUDE_DIRECTORY_WIDGET_URIS),
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
