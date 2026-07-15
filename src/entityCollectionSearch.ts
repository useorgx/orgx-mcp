export type EntityCollectionSearchInput = {
  type: string;
  limit?: number;
  initiativeId?: string | null;
  workspaceId?: string | null;
  status?: string | null;
  query?: string | null;
  fields?: string[] | null;
};

/**
 * Build the canonical `/api/entities` collection query.
 *
 * The core API calls its text filter `search`. Keeping that translation here
 * prevents MCP-facing `query` from silently becoming an ignored URL param.
 */
export function buildEntityCollectionSearchParams(
  input: EntityCollectionSearchInput
): URLSearchParams {
  const search = new URLSearchParams();
  search.set('type', input.type);
  if (input.limit) search.set('limit', String(input.limit));
  if (input.initiativeId) search.set('initiative_id', input.initiativeId);
  if (input.workspaceId) search.set('workspace_id', input.workspaceId);
  if (input.status) search.set('status', input.status);
  if (input.query) search.set('search', input.query);
  if (input.fields?.length) search.set('fields', input.fields.join(','));
  return search;
}
