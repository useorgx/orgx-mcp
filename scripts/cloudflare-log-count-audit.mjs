import { ACCOUNT_ID, SCRIPT_NAME, WINDOW_MS, MAX_RESPONSE_BYTES } from './cloudflare-read-only-audit.mjs';

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry`;
export const KEYS_ENDPOINT = `${BASE}/keys`;
export const COUNTS_ENDPOINT = `${BASE}/query`;
export const LEVEL_LIMIT = 16;
export const RETAINED_DEADLINE_MS = 30_000;
export const KEY_NEEDLE = '^\\$metadata\\.(service|level|message)$';
// Reviewed public source prefixes only; never group by or return message text.
export const WARNING_CATEGORIES = Object.freeze([
  { id: 'api_fallback_attempt', label: 'API fallback attempted', pattern: '^\\[orgx-api\\] trying fallback' },
  { id: 'api_fallback_recovered', label: 'API fallback recovered', pattern: '^\\[orgx-api\\] fallback succeeded' },
  { id: 'distributed_admission', label: 'Distributed admission unavailable', pattern: '^\\[rate-limit\\] Distributed admission unavailable' },
  { id: 'auth_rejected', label: 'Authentication or scope rejected', pattern: '^\\[auth\\] (Bearer token invalid or expired|Tool blocked due to (missing_authentication|insufficient_scope))' },
  { id: 'profiles_restricted', label: 'Tool profile restricted', pattern: '^\\[mcp:profiles\\] (Unknown tool profile|External full profile request); failing closed to read-only surface' },
  { id: 'session_storage', label: 'Session or client storage warning', pattern: '^\\[(mcp:session|mcp:client-info)\\] ' },
  { id: 'telemetry', label: 'Telemetry or activation warning', pattern: '^\\[(mcp:session-summary|mcp:telemetry|mcp:activation|telemetry)\\] ' },
  { id: 'reads_widgets_transport', label: 'Read, widget or transport warning', pattern: '^\\[(mcp:orgx|mcp:workspace|mcp:bootstrap|panel|live-grant)\\] |^\\[mcp\\] (related context enrichment skipped|recovered transient Durable Object transport failure)|"component":"live-feed-do".*"event":"(client_rejected_at_capacity|backfill_failed|alarm_schedule_failed|poll_failed|client_write_failed)"' },
].map(Object.freeze));
// RE2 text search is evaluated by Cloudflare. Matches are never requested.
export const CREDENTIAL_NEEDLE = 'Bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}|(access_token|refresh_token|client_secret|api[_-]?key)[[:space:]"\x27]{0,8}[:=][[:space:]"\x27]{0,8}[A-Za-z0-9._~+/-]{16,}';
const WORKER_FILTER = Object.freeze({ key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT_NAME });
const LEVELS = new Set(['log', 'debug', 'info', 'warn', 'error']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const sample = (value) => number(value) !== null && value >= 1 ? value : null;

function baseReport(now) {
  return {
    status: 'unavailable', reason: 'not_observed',
    window: { start: new Date(now - WINDOW_MS).toISOString(), end: new Date(now).toISOString() },
    keysVerified: { worker: false, level: false, message: false }, levels: [], levelsMayBeTruncated: null,
    credentialIndicators: { matchingEvents: null, sampleInterval: null, queryAbrLevel: null },
    warningCategories: WARNING_CATEGORIES.map(({ id, label }) => ({ id, label, matchingEvents: null, sampleInterval: null, queryAbrLevel: null })),
    dataBoundary: 'Numeric counts of retained stored events, not requests. No event contents or arbitrary provider fields retained.',
    coverageBoundary: 'Counts may be sampling-weighted. Credential-shape matches are indicators, not proof of a leak; zero does not prove absence. WAF events before Worker execution are outside scope.',
    warningBoundary: 'Fixed warning-message categories can overlap and do not cover every warning. Counts are events, not failed requests or proof of a fault. This rolling-hour cohort must not be reconciled with older reports.',
  };
}

/** Build only fixed, worker-scoped, non-persistent aggregate requests. */
export function logAuditRequests(now) {
  const timeframe = { from: now - WINDOW_MS, to: now };
  const parameters = {
    datasets: ['cloudflare-workers'], filterCombination: 'and', filters: [{ ...WORKER_FILTER }],
  };
  const query = {
    view: 'calculations', dry: true, chart: false, chartType: 'aggregate', ignoreSeries: true,
    timeframe,
  };
  return {
    keys: {
      datasets: ['cloudflare-workers'], filters: [{ ...WORKER_FILTER }],
      from: timeframe.from, to: timeframe.to,
      keyNeedle: { value: KEY_NEEDLE, isRegex: true, matchCase: true }, limit: 4,
    },
    levels: {
      ...query, queryId: 'orgx-mcp-log-level-counts-v1', limit: LEVEL_LIMIT,
      parameters: { ...parameters, calculations: [{ operator: 'count', alias: 'stored_events' }],
        groupBys: [{ type: 'string', value: '$metadata.level' }], limit: LEVEL_LIMIT },
    },
    credentials: {
      ...query, queryId: 'orgx-mcp-credential-shape-count-v1', limit: 1,
      parameters: { ...parameters, calculations: [{ operator: 'count', alias: 'credential_indicators' }],
        groupBys: [], limit: 1,
        needle: { value: CREDENTIAL_NEEDLE, isRegex: true, matchCase: false } },
    },
    warnings: WARNING_CATEGORIES.map(({ id, pattern }) => ({
      ...query, queryId: `orgx-mcp-warning-${id}-v1`, limit: 1,
      parameters: { ...parameters, calculations: [{ operator: 'count', alias: `warning_${id}` }],
        groupBys: [], limit: 1, filters: [...parameters.filters,
          { key: '$metadata.level', operation: 'eq', type: 'string', value: 'warn' },
          { key: '$metadata.message', operation: 'regex', type: 'string', value: pattern }],
      },
    })),
  };
}

function unwrap(payload) {
  const raw = record(payload);
  if (raw.success !== true || Array.isArray(raw.errors) && raw.errors.length) {
    const denied = Array.isArray(raw.errors) && raw.errors.some((entry) => {
      const message = record(entry).message;
      return typeof message === 'string' && /not authori[sz]ed|permission|forbidden|unauthori[sz]ed|authentication|authorization/i.test(message);
    });
    throw new Error(denied ? 'permission_denied' : 'query_refused');
  }
  return raw.result;
}

function verifyKeys(payload) {
  const rows = unwrap(payload);
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 3) throw new Error('field_keys_unverified');
  const seen = new Set();
  for (const row of rows) {
    const { key, type } = record(row);
    if (!['$metadata.service', '$metadata.level', '$metadata.message'].includes(key) || type !== 'string' || seen.has(key)) {
      throw new Error('field_keys_unverified');
    }
    seen.add(key);
  }
  if (!seen.has('$metadata.service') || !seen.has('$metadata.level')) throw new Error('field_keys_unverified');
  return seen.has('$metadata.message');
}

function calculation(payload, alias, limit) {
  const result = record(unwrap(payload));
  if (record(result.run).status !== 'COMPLETED' || record(result.run).dry !== true) throw new Error('query_not_completed');
  if (!Array.isArray(result.calculations) || result.calculations.length !== 1) throw new Error('invalid_count_response');
  const row = record(result.calculations[0]);
  if (row.alias !== alias || !Array.isArray(row.aggregates) || row.aggregates.length > limit) throw new Error('invalid_count_response');
  return { rows: row.aggregates, queryAbrLevel: number(record(result.statistics).abr_level) };
}

function readLevels(payload) {
  const { rows, queryAbrLevel } = calculation(payload, 'stored_events', LEVEL_LIMIT);
  if (!rows.length) throw new Error('no_log_aggregate_rows');
  const levels = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!Array.isArray(row.groups) || row.groups.length !== 1 || record(row.groups[0]).key !== '$metadata.level') {
      throw new Error('invalid_count_response');
    }
    const level = record(row.groups[0]).value;
    const count = number(row.value), sampleInterval = sample(row.sampleInterval);
    if (count === null) throw new Error('invalid_count_response');
    // Unknown values may be arbitrary strings. Keep a fixed label, never their text.
    levels.push({ level: typeof level === 'string' && LEVELS.has(level) ? level : 'other', matchingEvents: count, sampleInterval, queryAbrLevel });
  }
  return { levels, levelsMayBeTruncated: rows.length === LEVEL_LIMIT };
}

function readCount(payload, alias, absentReason) {
  const { rows, queryAbrLevel } = calculation(payload, alias, 1);
  if (rows.length !== 1) throw new Error(absentReason);
  const row = record(rows[0]);
  if (row.groups !== undefined && (!Array.isArray(row.groups) || row.groups.length)) throw new Error('invalid_count_response');
  const matchingEvents = number(row.value), sampleInterval = sample(row.sampleInterval);
  if (matchingEvents === null) throw new Error('invalid_count_response');
  return { matchingEvents, sampleInterval, queryAbrLevel };
}

const SAFE_REASONS = new Set(['permission_denied', 'query_refused', 'field_keys_unverified', 'query_not_completed',
  'invalid_count_response', 'no_log_aggregate_rows', 'no_credential_aggregate_rows', 'no_warning_aggregate_rows', 'response_byte_limit', 'invalid_api_json']);

/** At most eleven fixed reads share one 30-second deadline; no retries or raw events. */
export async function auditCloudflareLogCounts({ token, fetchImpl = fetch, now = Date.now() } = {}) {
  let report = baseReport(now);
  if (typeof token !== 'string' || !token.trim()) return { ...report, reason: 'credential_unavailable' };
  const requests = logAuditRequests(now);
  const controller = new AbortController();
  const expiresAt = performance.now() + RETAINED_DEADLINE_MS;
  let reader, ended = false, timer;
  const check = () => {
    if (controller.signal.aborted || performance.now() >= expiresAt) throw new Error('audit_deadline');
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('audit_deadline')); }, RETAINED_DEADLINE_MS);
  });
  async function post(endpoint, body) {
    check();
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('audit_deadline');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error([401, 403].includes(response.status) ? 'permission_denied' : 'query_refused');
    }
    reader = response.body?.getReader(); ended = false;
    if (!reader) throw new Error('invalid_api_json');
    const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let length = 0;
    for (;;) {
      check();
      const chunk = await reader.read();
      check();
      if (chunk.done) { ended = true; break; }
      if (length + chunk.value.byteLength > MAX_RESPONSE_BYTES) throw new Error('response_byte_limit');
      bytes.set(chunk.value, length); length += chunk.value.byteLength;
    }
    reader.releaseLock(); reader = undefined;
    try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
    catch { throw new Error('invalid_api_json'); }
  }
  try {
    return await Promise.race([(async () => {
      const message = verifyKeys(await post(KEYS_ENDPOINT, requests.keys));
      report = { ...report, keysVerified: { worker: true, level: true, message } };
      report = { ...report, ...readLevels(await post(COUNTS_ENDPOINT, requests.levels)) };
      report = { ...report, credentialIndicators: readCount(await post(COUNTS_ENDPOINT, requests.credentials), 'credential_indicators', 'no_credential_aggregate_rows') };
      if (!message) return { ...report, status: 'partial', reason: 'warning_message_key_unverified' };
      for (const [index, { id }] of WARNING_CATEGORIES.entries()) {
        const count = readCount(await post(COUNTS_ENDPOINT, requests.warnings[index]), `warning_${id}`, 'no_warning_aggregate_rows');
        report = { ...report, warningCategories: report.warningCategories.map((row, i) => i === index ? { ...row, ...count } : row) };
      }
      const samplingUnknown = [...report.levels, report.credentialIndicators, ...report.warningCategories].some((row) => row.sampleInterval === null || row.queryAbrLevel === null);
      return { ...report,
        status: report.levelsMayBeTruncated || samplingUnknown ? 'partial' : 'observed',
        reason: report.levelsMayBeTruncated ? 'log_groups_may_be_truncated' : samplingUnknown ? 'log_sampling_unverified' : 'retained_counts_observed' };
    })(), deadline]);
  } catch (error) {
    const reason = controller.signal.aborted || performance.now() >= expiresAt ? 'audit_deadline'
      : error instanceof Error && SAFE_REASONS.has(error.message) ? error.message : 'network_unavailable';
    return { ...report, status: reason === 'permission_denied' ? 'permission_denied' : 'unavailable', reason };
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) {
      if (!ended) void reader.cancel('Log count audit finished').catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export function formatLogCountSummary(report) {
  const value = (number) => number === null ? 'Unknown' : String(number);
  const levels = report.levels.map((row) => `| ${row.level} | ${value(row.matchingEvents)} | ${value(row.sampleInterval)} |`).join('\n');
  const warnings = report.warningCategories.map((row) => `| ${row.label} | ${value(row.matchingEvents)} | ${value(row.sampleInterval)} |`).join('\n');
  return `## Cloudflare retained log counts\n\nStatus: **${report.status}** (${report.reason}).\n\n` +
    `| Stored event level | Matching events | Sample interval |\n| --- | ---: | ---: |\n${levels}\n\n` +
    `Credential-shape matching events: **${value(report.credentialIndicators.matchingEvents)}**.\n\n` +
    `| Fixed warning category | Matching events | Sample interval |\n| --- | ---: | ---: |\n${warnings}\n\n` +
    `${report.dataBoundary}\n\n${report.coverageBoundary}\n\n${report.warningBoundary}\n`;
}
