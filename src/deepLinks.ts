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
 * The seven OrgX agents and the words that name them (key, name, domain,
 * headshot stem). Mirrors public/widgets/shared/agent-identity.js, so an agent
 * link from a tool result opens the same desk as one from a widget.
 */
const AGENT_WORDS: Record<string, string[]> = {
  pace: ['pace', 'product', 'product-agent', 'product_agent', 'product_orchestrator'],
  eli: ['eli', 'engineering', 'engineering-agent', 'engineering_agent', 'engineering_autopilot'],
  mark: ['mark', 'marketing', 'marketing-agent', 'marketing_agent', 'launch_captain'],
  sage: ['sage', 'sales', 'sales-agent', 'sales_agent', 'pipeline_intelligence'],
  orion: ['orion', 'operations', 'ops', 'operations-agent', 'operations_agent', 'control_tower'],
  dana: ['dana', 'design', 'design-agent', 'design_agent', 'design_codex'],
  xandy: ['xandy', 'orchestrator', 'orchestrator-agent', 'orchestrator_agent', 'xandy_orchestrator'],
};

/** The agent desk slug for an agent key, name, id or domain; null for anyone else. */
export function agentSlug(value: string | null | undefined): string | null {
  const tokens = String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean);
  for (const [slug, words] of Object.entries(AGENT_WORDS)) {
    if (tokens.some((token) => words.includes(token))) return slug;
  }
  return null;
}

function clean(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  return text && text !== 'undefined' && text !== 'null' ? text : '';
}

function seg(value: string): string {
  return encodeURIComponent(clean(value));
}

/** path + query, skipping empty values (the same shape the widget builder emits). */
function withQuery(path: string, query: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const v = clean(value);
    if (v) params.set(key, v);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * An initiative's live room, or (without one) the page the focus names. The
 * legacy mission-control view is built around a single initiative and renders
 * an empty graph without one, so it is never the destination: a task, run,
 * workstream or milestone opens its own page, and anything else opens Runs.
 */
function livePath(
  initiativeId?: string,
  focus: Record<string, string | undefined> = {}
): string {
  if (clean(initiativeId)) {
    return withQuery(`/live/${seg(initiativeId!)}`, {
      workstream: focus.workstream,
      task: focus.task,
      decision: focus.decision,
      artifact: focus.artifact,
    });
  }
  if (clean(focus.task)) return `/tasks/${seg(focus.task!)}`;
  if (clean(focus.run)) return `/runs/${seg(focus.run!)}`;
  if (clean(focus.workstream)) return `/workstreams/${seg(focus.workstream!)}`;
  if (clean(focus.milestone)) return `/milestones/${seg(focus.milestone!)}`;
  return '/runs';
}

/**
 * Entity type to URL path. Every path lands on a real OrgX app page with only
 * the query parameters that page reads, the same routes as the widgets' link
 * builder (OrgXLinks in public/widgets/shared/widget-runtime.js). Checked
 * against tests/fixtures/orgx-app-routes.json by tests/serverDeepLinks.spec.ts.
 *
 * Shapes this used to emit that do not reach the right page: /planning/sessions/:id,
 * /settings/agents?agent=, /initiatives/:id?focus=decisions&decision=,
 * /live/:id?milestone=, /agents/runs/:id, /agents/sessions/:id, /blockers/:id,
 * /settings/goals?objective=, /settings/skills, /workflows/:id, /playbooks/:id
 * and /<type>s/:id for unknown types.
 */
function getEntityPath(
  entityType: string,
  entityId: string,
  opts: EntityLinkOptions = {}
): string {
  const type =
    normalizeDeeplinkEntityType(entityType) ??
    entityType.toLowerCase().replace(/-/g, '_');
  const id = clean(entityId);
  const initiativeId = clean(opts.initiativeId);
  const fallback = () => (initiativeId ? livePath(initiativeId) : '/command');

  switch (type) {
    case 'initiative':
      // The initiative's live room; no id -> the initiatives index.
      return id ? `/live/${seg(id)}` : '/initiatives';
    case 'project':
      return id ? `/projects/${seg(id)}` : fallback();
    case 'task':
      if (!id) return livePath(initiativeId);
      return initiativeId ? livePath(initiativeId, { task: id }) : `/tasks/${seg(id)}`;
    case 'milestone':
      // The live room has no milestone focus: the milestone page.
      return id ? `/milestones/${seg(id)}` : livePath(initiativeId);
    case 'workstream':
      if (!id) return livePath(initiativeId);
      return initiativeId ? livePath(initiativeId, { workstream: id }) : `/workstreams/${seg(id)}`;
    case 'objective':
    case 'goal':
      return withQuery('/goals', { objective: id, center: opts.commandCenterId });
    case 'run':
    case 'agent_run':
      return id ? `/runs/${seg(id)}` : '/runs';
    case 'session':
      return livePath(undefined, { session: id });
    case 'decision':
      return id ? `/decisions/${seg(id)}` : '/decisions?status=pending';
    case 'artifact':
      return id ? `/artifacts/${seg(id)}` : '/workspace-hub';
    case 'plan':
    case 'plan_session':
      // OrgX has no plan-session page: the plan's initiative, else mission control with the session.
      return initiativeId ? `/initiatives/${seg(initiativeId)}` : livePath(undefined, { session: id });
    case 'command_center':
    case 'workspace':
      return withQuery('/command', { center: id });
    case 'blocker':
      // A blocker lives on its run when known, else in the initiative's live room.
      return clean(opts.runId) ? `/runs/${seg(opts.runId!)}` : fallback();
    case 'agent': {
      const slug = agentSlug(id);
      return slug ? `/command/agents/${slug}` : '/command/agents';
    }
    case 'live':
    case 'live_ops':
    case 'live_operations':
      if (initiativeId) return livePath(initiativeId);
      if (id && id !== 'default') return livePath(id);
      return livePath();
    default:
      // workflow, playbook, skill and unknown types have no page of their own.
      return fallback();
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
  // `workspace` is the command center the live view reads as `center`.
  const { workspace, ...rest } = query;
  let path: string;
  if (clean(initiativeId)) {
    // The live room reads its focus keys; a session belongs to mission control.
    path = livePath(initiativeId, rest);
  } else {
    // No initiative: no live room. Runs is the workspace's running work and
    // scopes itself to the active workspace (it reads no ?center).
    path = livePath(undefined, rest);
    void sessionId;
    void workspace;
  }
  return new URL(path, ORGX_APP_BASE_URL).toString();
}

/**
 * Build a deep link for any OrgX entity
 *
 * @example
 * buildEntityLink('initiative', 'abc-123', { label: 'Q1 Launch' })
 * // => { markdown: '[Q1 Launch](https://useorgx.com/live/abc-123)', ... }
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
