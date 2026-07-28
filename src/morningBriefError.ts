import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { toolError } from './authHelpers';
import { OrgXApiError } from './orgxApi';

export function mapMorningBriefApiError(
  error: unknown,
  workspaceId: string
): CallToolResult | null {
  if (!(error instanceof OrgXApiError) || error.statusCode !== 404) {
    return null;
  }

  return toolError('Workspace not found or not accessible', {
    code: 'workspace_not_found',
    status: 404,
    details: { workspace_id: workspaceId },
  });
}
