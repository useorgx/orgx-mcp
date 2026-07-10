// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { buildScaffoldWidget } from '../src/scaffoldWidget';
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

function buildWidget(): string {
  return buildScaffoldWidget({
    sessionId: 'session-123',
    streamBaseUrl: 'https://mcp.useorgx.com',
    initiativeTitle: 'Operation Prism',
    liveUrl: 'https://useorgx.com/live/init-12345678',
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

describe('buildScaffoldWidget quiet CTA footer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    FakeEventSource.instances = [];
  });

  it('ships exactly one quiet CTA slot and never hardcodes the CTA copy', () => {
    const html = buildWidget();
    expect(html.split('id="quietCta"').length - 1).toBe(1);
    expect(html).not.toContain(PROOF_SURFACE_QUIET_CTA);
  });

  it('renders proof_handoff.quiet_cta exactly once on scaffold completion', () => {
    const source = mountWidget(buildWidget());

    emit(source, { type: 'session.start', title: 'Operation Prism' });
    expect(quietCtaEl().hidden).toBe(true);

    emit(source, {
      type: 'scaffold.complete',
      totalEntities: 18,
      liveUrl: 'https://useorgx.com/live/init-12345678',
      proof_handoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
    });

    expect(quietCtaEl().hidden).toBe(false);
    expect(quietCtaEl().textContent).toBe(PROOF_SURFACE_QUIET_CTA);
    expect(ctaOccurrences()).toBe(1);
  });

  it('keeps the quiet CTA absent when scaffold.complete has no handoff', () => {
    const source = mountWidget(buildWidget());

    emit(source, { type: 'session.start', title: 'Operation Prism' });
    emit(source, {
      type: 'scaffold.complete',
      totalEntities: 18,
      liveUrl: 'https://useorgx.com/live/init-12345678',
    });

    expect(quietCtaEl().hidden).toBe(true);
    expect(quietCtaEl().textContent).toBe('');
    expect(ctaOccurrences()).toBe(0);
  });
});
