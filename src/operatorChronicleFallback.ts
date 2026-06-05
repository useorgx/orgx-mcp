export type OperatorChroniclePeriod = 'day' | 'week' | '30d';

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function normalizeOperatorChroniclePeriod(
  value: unknown
): OperatorChroniclePeriod {
  return value === 'day' || value === 'week' || value === '30d'
    ? value
    : '30d';
}

export function buildOperatorChroniclePath(
  args: Record<string, unknown>,
  sessionWorkspaceId?: string | null
): string {
  const params = new URLSearchParams();
  params.set('period', normalizeOperatorChroniclePeriod(args.period));

  const workspaceId =
    typeof args.workspace_id === 'string' && args.workspace_id.trim()
      ? args.workspace_id.trim()
      : sessionWorkspaceId?.trim() || null;
  if (workspaceId) params.set('workspace_id', workspaceId);

  const commandCenterId =
    typeof args.command_center_id === 'string' && args.command_center_id.trim()
      ? args.command_center_id.trim()
      : null;
  if (commandCenterId) params.set('command_center_id', commandCenterId);

  return `/api/operator/chronicle?${params.toString()}`;
}

export function formatOperatorChronicleBrief(data: Record<string, unknown>) {
  const explicitChronicle = readRecord(data.chronicle);
  const dataChronicle = readRecord(readRecord(data.data).chronicle);
  const payload = Object.keys(dataChronicle).length
    ? dataChronicle
    : Object.keys(explicitChronicle).length
    ? explicitChronicle
    : data;
  const reportingNarrative = readRecord(payload.reportingNarrative);
  const briefMarkdown = reportingNarrative.briefMarkdown;
  if (typeof briefMarkdown === 'string' && briefMarkdown.trim()) {
    return briefMarkdown.trim();
  }

  const headline =
    typeof payload.headline === 'string' && payload.headline.trim()
      ? payload.headline.trim()
      : 'Operator chronicle ready';
  const metrics = readRecord(payload.metrics);
  const nextAction =
    typeof reportingNarrative.nextAction === 'string' &&
    reportingNarrative.nextAction.trim()
      ? reportingNarrative.nextAction.trim()
      : null;

  const lines = [
    `# ${headline}`,
    '',
    `- Decisions pending: ${readNumber(metrics.pendingDecisions)}`,
    `- Blocked work: ${readNumber(metrics.blockedWork)}`,
    `- Artifacts: ${readNumber(metrics.artifactsProduced)}`,
    `- PR receipts: ${readNumber(metrics.prReceipts)}`,
  ];
  if (nextAction) lines.push('', `Next: ${nextAction}`);
  return lines.join('\n');
}
