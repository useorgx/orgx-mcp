/**
 * Quality-layers widget — the layer verdict anywhere an artifact travels.
 *
 * Given the response of GET /api/artifacts/:id/layer-verdict (the public-safe
 * verdict endpoint), builds the widget payload an MCP client renders inside
 * ChatGPT/Claude/editors: the never-averaged layer table, score-vs-bar tones,
 * the provisional badge for agent-minted types, and reviewer-gated actions
 * (adjust deep-link, re-run layer eval).
 *
 * Same honesty rules as the in-app readout: a layer never judged renders
 * neutral ("not judged"), never a fabricated pass/fail; evidence rides with
 * every verdict because the schema refuses to store one without it.
 *
 * Registration: exported builder is wired from index.ts (one line) — kept out
 * of this module so it can land while index.ts carries in-flight changes.
 */

export interface QualityLayerVerdictPayload {
  artifactId: string;
  artifactType: string | null;
  domain: string;
  stackSource: 'type_override' | 'domain' | 'provisional';
  provisional: boolean;
  gradedLayers: number;
  layers: Array<{
    key: string;
    label: string;
    question: string;
    weight: number;
    verdict: {
      score: number | null;
      comparison: 'above' | 'at' | 'below' | null;
      referenceArtifactId: string | null;
      evidence: string;
      at: string | null;
    } | null;
  }>;
}

export type QualityLayerTone = 'good' | 'warn' | 'muted';

export interface QualityLayersWidgetRow {
  key: string;
  label: string;
  /** "0.91" | "above ref" | "not judged" — pre-formatted for the client. */
  display: string;
  tone: QualityLayerTone;
  score: number | null;
  comparison: 'above' | 'at' | 'below' | null;
  evidence: string | null;
  referenceHref: string | null;
}

export interface QualityLayersWidgetCard {
  state: 'full' | 'empty' | 'error';
  artifactId: string;
  domain: string;
  provisional: boolean;
  headline: string;
  rows: QualityLayersWidgetRow[];
  /** Reviewer-gated; clients hide these for read-only viewers. */
  actions: Array<{
    kind: 'open_artifact' | 'adjust_bar' | 'rerun_layer_eval';
    label: string;
    href?: string;
    tool?: string;
  }>;
}

export const WIDGET_QUALITY_LAYERS_CONTRACT = {
  source: 'orgx-mcp-widget-quality-layers',
  tool_result_mode: 'preserve',
  states: {
    full: 'Show the layer table with tones; evidence expands per row.',
    empty:
      'No layer has been judged yet — say so plainly and offer the re-run action; never fabricate a grade.',
    error:
      'Keep the raw tool result visible with a one-line recovery message.',
  },
} as const;

function toneFor(
  verdict: QualityLayerVerdictPayload['layers'][number]['verdict'],
  threshold: number
): QualityLayerTone {
  if (!verdict) return 'muted';
  if (verdict.comparison === 'below') return 'warn';
  if (typeof verdict.score === 'number') {
    return verdict.score >= threshold ? 'good' : 'warn';
  }
  return verdict.comparison ? 'good' : 'muted';
}

export function buildQualityLayersWidgetCard(input: {
  payload: QualityLayerVerdictPayload | null;
  threshold?: number;
  appBaseUrl: string;
  canReview: boolean;
}): QualityLayersWidgetCard {
  const threshold = input.threshold ?? 0.85;
  const base = input.appBaseUrl.replace(/\/$/, '');

  if (!input.payload) {
    return {
      state: 'error',
      artifactId: '',
      domain: 'general',
      provisional: false,
      headline: 'Could not load the quality verdict for this artifact.',
      rows: [],
      actions: [],
    };
  }

  const p = input.payload;
  const rows: QualityLayersWidgetRow[] = p.layers.map((layer) => {
    const tone = toneFor(layer.verdict, threshold);
    const display = layer.verdict
      ? typeof layer.verdict.score === 'number'
        ? layer.verdict.score.toFixed(2)
        : layer.verdict.comparison
          ? `${layer.verdict.comparison} ref`
          : 'not judged'
      : 'not judged';
    return {
      key: layer.key,
      label: layer.label,
      display,
      tone,
      score: layer.verdict?.score ?? null,
      comparison: layer.verdict?.comparison ?? null,
      evidence: layer.verdict?.evidence ?? null,
      referenceHref: layer.verdict?.referenceArtifactId
        ? `${base}/artifacts/${layer.verdict.referenceArtifactId}`
        : null,
    };
  });

  const actions: QualityLayersWidgetCard['actions'] = [
    {
      kind: 'open_artifact',
      label: 'Open artifact',
      href: `${base}/artifacts/${p.artifactId}`,
    },
  ];
  if (input.canReview) {
    actions.push(
      {
        kind: 'adjust_bar',
        label: 'Adjust bar',
        href: `${base}/settings/quality?type=${encodeURIComponent(
          p.artifactType ?? ''
        )}`,
      },
      {
        kind: 'rerun_layer_eval',
        label: 'Re-run layer eval',
        tool: 'review_artifact',
      }
    );
  }

  return {
    state: p.gradedLayers > 0 ? 'full' : 'empty',
    artifactId: p.artifactId,
    domain: p.domain,
    provisional: p.provisional,
    headline:
      p.gradedLayers > 0
        ? `Judged on ${p.gradedLayers}/${p.layers.length} layers (${p.domain}${p.provisional ? ' · provisional' : ''})`
        : 'Not judged by layer yet — the grade would be fabricated, so none is shown.',
    rows,
    actions,
  };
}
