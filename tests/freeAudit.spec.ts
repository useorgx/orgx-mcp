import { describe, expect, it } from 'vitest';

import {
  buildOrgxFreeAudit,
  formatOrgxFreeAuditSummary,
} from '../src/freeAudit';

describe('OrgX free audit scoring', () => {
  it('builds a shareable autonomy benchmark from trust, pulse, and ROI signals', () => {
    const audit = buildOrgxFreeAudit({
      workspaceId: 'workspace-123',
      agentType: 'orchestrator',
      period: '30d',
      generatedAt: '2026-04-12T12:00:00.000Z',
      trustContext: {
        total_capabilities: 2,
        autonomous_count: 2,
        capabilities: [
          {
            capability_key: 'plan',
            trust_level: 'autonomous',
            trust_score: 92,
            total_receipts: 5,
            receipts_needed_for_promotion: 0,
            avg_quality_score: 4.8,
          },
          {
            capability_key: 'execute',
            trust_level: 'autonomous',
            trust_score: 0.8,
            receipt_count: 3,
            receipts_needed: 1,
            quality_score: 4,
          },
        ],
      },
      outcomeAttribution: {
        summary: {
          entries_count: 4,
          total_value_usd: 12000,
          total_cost_usd: 83.5,
          roi: 143.7,
        },
        by_agent: [{ agent_type: 'orchestrator', value_usd: 12000 }],
        top_receipts: [{ id: 'receipt-1' }],
      },
      workspacePulse: {
        stats: {
          totalWorkstreams: 10,
          blockedWorkstreams: 1,
          activeWorkstreams: 5,
          completedThisWeek: 3,
        },
      },
    });

    expect(audit.tool).toBe('orgx_free_audit');
    expect(audit.workspace_id).toBe('workspace-123');
    expect(audit.overall_band).toBe('excellent');
    expect(audit.overall_score).toBeGreaterThanOrEqual(85);
    expect(audit.scores.proof_score.band).toBe('excellent');
    expect(audit.scores.context_debt_score.score).toBeGreaterThanOrEqual(80);
    expect(audit.scores.autonomy_maturity_score.score).toBeGreaterThanOrEqual(90);
    expect(audit.scores.roi_visibility_score.score).toBe(100);
    expect(audit.signal_status.trust_context.capability_count).toBe(2);
    expect(audit.signal_status.workspace_pulse.blocked_count).toBe(1);
    expect(audit.signal_status.outcome_attribution.total_value).toBe(12000);
    expect(audit.raw_signals).toBeUndefined();
    expect(audit.share_summary).toContain('OrgX Free Audit:');

    const summary = formatOrgxFreeAuditSummary(audit);
    expect(summary).toContain('Overall:');
    expect(summary).toContain('Context Debt Score');
    expect(summary).toContain('Recommendations:');
  });

  it('reports weak confidence and raw diagnostics when upstream signals are absent', () => {
    const audit = buildOrgxFreeAudit({
      workspaceId: 'workspace-123',
      agentType: 'marketing',
      period: '7d',
      generatedAt: '2026-04-12T12:00:00.000Z',
      includeRawSignals: true,
    });

    expect(audit.overall_band).toBe('weak');
    expect(audit.overall_score).toBeLessThan(45);
    expect(audit.signal_status.trust_context.available).toBe(false);
    expect(audit.signal_status.outcome_attribution.entries_count).toBeNull();
    expect(audit.signal_status.workspace_pulse.total_workstreams).toBeNull();
    expect(audit.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Attach receipt evidence'),
        expect.stringContaining('Reduce context debt'),
        expect.stringContaining('Record outcomes'),
      ])
    );
    expect(audit.raw_signals).toEqual({
      trust_context: null,
      outcome_attribution: null,
      workspace_pulse: null,
    });
  });
});
