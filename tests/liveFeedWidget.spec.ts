// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { buildLiveFeedWidget } from '../src/liveFeedWidget';
import { PROOF_SURFACE_QUIET_CTA } from '../src/widgetArtifactProof';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {}
}

function buildWidget(feedType: 'agent-status' | 'initiative-pulse'): string {
  return buildLiveFeedWidget({
    feedType,
    feedId: 'init-12345678',
    streamBaseUrl: 'https://mcp.useorgx.com',
    streamToken: 'token-123',
    liveUrl: 'https://useorgx.com/live/init-12345678',
    title: 'Operation Prism',
  });
}

function mountWidget(html: string): FakeEventSource {
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, '');
  (window as unknown as { EventSource: unknown }).EventSource =
    FakeEventSource;
  window.eval(script);
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error('widget did not open an EventSource');
  return source;
}

function emit(source: FakeEventSource, event: Record<string, unknown>): void {
  source.onmessage?.({ data: JSON.stringify(event) });
}

function quietCtaEl(): HTMLElement {
  const el = document.getElementById('quietCta');
  if (!el) throw new Error('quiet CTA element missing');
  return el;
}

function ctaOccurrences(): number {
  return document.body.innerHTML.split(PROOF_SURFACE_QUIET_CTA).length - 1;
}

describe('buildLiveFeedWidget quiet CTA footer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    FakeEventSource.instances = [];
  });

  it('ships exactly one quiet CTA slot and never hardcodes the CTA copy', () => {
    for (const feedType of ['agent-status', 'initiative-pulse'] as const) {
      const html = buildWidget(feedType);
      expect(html.split('id="quietCta"').length - 1).toBe(1);
      expect(html).not.toContain(PROOF_SURFACE_QUIET_CTA);
    }
  });

  it('ships the self-contained host theme contract and touch-safe footer action', () => {
    const html = buildWidget('agent-status');
    expect(html).toContain('data-accent="teal"');
    expect(html).toContain('openai:set_globals');
    expect(html).toContain('data-theme-source');
    expect(html).toContain('min-height:44px');
  });

  it('renders proof_handoff.quiet_cta exactly once on the initiative pulse card', () => {
    const source = mountWidget(buildWidget('initiative-pulse'));

    emit(source, {
      type: 'snapshot',
      ts: Date.now(),
      data: {
        initiatives: [
          { title: 'Operation Prism', progress: 62, status: 'active' },
        ],
        proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
      },
    });

    expect(quietCtaEl().hidden).toBe(false);
    expect(quietCtaEl().textContent).toBe(PROOF_SURFACE_QUIET_CTA);
    expect(ctaOccurrences()).toBe(1);

    // A later delta with the same handoff must not duplicate the line.
    emit(source, {
      type: 'delta',
      ts: Date.now() + 1,
      data: {
        initiatives: [
          { title: 'Operation Prism', progress: 70, status: 'active' },
        ],
        proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
      },
    });

    expect(ctaOccurrences()).toBe(1);
  });

  it('keeps the quiet CTA absent when the handoff field is missing', () => {
    const source = mountWidget(buildWidget('initiative-pulse'));

    emit(source, {
      type: 'snapshot',
      ts: Date.now(),
      data: {
        initiatives: [
          { title: 'Operation Prism', progress: 62, status: 'active' },
        ],
      },
    });

    expect(quietCtaEl().hidden).toBe(true);
    expect(quietCtaEl().textContent).toBe('');
    expect(ctaOccurrences()).toBe(0);
  });

  it('hides the quiet CTA again when a later update drops the handoff', () => {
    const source = mountWidget(buildWidget('initiative-pulse'));

    emit(source, {
      type: 'snapshot',
      ts: Date.now(),
      data: {
        initiative: { title: 'Operation Prism', progress: 62 },
        proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
      },
    });
    expect(quietCtaEl().hidden).toBe(false);

    emit(source, {
      type: 'delta',
      ts: Date.now() + 1,
      data: { initiative: { title: 'Operation Prism', progress: 63 } },
    });

    expect(quietCtaEl().hidden).toBe(true);
    expect(ctaOccurrences()).toBe(0);
  });

  it('ignores replayed SSE snapshots that are older than the visible state', () => {
    const source = mountWidget(buildWidget('initiative-pulse'));
    emit(source, {
      type: 'snapshot',
      ts: 200,
      data: { initiative: { title: 'Fresh state', progress: 80 } },
    });
    emit(source, {
      type: 'delta',
      ts: 100,
      data: { initiative: { title: 'Replayed old state', progress: 10 } },
    });

    expect(document.body.textContent).toContain('Fresh state');
    expect(document.body.textContent).not.toContain('Replayed old state');
  });

  it('renders the agent-status card CTA once even when several agents carry handoffs', () => {
    const source = mountWidget(buildWidget('agent-status'));

    emit(source, {
      type: 'snapshot',
      ts: Date.now(),
      data: {
        summary: { running: 2 },
        agents: [
          {
            id: 'eng-1',
            name: 'Engineering Autopilot',
            domain: 'engineering',
            status: 'running',
            proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
          },
          {
            id: 'des-1',
            name: 'Design Codex',
            domain: 'design',
            status: 'running',
            proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
          },
        ],
      },
    });

    expect(quietCtaEl().hidden).toBe(false);
    expect(quietCtaEl().textContent).toBe(PROOF_SURFACE_QUIET_CTA);
    expect(ctaOccurrences()).toBe(1);
  });
});
