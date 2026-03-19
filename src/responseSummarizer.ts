/**
 * LLM-Optimized Response Summarizer
 *
 * Converts raw API payloads into concise Markdown summaries for LLM content blocks.
 * Widget tools keep JSON in content[0]; non-widget tools get Markdown only.
 * Full data always remains in structuredContent for widget rendering.
 *
 * Design principle: the LLM sees a compact summary (500-1500 tokens for lists,
 * 100-500 for single entities) instead of 15,000-50,000 tokens of raw JSON.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Cap list items shown in summary (default: 10) */
  maxItems?: number;
  /** Truncate long text fields (default: 200 chars) */
  maxFieldLength?: number;
  /** Include entity IDs for tool chaining (default: true) */
  includeIds?: boolean;
  /** Entity type hint for column selection */
  entityType?: string;
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  maxItems: 10,
  maxFieldLength: 200,
  includeIds: true,
  entityType: '',
};

// ---------------------------------------------------------------------------
// Payload trimming utilities (Phase 4)
// ---------------------------------------------------------------------------

/** Remove null, undefined, empty string, empty array, and empty object fields. */
export function stripEmpty(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0
    )
      continue;
    result[key] = value;
  }
  return result;
}

/** Remove internal/system fields that waste tokens (metadata, embeddings, _ prefix except _link). */
export function stripInternalFields(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const INTERNAL_KEYS = new Set([
    'metadata',
    'embedding',
    'vector_id',
    'vector_score',
    'vector_distance',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (INTERNAL_KEYS.has(key)) continue;
    if (key.startsWith('_') && key !== '_link') continue;
    result[key] = value;
  }
  return result;
}

/** Truncate a text field to maxLen characters with ellipsis. */
export function truncateField(
  text: string | null | undefined,
  maxLen: number
): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

// ---------------------------------------------------------------------------
// Entity-type-aware formatters
// ---------------------------------------------------------------------------

type EntityRow = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function formatInitiativeRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const health = typeof item.health_score === 'number' ? item.health_score : null;
  const wsCount =
    typeof item.workstream_count === 'number'
      ? item.workstream_count
      : Array.isArray(item.workstreams)
      ? item.workstreams.length
      : null;

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (health !== null) line += ` health:${health}%`;
  if (wsCount !== null) line += ` (${wsCount} workstreams)`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatTaskRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const priority = str(item.priority);
  const assignee =
    str(item.assigned_agent) ||
    str(item.assignee) ||
    str(item.agent_domain) ||
    '';

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (priority) line += ` P:${priority}`;
  if (assignee) line += ` assigned:${assignee}`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatWorkstreamRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const progress =
    typeof item.progress_pct === 'number' ? item.progress_pct : null;

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (progress !== null) line += ` ${progress}%`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatMilestoneRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const dueDate = str(item.due_date);

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (dueDate) line += ` due:${dueDate}`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatDecisionRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const urgency = str(item.urgency);

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (urgency) line += ` urgency:${urgency}`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatAgentRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const name = str(item.name) || str(item.title) || 'Unknown';
  const status = str(item.status);
  const domain = str(item.domain);

  let line = `${idx}. **${name}**`;
  if (status) line += ` [${status}]`;
  if (domain) line += ` domain:${domain}`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

function formatGenericRow(
  item: EntityRow,
  idx: number,
  opts: Required<FormatOptions>
): string {
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);

  let line = `${idx}. **${title}**`;
  if (status) line += ` [${status}]`;
  if (opts.includeIds && item.id) line += ` id:${str(item.id)}`;
  return line;
}

const ROW_FORMATTERS: Record<
  string,
  (item: EntityRow, idx: number, opts: Required<FormatOptions>) => string
> = {
  initiative: formatInitiativeRow,
  task: formatTaskRow,
  workstream: formatWorkstreamRow,
  milestone: formatMilestoneRow,
  decision: formatDecisionRow,
  agent: formatAgentRow,
};

function formatEntityList(
  items: EntityRow[],
  entityType: string,
  opts: Required<FormatOptions>
): string {
  const formatter = ROW_FORMATTERS[entityType] ?? formatGenericRow;
  const shown = items.slice(0, opts.maxItems);
  const lines = shown.map((item, i) => formatter(item, i + 1, opts));
  const remaining = items.length - shown.length;
  if (remaining > 0) {
    lines.push(
      `\n... and ${remaining} more. Use offset=${opts.maxItems} to page.`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool-specific formatters
// ---------------------------------------------------------------------------

function formatListEntities(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  const items = Array.isArray(data.data) ? data.data : [];
  const pagination = data.pagination as
    | { total?: number; offset?: number; limit?: number; has_more?: boolean }
    | undefined;
  const entityType = opts.entityType || str(data.type);

  const total = pagination?.total ?? items.length;
  const header = `${entityType}s: showing ${items.length} of ${total}${
    pagination?.has_more ? ' (more available)' : ''
  }`;

  if (items.length === 0) return header;

  const list = formatEntityList(items as EntityRow[], entityType, opts);
  return `${header}\n\n${list}`;
}

function formatListEntitiesHydrated(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  const items = Array.isArray(data.data) ? data.data : [];
  const entityType = opts.entityType || str(data.type);
  const truncated = data.truncated === true;

  if (items.length === 0) return `${entityType} not found`;

  const item = items[0] as EntityRow;
  const title = str(item.title) || str(item.name) || 'Untitled';
  const status = str(item.status);
  const id = str(item.id);

  const lines: string[] = [
    `**${title}**${status ? ` [${status}]` : ''}${id ? ` id:${id}` : ''}`,
  ];

  // Summarize hydrated context
  const hydrated = data.hydrated_context as Record<string, unknown> | undefined;
  if (hydrated) {
    const entities = hydrated.entities as Record<string, unknown> | undefined;
    const artifacts = hydrated.artifacts as Record<string, unknown> | undefined;
    const planSessions = hydrated.plan_sessions as
      | Record<string, unknown>
      | undefined;
    const parts: string[] = [];
    if (entities) parts.push(`${Object.keys(entities).length} entities`);
    if (artifacts) parts.push(`${Object.keys(artifacts).length} artifacts`);
    if (planSessions)
      parts.push(`${Object.keys(planSessions).length} plan sessions`);
    if (parts.length > 0) {
      lines.push(`Context: ${parts.join(', ')}${truncated ? ' (truncated)' : ''}`);
    }
  }

  // Include key fields from the entity itself
  const description =
    str(item.description) || str(item.summary);
  if (description) {
    lines.push(`Description: ${truncateField(description, opts.maxFieldLength)}`);
  }

  return lines.join('\n');
}

function formatGetTaskWithContext(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  const task = data.task as EntityRow | undefined;
  if (!task) return 'Task not found';

  const title = str(task.title) || 'Untitled';
  const status = str(task.status);
  const priority = str(task.priority);
  const id = str(task.id);
  const truncated = data.truncated === true;

  const lines: string[] = [
    `**${title}**${status ? ` [${status}]` : ''}${priority ? ` P:${priority}` : ''}${id ? ` id:${id}` : ''}`,
  ];

  const description = str(task.description) || str(task.summary);
  if (description) {
    lines.push(`Description: ${truncateField(description, opts.maxFieldLength)}`);
  }

  // Summarize context
  const context = Array.isArray(data.context) ? data.context : [];
  if (context.length > 0) {
    lines.push(`Context pointers: ${context.length}`);
  }

  const hydrated = data.hydrated_context as Record<string, unknown> | undefined;
  if (hydrated && typeof hydrated === 'object') {
    const hydratedArray = Array.isArray(hydrated) ? hydrated : [];
    const entityMap = hydrated.entities as Record<string, unknown> | undefined;
    const artifactMap = hydrated.artifacts as
      | Record<string, unknown>
      | undefined;

    const parts: string[] = [];
    if (hydratedArray.length > 0) parts.push(`${hydratedArray.length} items`);
    if (entityMap) parts.push(`${Object.keys(entityMap).length} entities`);
    if (artifactMap)
      parts.push(`${Object.keys(artifactMap).length} artifacts`);
    if (parts.length > 0) {
      lines.push(
        `Hydrated: ${parts.join(', ')}${truncated ? ' (truncated)' : ''}`
      );
    }
  }

  return lines.join('\n');
}

function formatEntityAction(
  data: Record<string, unknown>,
  action: string
): string {
  const success = data.success !== false;
  const message = str(data.message);

  if (message) return `${success ? '✓' : '✗'} ${message}`;
  return `${success ? '✓' : '✗'} Action '${action}' completed`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format raw API data into a concise Markdown summary for LLM content blocks.
 * Call this instead of JSON.stringify(data) for non-widget tools.
 */
export function formatForLLM(
  toolId: string,
  data: Record<string, unknown>,
  opts?: FormatOptions
): string {
  const o: Required<FormatOptions> = { ...DEFAULT_OPTIONS, ...opts };

  switch (toolId) {
    case 'list_entities':
      if (data.hydrated_context) {
        return formatListEntitiesHydrated(data, o);
      }
      return formatListEntities(data, o);

    case 'get_task_with_context':
      return formatGetTaskWithContext(data, o);

    case 'entity_action':
      return formatEntityAction(data, str(data._action) || 'unknown');

    default:
      // For unrecognized tools, build a generic summary
      return formatGenericSummary(data, o);
  }
}

function formatGenericSummary(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  // If the data has a data array, treat it as a list
  if (Array.isArray(data.data)) {
    const items = data.data as EntityRow[];
    const entityType = opts.entityType || str(data.type) || 'item';
    return formatEntityList(items, entityType, opts);
  }

  // Single entity: show key fields
  const title = str(data.title) || str(data.name);
  const status = str(data.status);
  const id = str(data.id);
  const message = str(data.message);

  if (message) return message;

  const parts: string[] = [];
  if (title) parts.push(`**${title}**`);
  if (status) parts.push(`[${status}]`);
  if (id && opts.includeIds) parts.push(`id:${id}`);

  if (parts.length > 0) return parts.join(' ');

  // Last resort: list top-level keys
  const cleaned = stripEmpty(stripInternalFields(data));
  const keys = Object.keys(cleaned);
  return keys.length > 0
    ? `Result with ${keys.length} fields: ${keys.slice(0, 10).join(', ')}`
    : 'Done';
}
