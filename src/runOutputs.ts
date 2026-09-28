/**
 * Run outputs for orgx_inspect type=run.
 *
 * A run's deliverable is stored as a run artifact (and promoted to a work
 * artifact), not on the run row, so inspecting a run by id used to show no
 * answer. The app's GET /api/v1/runs/{id}/artifacts returns them, scoped to
 * the caller the same way the run row is. Pure helpers here; the fetch rides
 * the gateway's identity headers in index.ts.
 *
 * @module runOutputs
 */

/** Characters of each output's body shown in the text summary. */
export const RUN_OUTPUT_TEXT_CHARS = 1_200;
export const RUN_OUTPUTS_TEXT_LIMIT = 5;

export interface RunOutput {
  run_artifact_id: string;
  work_artifact_id: string | null;
  title: string;
  type: string;
  status: string | null;
  summary: string | null;
  excerpt: string | null;
  excerpt_truncated: boolean;
  url: string | null;
  created_at: string | null;
}

export interface RunOutputs {
  outputs: RunOutput[];
  has_more: boolean;
}

export function runOutputsApiPath(runId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/artifacts`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pure: the app's `{ ok, data: { outputs, has_more } }` body to RunOutputs.
 * Anything unexpected (an older app, an error body) reads as null so the
 * caller can attach the field additively.
 */
export function normalizeRunOutputs(body: unknown): RunOutputs | null {
  const data = record(record(body)?.data);
  if (!data || !Array.isArray(data.outputs)) return null;
  const outputs: RunOutput[] = [];
  for (const item of data.outputs) {
    const row = record(item);
    const id = text(row?.run_artifact_id);
    if (!row || !id) continue;
    outputs.push({
      run_artifact_id: id,
      work_artifact_id: text(row.work_artifact_id),
      title: text(row.title) ?? 'Run output',
      type: text(row.type) ?? 'document',
      status: text(row.status),
      summary: text(row.summary),
      excerpt: typeof row.excerpt === 'string' ? row.excerpt : null,
      excerpt_truncated: row.excerpt_truncated === true,
      url: text(row.url),
      created_at: text(row.created_at),
    });
  }
  return { outputs, has_more: data.has_more === true };
}

/** Pure: the "Outputs" block of orgx_inspect's text for a run. */
export function formatRunOutputsSummary(value: unknown): string | null {
  const outputs = record(value)?.outputs;
  if (!Array.isArray(outputs)) return null;
  if (outputs.length === 0) return 'Outputs: none recorded for this run.';
  const lines = [`Outputs (${outputs.length}, newest first):`];
  for (const item of outputs.slice(0, RUN_OUTPUTS_TEXT_LIMIT)) {
    const output = record(item);
    if (!output) continue;
    const ids = [
      text(output.work_artifact_id)
        ? `work_artifact_id:${text(output.work_artifact_id)}`
        : null,
      `run_artifact_id:${text(output.run_artifact_id)}`,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`- ${text(output.title) ?? 'Run output'} (${text(output.type) ?? 'document'}) ${ids}`);
    const body = text(output.excerpt) ?? text(output.summary);
    if (body) {
      const cut = body.length > RUN_OUTPUT_TEXT_CHARS;
      const shown = body.slice(0, RUN_OUTPUT_TEXT_CHARS);
      lines.push(
        shown
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n') +
          (cut || output.excerpt_truncated === true ? '\n  […truncated]' : '')
      );
    }
  }
  if (outputs.length > RUN_OUTPUTS_TEXT_LIMIT || record(value)?.has_more === true) {
    lines.push('More outputs exist; see structuredContent.outputs or the work artifacts.');
  }
  return lines.join('\n');
}
