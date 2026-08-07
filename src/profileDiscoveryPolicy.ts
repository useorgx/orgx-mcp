import { WIDGET_URIS } from './toolDefinitions';
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

/**
 * Keep auxiliary MCP discovery coherent with the negotiated tool profile.
 * The Anthropic directory endpoint is intentionally smaller than the general
 * OrgX surface, so it does not advertise mutation prompts, skill packs that
 * require unavailable tools, or unrelated action widgets. The read-only
 * fallback (unknown profile names) shares that restricted discovery because
 * it exposes the same seven read tools.
 */
export function resolveProfileDiscoveryPolicy(
  profileName: string | undefined | null
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

  return {
    includeInitiativeResource: true,
    includeSkillResources: true,
    includePrompts: true,
    widgetUris: null,
  };
}
