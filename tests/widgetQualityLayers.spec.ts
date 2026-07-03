// Ported from the orgx monorepo (tests/quality.widgetAndJudge.spec.ts): the
// widget-card builder is worker code, so its tests live here. The module was
// originally committed to the monorepo's vendored worker copy by mistake —
// this repo is the live worker.
import { describe, expect, it } from 'vitest';

import { buildQualityLayersWidgetCard } from '../src/widgetQualityLayers';

const PAYLOAD = {
  artifactId: 'a-1',
  artifactType: 'sales.outreach_sequence',
  domain: 'sales',
  stackSource: 'domain' as const,
  provisional: false,
  gradedLayers: 2,
  layers: [
    {
      key: 'claim_sharpness',
      label: 'Claim sharpness',
      question: 'q',
      weight: 0.25,
      verdict: {
        score: 0.91,
        comparison: 'above' as const,
        referenceArtifactId: 'ref-1',
        evidence: 'one promise, laddered',
        at: null,
      },
    },
    {
      key: 'evidence_density',
      label: 'Evidence density',
      question: 'q',
      weight: 0.25,
      verdict: {
        score: 0.62,
        comparison: 'below' as const,
        referenceArtifactId: 'ref-1',
        evidence: 'unsourced stat present',
        at: null,
      },
    },
    {
      key: 'voice',
      label: 'Voice',
      question: 'q',
      weight: 0.15,
      verdict: null,
    },
  ],
};

describe('quality layers widget card', () => {
  it('builds tones honestly: cleared/below/never-judged', () => {
    const card = buildQualityLayersWidgetCard({
      payload: PAYLOAD,
      appBaseUrl: 'https://useorgx.com/',
      canReview: true,
    });
    expect(card.state).toBe('full');
    expect(card.rows[0]!.tone).toBe('good');
    expect(card.rows[1]!.tone).toBe('warn');
    expect(card.rows[2]!.tone).toBe('muted');
    expect(card.rows[2]!.display).toBe('not judged');
    expect(card.rows[0]!.referenceHref).toBe(
      'https://useorgx.com/artifacts/ref-1'
    );
  });

  it('never fabricates a grade when nothing was judged', () => {
    const card = buildQualityLayersWidgetCard({
      payload: { ...PAYLOAD, gradedLayers: 0 },
      appBaseUrl: 'https://useorgx.com',
      canReview: false,
    });
    expect(card.state).toBe('empty');
    expect(card.headline.toLowerCase()).toContain('fabricated');
    // Read-only viewers get no review actions.
    expect(card.actions.map((a) => a.kind)).toEqual(['open_artifact']);
  });
});
