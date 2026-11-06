import { documentExcerpt } from './documentExcerpt';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function reportExcerpt(value: unknown, limit = 240) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return documentExcerpt(value, limit).text ?? '';
}

function mapRows(value: unknown, project: (row: Record<string, unknown>) => Record<string, unknown>) {
  return Array.isArray(value) ? value.map((row) => record(row) ? project(row) : row) : value;
}

function summaryRow(row: Record<string, unknown>) {
  if (typeof row.summary !== 'string' || row.summary.length <= 240) return row;
  return { ...row, summary: reportExcerpt(row.summary), summary_truncated: true };
}

function artifactRow(row: Record<string, unknown>) {
  const { metadata, content, preview_markdown, ...head } = row;
  return summaryRow(head);
}

export function projectChronicleOverview(data: Record<string, unknown>): Record<string, unknown> {
  const chronicle = data.chronicle;
  if (!record(chronicle)) return data;
  const continuity = chronicle.continuity;
  const workspace = typeof chronicle.workspaceId === 'string' ? { workspace_id: chronicle.workspaceId } : {};
  const period = typeof chronicle.period === 'string' ? { period: chronicle.period } : {};
  return {
    ...data,
    chronicle: {
      ...chronicle,
      summary: reportExcerpt(chronicle.summary, 480),
      rollups: mapRows(chronicle.rollups, (row) => {
        // Headline metrics and the canonical chronology already carry these records.
        const { resolvedDecisionHighlights, pendingDecisionHighlights, ...head } = row;
        return summaryRow(head);
      }),
      decisionChronology: mapRows(chronicle.decisionChronology, summaryRow),
      artifactLedger: mapRows(chronicle.artifactLedger, artifactRow),
      continuity: record(continuity) ? {
        ...continuity,
        events: mapRows(continuity.events, summaryRow),
        clients: mapRows(continuity.clients, ({ health, ...client }) => client),
      } : continuity,
      overview: {
        fullCall: { tool: 'orgx_get_operator_brief', args: { ...workspace, ...period, detail: 'full' } },
      },
    },
  };
}

export function projectLedgerOverview(data: Record<string, unknown>) {
  return {
    ...data,
    ...(Array.isArray(data.results) ? { results: mapRows(data.results, summaryRow) } : {}),
    ...(Array.isArray(data.items) ? { items: mapRows(data.items, summaryRow) } : {}),
  };
}
