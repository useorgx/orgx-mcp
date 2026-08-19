/**
 * Entity-write attribution.
 *
 * Server-side client attribution landed for the five client-integration
 * reporting tools, which default `source_client` from the session. Entity
 * writes — the tools that actually create decisions, artifacts, tasks and
 * initiatives — were left out, so nearly all durable work attributed to the
 * generic "orgx" client instead of claude-code / codex / chatgpt.
 *
 * Where the attribution goes is dictated by the storage shape the API reads:
 *  - `metadata.source_client` is what the work ledger reads back off
 *    `work_artifacts` (`metadata->>source_client`), and `metadata` is a real
 *    jsonb column on every entity table in the allowlist below;
 *  - `source_system` is a real column on `decision_requests` only, which is
 *    where decision attribution is read from.
 *
 * The create path copies unknown top-level fields straight into the insert, so
 * a top-level field is only ever set for a type whose table actually has that
 * column. Everything here is additive and never overrides a value the agent
 * supplied explicitly.
 *
 * Pure and deterministic: no IO, no worker state.
 */

/**
 * Entity types whose table has a `metadata` jsonb column and for which client
 * attribution is meaningful. Deliberately an allowlist: the create path passes
 * unknown fields through to PostgREST, so guessing wrong is a failed write.
 */
export const ATTRIBUTABLE_ENTITY_TYPES = new Set([
  'initiative',
  'workstream',
  'milestone',
  'task',
  'decision',
  'artifact',
  'run',
]);

/** Only `decision_requests` carries a `source_system` column. */
const SOURCE_SYSTEM_ENTITY_TYPES = new Set(['decision']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Default client attribution on an entity-create body.
 *
 * @param body           the create payload about to be POSTed to /api/entities
 * @param sourceClient   resolved client label (reporting enum value when the
 *                       client is recognized, otherwise the verbatim client
 *                       name — recording an unknown client beats recording
 *                       none, the same rule the session-summary ingest uses)
 */
export function applyEntityWriteAttribution(
  body: Record<string, unknown>,
  sourceClient: string | null | undefined
): Record<string, unknown> {
  const label = typeof sourceClient === 'string' ? sourceClient.trim() : '';
  if (!label) return body;

  const type = typeof body.type === 'string' ? body.type : '';
  if (!ATTRIBUTABLE_ENTITY_TYPES.has(type)) return body;

  const next: Record<string, unknown> = { ...body };
  const metadata = asRecord(next.metadata);

  if (!hasString(metadata.source_client)) {
    next.metadata = { ...metadata, source_client: label };
  }

  if (SOURCE_SYSTEM_ENTITY_TYPES.has(type) && !hasString(next.source_system)) {
    next.source_system = label;
  }

  return next;
}
