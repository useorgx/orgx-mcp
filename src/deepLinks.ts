/**
 * Deep Link Utilities for MCP Worker
 *
 * Worker-compatible implementation of entity deep linking.
 * Mirrors lib/deepLinks.ts but without Node.js dependencies.
 */
import { normalizeDeeplinkEntityType } from './shared/deeplinks';

const ORGX_APP_BASE_URL = 'https://useorgx.com';

export interface EntityLinkOptions {
  baseUrl?: string;
  initiativeId?: string;
  runId?: string;
  commandCenterId?: string;
  label?: string;
  query?: Record<string, string>;
}

export interface EntityLink {
  url: string;
  markdown: string;
  path: string;
}

/**
 * Entity type to URL path mapping
 */
function getEntityPath(
  entityType: string,
  entityId: string,
  opts: EntityLinkOptions = {}
): string {
  const type =
    normalizeDeeplinkEntityType(entityType) ??
    entityType.toLowerCase().replace(/-/g, '_');

  switch (type) {
    case 'initiative':
      // Canonical initiative live route (server redirects to mission control query view).
      return `/live/${entityId}`;
    case 'project':
      return `/projects/${entityId}`;
    case 'task':
      return opts.initiativeId
        ? `/live/${opts.initiativeId}?task=${entityId}`
        : `/live?view=mission-control&task=${entityId}`;
    case 'milestone':
      return opts.initiativeId
        ? `/live/${opts.initiativeId}?milestone=${entityId}`
        : `/live?view=mission-control&milestone=${entityId}`;
    case 'workstream':
      return opts.initiativeId
        ? `/live/${opts.initiativeId}?workstream=${entityId}`
        : `/live?view=mission-control&workstream=${entityId}`;
    case 'objective':
      return `/settings/goals?objective=${entityId}`;
    case 'run':
    case 'agent_run':
      return `/agents/runs/${entityId}`;
    case 'session':
      return `/agents/sessions/${entityId}`;
    case 'decision':
      return opts.initiativeId
        ? `/initiatives/${opts.initiativeId}?focus=decisions&decision=${entityId}`
        : `/decisions/${entityId}`;
    case 'artifact':
      return `/artifacts/${entityId}`;
    case 'workflow':
      return `/workflows/${entityId}`;
    case 'playbook':
      return `/playbooks/${entityId}`;
    case 'skill':
      return `/settings/skills?skill=${entityId}`;
    case 'plan_session':
      return `/planning/sessions/${entityId}`;
    case 'command_center':
    case 'workspace':
      return `/command?center=${entityId}`;
    case 'blocker':
      return opts.runId
        ? `/agents/runs/${opts.runId}?blocker=${entityId}`
        : `/blockers/${entityId}`;
    case 'agent':
      return `/settings/agents?agent=${entityId}`;
    case 'live':
    case 'live_ops':
    case 'live_operations':
      // Live operations view with optional initiative/session context
      if (opts.initiativeId) {
        return `/live/${opts.initiativeId}`;
      }
      if (entityId && entityId !== 'default') {
        return `/live/${entityId}`;
      }
      return '/live?view=mission-control';
    default:
      return `/${type}s/${entityId}`;
  }
}

/**
 * Build a live operations URL for an initiative or session
 * This is the primary way MCP tools should link to the Live view
 */
export function buildLiveUrl(
  initiativeId?: string,
  sessionId?: string,
  query: Record<string, string> = {}
): string {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.length > 0) {
      params.set(key, value);
    }
  }

  let path: string;
  if (initiativeId) {
    const queryString = params.toString();
    path = queryString
      ? `/live/${initiativeId}?${queryString}`
      : `/live/${initiativeId}`;
  } else {
    params.set('view', 'mission-control');
    const queryString = params.toString();
    path = queryString ? `/live?${queryString}` : '/live';
  }

  return new URL(path, ORGX_APP_BASE_URL).toString();
}

/**
 * Build a deep link for any OrgX entity
 *
 * @example
 * buildEntityLink('initiative', 'abc-123', { label: 'Q1 Launch' })
 * // => { markdown: '[Q1 Launch](https://useorgx.com/initiatives/abc-123)', ... }
 */
export function buildEntityLink(
  entityType: string,
  entityId: string,
  options: EntityLinkOptions = {}
): EntityLink {
  const { baseUrl = ORGX_APP_BASE_URL, label, query = {} } = options;

  let path = getEntityPath(entityType, entityId, options);

  // Append additional query params
  if (Object.keys(query).length > 0) {
    const separator = path.includes('?') ? '&' : '?';
    const queryString = new URLSearchParams(query).toString();
    path = `${path}${separator}${queryString}`;
  }

  const url = baseUrl ? new URL(path, baseUrl).toString() : path;

  // Generate display label
  const displayLabel = label || formatEntityLabel(entityType, entityId);

  return {
    url,
    path,
    markdown: `[${displayLabel}](${url})`,
  };
}

/**
 * Format entity type and ID into a readable label
 */
function formatEntityLabel(entityType: string, entityId: string): string {
  const formattedType = entityType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return `${formattedType} ${entityId}`;
}

/**
 * Quick helper to get markdown link for an entity (absolute URL)
 */
export function entityLinkMarkdown(
  entityType: string,
  entityId: string,
  label?: string
): string {
  return buildEntityLink(entityType, entityId, { label }).markdown;
}
