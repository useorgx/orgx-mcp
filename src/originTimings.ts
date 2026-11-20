/** Fixed origin stages only. Never retain arbitrary header names or descriptions. */
export const ORIGIN_TIMING_STAGES = [
  'identity', 'run_binding', 'rate_limit', 'metering', 'allowance',
  'envelope', 'execution', 'delegation', 'total',
] as const;
type OriginTimingStage = typeof ORIGIN_TIMING_STAGES[number];
export type OriginTimings = Partial<Record<OriginTimingStage, { sum_ms: number; count: number }>>;

const MAX_HEADER_CHARS = 8192;
const MAX_STAGE_MS = 300_000;
const originStageNames = new Map<string, OriginTimingStage>(
  ORIGIN_TIMING_STAGES.map((stage) => [`orgx_mcp_${stage}`, stage])
);
const contextPackStageNames = new Map([
  ['context_prepare', 'context_prepare_ms'],
  ['context_scope', 'context_scope_ms'],
] as const);

/**
 * Parse our canonical numeric Server-Timing form, not the general header grammar.
 * Ambiguous duplicates, noncanonical durations and oversized headers contribute
 * no sample. A missing/invalid stage remains absent rather than becoming zero.
 */
function readFixedTimings<Stage extends string>(
  header: string | null,
  stages: ReadonlyMap<string, Stage>
): Partial<Record<Stage, number>> {
  if (!header || header.length > MAX_HEADER_CHARS || header.includes('"')) return {};
  const values: Partial<Record<Stage, number>> = {};
  const seen = new Set<Stage>();
  for (const metric of header.split(',')) {
    const [rawName, ...parameters] = metric.trim().split(';');
    const stage = stages.get(rawName.trim());
    if (stage === undefined) continue;
    if (seen.has(stage)) { delete values[stage]; continue; }
    seen.add(stage);
    if (parameters.length !== 1) continue;
    const duration = /^dur=((?:0|[1-9]\d*)(?:\.\d{1,3})?)$/.exec(parameters[0].trim());
    if (!duration) continue;
    const value = Number(duration[1]);
    if (Number.isFinite(value) && value >= 0 && value <= MAX_STAGE_MS) values[stage] = value;
  }
  return values;
}

export function readOriginTimings(header: string | null) {
  return readFixedTimings(header, originStageNames);
}

export function readContextPackTimings(header: string | null) {
  return readFixedTimings(header, contextPackStageNames);
}

/** Sums include every timed API attempt, including retries and concurrent calls. */
export function addOriginTimings(totals: OriginTimings, header: string | null): void {
  const values = readOriginTimings(header);
  for (const stage of ORIGIN_TIMING_STAGES) {
    const value = values[stage];
    if (value === undefined) continue;
    const previous = totals[stage];
    totals[stage] = { sum_ms: (previous?.sum_ms ?? 0) + value, count: (previous?.count ?? 0) + 1 };
  }
}

export const ORIGIN_PERFORMANCE_KEYS = ORIGIN_TIMING_STAGES.flatMap((stage) =>
  [`origin_${stage}_ms`, `origin_${stage}_count`]);

/** These are per-stage sums and sample counts, never the invocation critical path. */
export function originTimingPerformance(totals: OriginTimings | undefined): Record<string, number> {
  return Object.fromEntries(ORIGIN_TIMING_STAGES.flatMap((stage) => {
    const value = totals?.[stage];
    return value ? [[`origin_${stage}_ms`, value.sum_ms], [`origin_${stage}_count`, value.count]] : [];
  }));
}
