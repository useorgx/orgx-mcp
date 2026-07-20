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

import { formatContextPackSummary } from './contextPackSummary';

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
  const shown = items.slice(0, opts.maxItems);
  const lines = shown.map((item, i) => {
    const itemType = entityType === 'all' ? str(item.type) : entityType;
    const formatter = ROW_FORMATTERS[itemType] ?? formatGenericRow;
    const line = formatter(item, i + 1, opts);
    return entityType === 'all' && itemType
      ? `${line} type:${itemType}`
      : line;
  });
  const remaining = items.length - shown.length;
  if (remaining > 0) {
    lines.push(`\n... and ${remaining} more in structuredContent.`);
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
    | {
        total?: number;
        offset?: number;
        limit?: number;
        has_more?: boolean;
        next_offset?: number | null;
      }
    | undefined;
  const entityType = opts.entityType || str(data.type);

  const total =
    typeof pagination?.total === 'number' && pagination.total >= 0
      ? pagination.total
      : null;
  const header = `${entityType}s: showing ${items.length}${
    total !== null ? ` of ${total}` : ''
  }${
    pagination?.has_more ? ' (more available)' : ''
  }`;

  if (items.length === 0) return header;

  const list = formatEntityList(items as EntityRow[], entityType, opts);
  const nextOffset =
    typeof pagination?.next_offset === 'number'
      ? pagination.next_offset
      : pagination?.has_more &&
        typeof pagination.offset === 'number' &&
        typeof pagination.limit === 'number'
      ? pagination.offset + pagination.limit
      : null;
  const next =
    nextOffset !== null
      ? `\n\nNext page: call orgx_search with ${JSON.stringify({
          type: entityType,
          limit: pagination?.limit,
          offset: nextOffset,
        })}.`
      : '';
  return `${header}\n\n${list}${next}`;
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
  const resolvedAction = str(data._action) || str(data.action) || action;
  const entityType = str(data.entity_type) || str(data.type);
  const entityId = str(data.entity_id) || str(data.id);
  const target = entityType
    ? `${entityType}${entityId ? ` ${entityId}` : ''}`
    : 'entity';
  return `${success ? '✓' : '✗'} ${resolvedAction} completed for ${target}`;
}

function firstRecord(value: unknown): EntityRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as EntityRow;
}

function entityFromWriteResult(data: Record<string, unknown>): EntityRow | null {
  const direct = firstRecord(data.data);
  if (direct) return direct;
  const existing = firstRecord(data.existing);
  if (existing) return existing;
  const entity = firstRecord(data.entity);
  if (entity) return entity;
  if (str(data.id)) return data;
  return null;
}

function formatOrgxSearch(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  const results = Array.isArray(data.results)
    ? (data.results as EntityRow[])
    : Array.isArray(data.data)
    ? (data.data as EntityRow[])
    : [];
  const type = str(data.type) || opts.entityType || 'record';
  const query = str(data.query);
  const count =
    typeof data.count === 'number' ? data.count : results.length;
  const resultLabel = type === 'all' ? 'mixed result' : type;
  const header = `OrgX search: ${count} ${resultLabel}${count === 1 ? '' : 's'}${
    query ? ` for "${truncateField(query, 80)}"` : ''
  }.`;

  if (results.length === 0) {
    return `${header}\nNext: adjust query/type or call orgx_bootstrap to confirm visible tools and workspace context.`;
  }

  const nextCall = firstRecord(data.next_call);
  const next =
    nextCall?.tool === 'orgx_search' && firstRecord(nextCall.args)
      ? `Next page: call orgx_search with ${JSON.stringify(nextCall.args)}.`
      : 'Next: call orgx_inspect with the selected id for full context.';
  return `${header}\n\n${formatEntityList(results, type, opts)}\n\n${next}`;
}

function formatOrgxInspect(
  data: Record<string, unknown>,
  opts: Required<FormatOptions>
): string {
  const entity = firstRecord(data.entity) ?? firstRecord(data.data);
  if (!entity) return 'OrgX inspect returned no entity.';

  const type = str(data.type) || str(entity.type) || str(entity.entity_type) || 'entity';
  const line = formatGenericRow(entity, 1, opts).replace(/^1\. /, '');
  const description = str(entity.description) || str(entity.summary);
  const details = description
    ? `\nDescription: ${truncateField(description, opts.maxFieldLength)}`
    : '';
  const context = formatContextPackSummary(data.context_pack, opts);
  return `OrgX ${type}: ${line}${details}${
    context ? `\n\n${context}` : ''
  }`;
}

function formatOrgxWrite(data: Record<string, unknown>): string {
  const operation = str(data.operation) || 'write';
  const replayed = data.idempotent_replay === true || data.replayed === true;
  const entity = entityFromWriteResult(data);
  const type =
    str(entity?.type) ||
    str(entity?.entity_type) ||
    str(data.type) ||
    'entity';
  const title =
    str(entity?.title) ||
    str(entity?.name) ||
    str(data.title) ||
    str(data.name) ||
    type;
  const id = str(entity?.id) || str(data.id) || str(data.entity_id);
  const status = str(entity?.status) || str(data.status);
  const prefix =
    operation === 'update'
      ? 'Updated'
      : replayed
      ? 'Reused existing'
      : 'Created';
  const parts = [`${prefix} ${type}: **${title}**`];
  if (status) parts.push(`[${status}]`);
  if (id) parts.push(`id:${id}`);

  const next: string[] = [];
  if (type === 'initiative' && id) {
    next.push(`orgx_inspect type="initiative" id="${id}"`);
    next.push(`orgx_write type="workstream" initiative_id="${id}"`);
  } else if (id) {
    next.push(`orgx_inspect type="${type}" id="${id}"`);
  }

  return `${parts.join(' ')}${
    next.length > 0 ? `\nNext: ${next.join(' or ')}.` : ''
  }`;
}

function formatOrgxReceipt(data: Record<string, unknown>): string {
  const receipt = firstRecord(data.receipt) ?? firstRecord(data.data) ?? data;
  const id = str(receipt.id) || str(receipt.receipt_id) || str(data.receipt_id);
  const summary = str(receipt.summary) || str(data.summary) || 'Receipt submitted';
  const status =
    str(data.verification_status) ||
    str(receipt.verification_status) ||
    str(data.status);
  const loopValidation = firstRecord(data.loop_validation);
  const promotable =
    typeof loopValidation?.promotable === 'boolean'
      ? ` promotable:${loopValidation.promotable}`
      : '';
  return `OrgX receipt: ${summary}${status ? ` [${status}]` : ''}${
    id ? ` id:${id}` : ''
  }${promotable}`;
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

    case 'orgx_search':
      return formatOrgxSearch(data, o);

    case 'orgx_inspect':
      return formatOrgxInspect(data, o);

    case 'orgx_write':
      return formatOrgxWrite(data);

    case 'orgx_submit_receipt':
      return formatOrgxReceipt(data);

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
