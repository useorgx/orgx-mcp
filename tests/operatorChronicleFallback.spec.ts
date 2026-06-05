import { describe, expect, it } from 'vitest';

import {
  buildOperatorChroniclePath,
  formatOperatorChronicleBrief,
  normalizeOperatorChroniclePeriod,
} from '../src/operatorChronicleFallback';

describe('operator chronicle fallback', () => {
  it('defaults stale morning brief calls to the 30-day operator chronicle', () => {
    expect(normalizeOperatorChroniclePeriod(undefined)).toBe('30d');
    expect(buildOperatorChroniclePath({}, null)).toBe(
      '/api/operator/chronicle?period=30d'
    );
  });

  it('carries explicit period and session workspace when present', () => {
    expect(
      buildOperatorChroniclePath({ period: 'week' }, 'workspace-1')
    ).toBe('/api/operator/chronicle?period=week&workspace_id=workspace-1');
  });

  it('prefers explicit workspace over session workspace', () => {
    expect(
      buildOperatorChroniclePath(
        { workspace_id: 'workspace-explicit', period: 'day' },
        'workspace-session'
      )
    ).toBe('/api/operator/chronicle?period=day&workspace_id=workspace-explicit');
  });

  it('uses reportingNarrative.briefMarkdown as the LLM-facing summary', () => {
    expect(
      formatOperatorChronicleBrief({
        data: {
          chronicle: {
            reportingNarrative: {
              briefMarkdown: '# Chronicle\n\n- Decision chronology is ready.',
            },
          },
        },
      })
    ).toBe('# Chronicle\n\n- Decision chronology is ready.');
  });

  it('falls back to metrics when narrative markdown is missing', () => {
    expect(
      formatOperatorChronicleBrief({
        chronicle: {
          headline: 'Operator chronicle ready',
          metrics: {
            pendingDecisions: 2,
            blockedWork: 1,
            artifactsProduced: 3,
            prReceipts: 4,
          },
          reportingNarrative: {
            nextAction: 'Review the top priority.',
          },
        },
      })
    ).toContain('PR receipts: 4');
  });
});
