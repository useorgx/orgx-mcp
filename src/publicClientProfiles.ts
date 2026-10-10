import { TOOL_PROFILES } from './toolProfiles';

export const AUTHENTICATED_MCP_URL = 'https://mcp.useorgx.com/mcp';

/** Public client contracts only; assignment/runtime and full/debug profiles are omitted. */
export const PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS = {
  v2: 'orgx-mcp-operations/1',
  extended: 'orgx-mcp-operations/1',
  chatgpt: 'orgx-mcp-operations/1',
  'claude-directory': 'orgx-mcp-operations/1',
  'read-only': 'orgx-mcp-operations/1',
  legacy: 'orgx-mcp-legacy/1',
  'claude-directory-legacy': 'orgx-mcp-legacy/1',
  'claude-plugin': 'orgx-mcp-legacy/1',
  'claude-code-legacy': 'orgx-mcp-legacy/1',
} as const;

export interface PublicClientProfile {
  contract_version: 'orgx-mcp-operations/1' | 'orgx-mcp-legacy/1';
  tools: string[];
  authenticated_endpoint: string;
}

/** Inventory describes registration, never the grants or data of an authenticated caller. */
export function getPublicClientProfiles(): Record<string, PublicClientProfile> {
  const profiles: Record<string, PublicClientProfile> = {};
  for (const [name, contractVersion] of Object.entries(PUBLIC_CLIENT_PROFILE_CONTRACT_VERSIONS)) {
    const profile = Object.hasOwn(TOOL_PROFILES, name) ? TOOL_PROFILES[name] : undefined;
    if (!profile?.tools) continue;
    const endpoint = new URL(AUTHENTICATED_MCP_URL);
    endpoint.searchParams.set('profile', name);
    profiles[name] = {
      contract_version: contractVersion,
      tools: [...profile.tools],
      authenticated_endpoint: endpoint.toString(),
    };
  }
  return profiles;
}
