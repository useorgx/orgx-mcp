import { WIDGET_URIS } from './toolDefinitions';
import { resolveToolProfile } from './toolProfiles';

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
 * require unavailable tools, or unrelated action widgets.
 */
export function resolveProfileDiscoveryPolicy(
  profileName: string | undefined | null
): ProfileDiscoveryPolicy {
  if (resolveToolProfile(profileName).name === 'claude-directory') {
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
