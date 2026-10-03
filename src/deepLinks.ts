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
 * Agent desks live at /command/agents/:slug, keyed by the agent's short name.
 * Same word lists as OrgXAgentIdentity (public/widgets/shared/agent-identity.js):
 * the key, display name, domain or agent id resolve to the key.
 */
const AGENT_WORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['pace', ['pace', 'product', 'product-agent', 'product_agent', 'product_orchestrator']],
  ['eli', ['eli', 'engineering', 'engineering-agent', 'engineering_agent', 'engineering_autopilot']],
  ['mark', ['mark', 'marketing', 'marketing-agent', 'marketing_agent', 'launch_captain']],
  ['sage', ['sage', 'sales', 'sales-agent', 'sales_agent', 'pipeline_intelligence']],
  ['orion', ['orion', 'operations', 'ops', 'operations-agent', 'operations_agent', 'control_tower']],
  ['dana', ['dana', 'design', 'design-agent', 'design_agent', 'design_codex']],
  ['xandy', ['xandy', 'orchestrator', 'orchestrator-agent', 'orchestrator_agent', 'xandy_orchestrator']],
];

export function resolveAgentSlug(agentId: string): string | null {
  const tokens = agentId.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
  for (const [key, words] of AGENT_WORDS) {
    if (tokens.some((token) => words.includes(token))) return key;
  }
  return null;
}

const enc = encodeURIComponent;

/**
 * Entity type to URL path mapping.
 *
 * Mirrors OrgXWidgetRuntime.links (public/widgets/shared/widget-runtime.js).
 * Every path must resolve to a real page in the OrgX app (not a redirect) and
 * only carry query params that page reads; tests/deepLinksRoutes.spec.ts
 * checks this against tests/fixtures/orgx-app-routes.json.
 */
export function getEntityPath(
  entityType: string,
  entityId: string,
  opts: EntityLinkOptions = {}
): string {
  const type =
    normalizeDeeplinkEntityType(entityType) ??
    entityType.toLowerCase().replace(/-/g, '_');
  const id = enc(entityId);
  const initiativeId = opts.initiativeId ? enc(opts.initiativeId) : null;

  switch (type) {
    case 'initiative':
      return `/initiatives/${id}`;
    case 'project':
      return `/projects/${id}`;
    case 'workstream':
      return initiativeId
        ? `/live/${initiativeId}?workstream=${id}`
        : `/workstreams/${id}`;
    case 'task':
      return initiativeId ? `/live/${initiativeId}?task=${id}` : `/tasks/${id}`;
    case 'milestone':
      return `/milestones/${id}`;
    case 'decision':
      return `/decisions/${id}`;
    case 'artifact':
      return `/artifacts/${id}`;
    case 'run':
    case 'agent_run':
      return `/runs/${id}`;
    case 'session':
      // The execution room has no session focus; mission control does.
      return `/live?view=mission-control&session=${id}`;
    case 'blocker':
      // Blockers have no page of their own; open the run they block.
      if (opts.runId) return `/runs/${enc(opts.runId)}`;
      return initiativeId ? `/live/${initiativeId}` : '/command';
    case 'agent': {
      const slug = resolveAgentSlug(entityId);
      return slug ? `/command/agents/${slug}` : '/command/agents';
    }
    case 'plan':
    case 'plan_session':
      return initiativeId
        ? `/initiatives/${initiativeId}`
        : `/live?view=mission-control&session=${id}`;
    case 'objective':
    case 'goal':
      return `/goals?objective=${id}`;
    case 'command_center':
    case 'workspace':
      return `/command?center=${id}`;
    case 'live':
    case 'live_ops':
    case 'live_operations':
      // Live operations view with optional initiative/session context
      if (initiativeId) {
        return `/live/${initiativeId}`;
      }
      if (entityId && entityId !== 'default') {
        return `/live/${id}`;
      }
      return '/live?view=mission-control';
    default:
      // workflow, playbook, skill and anything else have no page in the app.
      return initiativeId ? `/live/${initiativeId}` : '/command';
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
      // The live view scopes by `center`; it does not read `workspace`.
      params.set(key === 'workspace' ? 'center' : key, value);
    }
  }

  let path: string;
  if (initiativeId && sessionId) {
    // The execution room has no session focus; mission control scopes by initiative.
    params.set('initiative', initiativeId);
    params.set('view', 'mission-control');
    path = `/live?${params.toString()}`;
  } else if (initiativeId) {
    const queryString = params.toString();
    path = queryString
      ? `/live/${enc(initiativeId)}?${queryString}`
      : `/live/${enc(initiativeId)}`;
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
