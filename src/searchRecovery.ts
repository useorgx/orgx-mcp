import type { OrgxSearchArgs } from './orgxSearch';

/** Empty is a scoped observation, never proof that a record does not exist. */
export function buildSearchRecovery(args: OrgxSearchArgs, typed: boolean) {
  const filters = Object.fromEntries(['type', 'status', 'workspace_id', 'initiative_id',
    'created_from', 'created_to', 'limit', 'fields'].filter(key => args[key] !== undefined)
    .map(key => [key, args[key]]));
  const hasText = typeof args.query === 'string' && Boolean(args.query.trim());
  return {
    message: typed
      ? 'No records matched this page and its filters. This does not establish that no records exist outside this scope.'
      : 'No matches in this relevance window. Mixed search is limited to memory-backed records and is not exhaustive.',
    hint: hasText && typed
      ? 'Browse the same filters without query to check titles. Query matches text; words such as recent or approved are not filters.'
      : 'Use type to browse a collection. Use status and created_from/created_to for lifecycle and creation dates. Request logs are not searchable here.',
    next_call: hasText && typed
      ? { tool: 'orgx_search', args: filters }
      : null,
  };
}
