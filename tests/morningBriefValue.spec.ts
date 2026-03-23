import { describe, expect, it } from 'vitest';

import {
  buildMorningBriefValueDashboard,
  formatMorningBriefSummary,
} from '../src/morningBriefValue';

describe('morningBriefValue', () => {
  it('builds a compound value dashboard from brief, attribution, and pulse data', () => {
    const dashboard = buildMorningBriefValueDashboard({
      brief: {
        session_summary: {
          total_cost: 4,
          total_value: 30,
        },
        intelligence: {
          learnings_applied: 3,
          trust_promotions: 1,
          decisions_resolved_30d: 5,
          initiatives_completed_30d: 2,
        },
      },
      outcomeAttribution: {
        summary: {
          total_cost: 6,
          total_value: 48,
          roi: 7,
          roi_display: '700%',
          learnings_applied: 4,
        },
      },
      workspacePulse: {
        stats: {
          completedThisWeek: 1,
        },
      },
    });

    expect(dashboard).toEqual({
      period: '30d',
      value_delivered_usd: 48,
      cost_usd: 6,
      roi: 7,
      roi_display: '700%',
      estimated_time_saved_hours: 0.4,
      context_preserved_events: 4,
      decisions_resolved: 5,
      initiatives_completed: 2,
      completed_this_week: 1,
      trust_promotions: 1,
      learnings_applied: 4,
    });
  });

  it('formats a concise morning brief summary with the value dashboard', () => {
    const summary = formatMorningBriefSummary({
      session_summary: {
        session_type: 'overnight',
        receipts_produced: 3,
        completed: 2,
        failed: 1,
      },
      top_receipts: [
        {
          intent: 'Ship onboarding telemetry',
          attributed_value_usd: 18,
        },
      ],
      exceptions: [{ exception_type: 'budget_guardrail' }],
      brief_markdown: '# Morning Brief',
      value_dashboard: buildMorningBriefValueDashboard({
        brief: {
          intelligence: {
            learnings_applied: 2,
            decisions_resolved_30d: 1,
            initiatives_completed_30d: 1,
          },
        },
        outcomeAttribution: {
          summary: {
            total_cost: 4,
            total_value: 24,
            roi: 5,
            roi_display: '500%',
            learnings_applied: 2,
          },
        },
      }),
    });

    expect(summary).toContain('Morning brief: overnight session produced 3 receipts');
    expect(summary).toContain('Value dashboard (30d):');
    expect(summary).toContain('Decisions resolved: 1');
    expect(summary).toContain('Narrative brief available.');
  });
});
