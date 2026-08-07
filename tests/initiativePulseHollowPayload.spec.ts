// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const widgetHtml = readFileSync(
  join(process.cwd(), 'public', 'widgets', 'initiative-pulse.html'),
  'utf8'
);
const scriptSource =
  Array.from(
    new JSDOM(widgetHtml).window.document.querySelectorAll('script')
  ).find((script) => script.textContent?.includes('var normalizePulse'))
    ?.textContent ?? '';

type PulseModel = {
  normalizePulse: (payload: unknown) => {
    name: string;
    status: string;
    health_score: number | null;
  } | null;
};

function getModel(): PulseModel {
  const dom = new JSDOM(widgetHtml, {
    url: 'https://example.test/widgets/initiative-pulse.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const runtime = {
    detectProtocol: () => 'standalone',
    reportSize: () => undefined,
    callTool: async () => ({}),
    openWidgetLink: () => false,
    initWidget: () => undefined,
  };
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: runtime,
  });
  // The widget calls a bare initWidget() that the runtime script installs as a
  // global; only the widget's own inline script is evaluated here.
  Object.defineProperty(dom.window, 'initWidget', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  dom.window.eval(scriptSource);
  return (dom.window as unknown as { OrgXPulseWidgetModel: PulseModel })
    .OrgXPulseWidgetModel;
}

// Regression: normalizePulse returned null only for a null payload. Any other
// object survived and was filled with defaults — name "Initiative", status
// "active", health_score 100 — so an unrecognized payload rendered a confident
// card reading "Initiative / 100 HEALTH / ACTIVE / $0 cost so far".
//
// For a health widget that is the worst possible failure mode: it asserts that
// everything is fine at the exact moment it knows nothing.
describe('initiative pulse — payloads that carry no real signal', () => {
  const hollowPayloads: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['an id-only envelope', { ok: true, initiative_id: 'INI-402' }],
    ['a tool envelope', { ok: true, _v2_tool: 'get_initiative_pulse' }],
    ['empty collections', { blockers: [], workstreams: [], milestones: [] }],
  ];

  for (const [label, payload] of hollowPayloads) {
    it(`refuses to invent a healthy initiative from ${label}`, () => {
      expect(getModel().normalizePulse(payload)).toBeNull();
    });
  }

  it('never defaults health to 100 when the payload omits it', () => {
    const pulse = getModel().normalizePulse({ name: 'Q4 Product Launch' });

    expect(pulse).not.toBeNull();
    expect(pulse?.health_score).toBeNull();
  });
});

// Hosts do not always deliver the flat pulse record. Before unwrapping, a
// wrapped payload hit the defaults path and inverted its own meaning: a
// blocked initiative at 42 health rendered as "Initiative / 100 / ACTIVE".
describe('initiative pulse — wrapped payloads', () => {
  const wrappers = ['pulse', 'initiative', 'data', 'result'];

  for (const key of wrappers) {
    it(`reads the real record through a "${key}" envelope`, () => {
      const pulse = getModel().normalizePulse({
        [key]: {
          name: 'Q4 Product Launch',
          health_score: 42,
          status: 'blocked',
        },
      });

      expect(pulse?.name).toBe('Q4 Product Launch');
      expect(pulse?.health_score).toBe(42);
      expect(pulse?.status).toBe('blocked');
    });
  }

  it('still reads a flat record unchanged', () => {
    const pulse = getModel().normalizePulse({
      name: 'Q4 Product Launch',
      health_score: 78,
      status: 'active',
    });

    expect(pulse?.name).toBe('Q4 Product Launch');
    expect(pulse?.health_score).toBe(78);
    expect(pulse?.status).toBe('active');
  });
});
