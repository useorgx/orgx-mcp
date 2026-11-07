/**
 * orgx_search is read by people (the search card) and by agents that paste
 * its results into chat, so nothing it returns should read like internals.
 *
 * Two places leaked them:
 * - Failures. The memory and entities APIs return their raw error text (a
 *   database message, "Database client not configured", provider JSON), and
 *   search passed it straight to the caller.
 * - Records. A run's title can be its whole assignment prompt, and a
 *   receipt's summary a bare runtime code or a provider error with its
 *   request id.
 *
 * The app now cleans memory search results itself (hopeatina/orgx
 * lib/server/memory/legibleResult.ts). This module is the boundary's own
 * copy, so typed collection results and older app versions read the same.
 * Applying it twice changes nothing.
 */

const PROMPT_SCAFFOLD = /##+\s*Your Assignment|\*\*Goal:\*\*/i;
const GOAL_LINE = /\*\*Goal:\*\*\s*([^\n]+)/i;
const AGENT_PREFIX = /^([A-Z][\w .'-]{1,30}):\s*(?=##|\*\*Goal)/;
const MARKDOWN_MARKS = /(^|\s)#{1,6}\s+|\*\*|__|`/g;
const CONTINUATION_CODE = /^Continuation failed:\s*([a-z][a-z0-9_]*)\s*$/i;
const BARE_CODE = /^[a-z]+(?:_[a-z0-9]+)+$/;
const TRAILING_CODE = /^([A-Z][\w ]{1,40}?):\s*([a-z]+(?:_[a-z0-9]+)+)\s*$/;
const RAW_MARKERS =
  /\{\s*"|\brequest_id\b|\breq_[A-Za-z0-9]{8,}|\(status=\d{3}\)|\(cause=|\bat [\w.<>]+ \(|PGRST\d+|\bSQLSTATE\b|\bstack\b:/;
const DATABASE_TEXT =
  /\brelation "|\bcolumn "|syntax error at|violates (?:foreign key|unique|check|not-null)|duplicate key value|permission denied for|Database (?:client )?not (?:configured|available)|ECONNREFUSED|ETIMEDOUT|fetch failed/i;
const TITLE_MAX = 120;

/**
 * Continuation codes the review packet RPC writes, in words. Mirrors
 * describeUnresumedContinuation in hopeatina/orgx lib/reviewPackets/continuationOutcome.ts.
 */
const CONTINUATION_COPY: Record<string, string> = {
  no_stream_targets: 'Approval recorded, but it is not bound to a workstream or stream, so no work resumed.',
  credentials_not_configured: 'Approval recorded; work is waiting on missing credentials.',
  access_not_validated: 'Approval recorded; the granted access has not been validated yet.',
  missing_capability_context: 'Approval recorded, but the decision does not name the capability to enable.',
  capability_enablement_failed: 'Approval recorded; enabling the capability failed.',
  capability_not_ready: 'Approval recorded; the capability is not ready yet.',
  missing_initiative_id: 'Approval recorded, but the decision has no initiative, so nothing could resume.',
  missing_workspace_id: 'Approval recorded, but the decision has no workspace, so nothing could resume.',
  invalid_continuation_scope: 'Approval recorded, but its continuation scope failed validation, so nothing resumed.',
  stream_lookup_failed: 'Approval recorded; loading the affected streams failed.',
  stream_projection_failed: 'Approval recorded; resuming the affected streams failed.',
  stream_projection_invalid: 'Approval recorded; the affected streams rejected the transition, so nothing resumed.',
  budget_projection_failed: 'Approval recorded; applying the budget change failed.',
};

/** Runtime stop codes, in words. Unknown codes fall back to a plain sentence. */
const RUNTIME_CODE_COPY: Record<string, string> = {
  model_budget_exhausted: 'the run reached its model budget before finishing.',
  run_budget_exhausted: 'the run reached its budget before finishing.',
  rate_limited: 'the model provider was rate limiting requests.',
  provider_unavailable: 'the model provider was unavailable.',
  timeout: 'the run timed out.',
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function stripMarkdown(text: string): string {
  return text.replace(MARKDOWN_MARKS, '$1').replace(/\s+/g, ' ').trim();
}

/** True when text is a code, raw provider error, stack or database message rather than prose. */
export function isRawErrorText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    BARE_CODE.test(trimmed) ||
    TRAILING_CODE.test(trimmed) ||
    RAW_MARKERS.test(trimmed) ||
    DATABASE_TEXT.test(trimmed) ||
    /run job missing runId|recovery checkpoint unavailable or already consumed/i.test(trimmed)
  );
}

/** A title a person can scan: an assignment prompt becomes its goal line. */
export function legibleRecordTitle(title: unknown): unknown {
  if (typeof title !== 'string') return title;
  const raw = title.trim();
  if (!raw) return title;
  if (PROMPT_SCAFFOLD.test(raw)) {
    const prefix = AGENT_PREFIX.exec(raw)?.[1];
    const goal = GOAL_LINE.exec(raw)?.[1];
    const label = clip(stripMarkdown(goal ?? raw.replace(/##+\s*Your Assignment/i, '')), TITLE_MAX);
    if (!label) return 'Agent run';
    return prefix ? `${prefix}: ${label}` : label;
  }
  return /\*\*|`|^#{1,6}\s/.test(raw) ? stripMarkdown(raw) : title;
}

/**
 * A summary a person can read, or null when the stored summary only repeats
 * an assignment prompt or carries nothing but internals. Prose is unchanged.
 */
export function legibleRecordSummary(summary: unknown): unknown {
  if (typeof summary !== 'string') return summary;
  const raw = summary.trim();
  if (!raw) return summary;
  const continuation = CONTINUATION_CODE.exec(raw);
  if (continuation) {
    return CONTINUATION_COPY[continuation[1].toLowerCase()] ?? 'Approval recorded, but no work resumed.';
  }
  if (PROMPT_SCAFFOLD.test(raw)) return null;
  if (!isRawErrorText(raw)) return summary;
  if (/run job missing runId/i.test(raw)) {
    return 'The run never started: its job was queued without a run to attach to. Retry the run.';
  }
  if (/recovery checkpoint unavailable or already consumed/i.test(raw)) {
    return 'The run could not resume: its recovery checkpoint was missing or already used. Restart the run.';
  }
  const trailing = TRAILING_CODE.exec(raw);
  if (trailing) {
    const reason = RUNTIME_CODE_COPY[trailing[2].toLowerCase()];
    return reason ? `${trailing[1]}: ${reason}` : `${trailing[1]}.`;
  }
  if (BARE_CODE.test(raw)) {
    const reason = RUNTIME_CODE_COPY[raw.toLowerCase()];
    return reason ? `Stopped: ${reason}` : null;
  }
  // A provider error: keep its label and the provider's own message, drop the JSON.
  const label = /^([A-Z][\w ]{1,40}?) (failed|stopped):/.exec(raw);
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.){1,240})"/.exec(raw)?.[1]?.replace(/\\"/g, '"');
  if (message && !isRawErrorText(message)) {
    const text = stripMarkdown(message);
    return label ? `${label[1]} ${label[2]}: ${text}` : text;
  }
  return label ? `${label[1]} ${label[2]}.` : null;
}

const SUMMARY_KEYS = ['summary', 'snippet', 'excerpt'] as const;

/** Apply both projections to one search record; other fields are kept as they are. */
export function legibleSearchRecord(record: Record<string, unknown>): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const set = (key: string, value: unknown) => {
    if (value === record[key]) return;
    next ??= { ...record };
    next[key] = value;
  };
  if ('title' in record) set('title', legibleRecordTitle(record.title));
  if ('name' in record) set('name', legibleRecordTitle(record.name));
  for (const key of SUMMARY_KEYS) {
    if (key in record) set(key, legibleRecordSummary(record[key]));
  }
  // A description that is only a prompt scaffold carries nothing a reader needs.
  if (typeof record.description === 'string' && PROMPT_SCAFFOLD.test(record.description)) {
    set('description', null);
  }
  return next ?? record;
}

export function legibleSearchRecords(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return records.map(legibleSearchRecord);
}

/** The backend's own words for a failure, when it sent any. */
export function backendErrorText(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail']) {
    const value = root[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return null;
}

/**
 * The message a search failure shows. The backend's text passes only when it
 * reads as a sentence meant for people; everything else becomes a plain
 * message chosen by status, and the raw text stays in the logs.
 */
export function legibleSearchFailure(status: number | undefined, backendText: string | null): string {
  if (
    backendText &&
    status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 &&
    backendText.length <= 240 &&
    /^[A-Z]/.test(backendText) &&
    !isRawErrorText(backendText)
  ) {
    return backendText;
  }
  if (status === 401 || status === 403) {
    return 'OrgX could not confirm you can search this workspace. Reconnect OrgX and search again.';
  }
  if (status === 404) return 'That workspace was not found. Check the workspace and search again.';
  if (status === 429) return 'OrgX is handling too many searches right now. Wait a moment and search again.';
  if (status !== undefined && status >= 400 && status < 500) {
    return 'OrgX could not run that search. Check the query and filters, then search again.';
  }
  return 'Search is temporarily unavailable. Your query was not changed; search again in a moment.';
}
