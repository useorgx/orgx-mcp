const DEFAULT_HOURLY_VALUE_USD = 120;

type JsonRecord = Record<string, unknown>;

export type MorningBriefValueDashboard = {
  period: '30d';
  value_delivered_usd: number;
  cost_usd: number;
  roi: number | null;
  roi_display: string;
  estimated_time_saved_hours: number | null;
  context_preserved_events: number;
  decisions_resolved: number;
  initiatives_completed: number;
  completed_this_week: number;
  trust_promotions: number;
  learnings_applied: number;
};

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

export function buildMorningBriefValueDashboard(params: {
  brief: JsonRecord;
  outcomeAttribution?: JsonRecord | null;
  workspacePulse?: JsonRecord | null;
  hourlyValueUsd?: number;
}): MorningBriefValueDashboard {
  const hourlyValueUsd = params.hourlyValueUsd ?? DEFAULT_HOURLY_VALUE_USD;
  const brief = asRecord(params.brief);
  const intelligence = asRecord(brief.intelligence);
  const sessionSummary = asRecord(brief.session_summary);
  const attribution = asRecord(params.outcomeAttribution);
  const attributionSummary = asRecord(attribution.summary);
  const pulseStats = asRecord(asRecord(params.workspacePulse).stats);

  const valueDeliveredUsd =
    readNumber(attributionSummary.total_value) ??
    readNumber(intelligence.attributed_value) ??
    readNumber(sessionSummary.total_value) ??
    0;
  const costUsd =
    readNumber(attributionSummary.total_cost) ??
    readNumber(sessionSummary.total_cost) ??
    0;
  const roi =
    readNumber(attributionSummary.roi) ??
    (costUsd > 0 ? (valueDeliveredUsd - costUsd) / costUsd : null);
  const learningsApplied =
    readNumber(attributionSummary.learnings_applied) ??
    readNumber(intelligence.learnings_applied) ??
    0;
  const estimatedTimeSavedHours =
    valueDeliveredUsd > 0 && hourlyValueUsd > 0
      ? Number((valueDeliveredUsd / hourlyValueUsd).toFixed(1))
      : null;

  return {
    period: '30d',
    value_delivered_usd: valueDeliveredUsd,
    cost_usd: costUsd,
    roi,
    roi_display:
      typeof attributionSummary.roi_display === 'string'
        ? attributionSummary.roi_display
        : roi !== null
        ? `${(roi * 100).toFixed(0)}%`
        : 'N/A',
    estimated_time_saved_hours: estimatedTimeSavedHours,
    context_preserved_events: learningsApplied,
    decisions_resolved:
      readNumber(intelligence.decisions_resolved_30d) ?? 0,
    initiatives_completed:
      readNumber(intelligence.initiatives_completed_30d) ?? 0,
    completed_this_week:
      readNumber(pulseStats.completedThisWeek) ?? 0,
    trust_promotions: readNumber(intelligence.trust_promotions) ?? 0,
    learnings_applied: learningsApplied,
  };
}

export function formatMorningBriefValueDashboard(
  dashboard: MorningBriefValueDashboard
): string {
  const lines = [
    'Value dashboard (30d):',
    `- Value delivered: ${formatUsd(dashboard.value_delivered_usd)}`,
    `- ROI: ${dashboard.roi_display}`,
    dashboard.estimated_time_saved_hours !== null
      ? `- Estimated time saved: ${dashboard.estimated_time_saved_hours}h (using $${DEFAULT_HOURLY_VALUE_USD}/hr value model)`
      : '- Estimated time saved: N/A',
    `- Context preserved: ${dashboard.context_preserved_events} reuse event${
      dashboard.context_preserved_events === 1 ? '' : 's'
    }`,
    `- Decisions resolved: ${dashboard.decisions_resolved}`,
    `- Initiatives completed: ${dashboard.initiatives_completed}`,
  ];

  if (dashboard.completed_this_week > 0) {
    lines.push(
      `- Completed this week: ${dashboard.completed_this_week}`
    );
  }
  if (dashboard.trust_promotions > 0) {
    lines.push(`- Trust promotions: ${dashboard.trust_promotions}`);
  }

  return lines.join('\n');
}

export function formatMorningBriefSummary(
  payload: JsonRecord & { value_dashboard?: MorningBriefValueDashboard }
): string {
  const sessionSummary = asRecord(payload.session_summary);
  const exceptions = Array.isArray(payload.exceptions) ? payload.exceptions : [];
  const topReceipts = Array.isArray(payload.top_receipts) ? payload.top_receipts : [];

  const lines: string[] = [];
  const sessionType =
    typeof sessionSummary.session_type === 'string'
      ? sessionSummary.session_type
      : 'recent';
  const receiptsProduced = readNumber(sessionSummary.receipts_produced) ?? 0;
  const completedCount = readNumber(sessionSummary.completed) ?? 0;
  const failedCount = readNumber(sessionSummary.failed) ?? 0;

  lines.push(
    `Morning brief: ${sessionType} session produced ${receiptsProduced} receipt${
      receiptsProduced === 1 ? '' : 's'
    } (${completedCount} completed, ${failedCount} failed).`
  );

  if (payload.value_dashboard) {
    lines.push('', formatMorningBriefValueDashboard(payload.value_dashboard));
  }

  if (topReceipts.length > 0) {
    lines.push('', 'Top receipts:');
    for (const receipt of topReceipts.slice(0, 3)) {
      const row = asRecord(receipt);
      lines.push(
        `- ${typeof row.intent === 'string' ? row.intent : 'Execution receipt'}${
          readNumber(row.attributed_value_usd) !== null
            ? ` (${formatUsd(readNumber(row.attributed_value_usd) ?? 0)})`
            : ''
        }`
      );
    }
  }

  if (exceptions.length > 0) {
    lines.push(
      '',
      `Exceptions needing review: ${exceptions.length}`
    );
  }

  if (typeof payload.brief_markdown === 'string' && payload.brief_markdown.trim()) {
    lines.push('', 'Narrative brief available.');
  }

  return lines.join('\n');
}
