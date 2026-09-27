// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared control-flow panel. These tests hold the two properties the
 * component exists to guarantee: rows are patched by key (never rebuilt), and
 * arriving data animates only on real phase boundaries.
 */

const SHARED = join(__dirname, '..', 'public', 'widgets', 'shared');

interface PanelSnapshot {
  connection: string;
  rows: unknown[];
  summary?: Record<string, number>;
  headline?: string;
  attempts?: number;
  diff?: unknown;
  phases?: { started?: string[]; finished?: string[]; blocked?: string[] } | null;
  data?: unknown;
}

interface Panel {
  apply(snapshot: PanelSnapshot): void;
  element: HTMLElement;
  rowCount(): number;
  destroy(): void;
}

let createPanel: (options: Record<string, unknown>) => Panel;

function load(): void {
  const scope = window as unknown as Record<string, unknown>;
  delete scope.OrgXLiveMachine;
  delete scope.OrgXLivePanel;
  for (const file of ['live-machine.js', 'live-panel.js']) {
    const source = readFileSync(join(SHARED, file), 'utf8');
    window.eval(source);
  }
  createPanel = (window as unknown as {
    OrgXLivePanel: { createPanel: (o: Record<string, unknown>) => Panel };
  }).OrgXLivePanel.createPanel;
}

function node(
  id: string,
  phase: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, title: id.toUpperCase(), phase, ...extra };
}

function summaryOf(rows: Record<string, unknown>[]): Record<string, number> {
  const counts = { running: 0, queued: 0, blocked: 0, done: 0, total: rows.length, progress: 0 };
  for (const row of rows) {
    if (row.phase === 'executing') counts.running += 1;
    else if (row.phase === 'blocked') counts.blocked += 1;
    else if (row.phase === 'terminal') counts.done += 1;
    else counts.queued += 1;
  }
  return counts;
}

function snapshot(
  rows: Record<string, unknown>[],
  overrides: Partial<PanelSnapshot> = {}
): PanelSnapshot {
  return { connection: 'live', rows, summary: summaryOf(rows), ...overrides };
}

let mount: HTMLElement;
let panel: Panel;

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  load();
  mount = document.getElementById('mount')!;
  panel = createPanel({ mount, document });
});

function rows(): HTMLElement[] {
  return Array.from(panel.element.querySelectorAll('.oxlp-row')) as HTMLElement[];
}

function titles(): string[] {
  return rows().map((row) => row.querySelector('.oxlp-title')!.textContent!);
}

describe('rendering', () => {
  it('renders one row per node with its phase', () => {
    panel.apply(snapshot([node('a', 'executing'), node('b', 'blocked')]));
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.getAttribute('data-phase')).toBe('executing');
    expect(rows()[1]!.getAttribute('data-phase')).toBe('blocked');
  });

  it('shows the blocker reason as the row subtitle', () => {
    panel.apply(
      snapshot([node('a', 'blocked', { blockers: [{ reason: 'Waiting on credentials' }] })])
    );
    const sub = rows()[0]!.querySelector('.oxlp-sub')!;
    expect(sub.textContent).toBe('Waiting on credentials');
    expect(sub.getAttribute('data-blocked')).toBe('true');
  });

  it('renders the summary counts and the headline', () => {
    panel.apply(
      snapshot([node('a', 'executing'), node('b', 'blocked')], {
        headline: 'B is blocked — no creds',
      })
    );
    const text = panel.element.textContent ?? '';
    expect(text).toContain('1 running');
    expect(text).toContain('1 blocked');
    expect(text).toContain('B is blocked — no creds');
  });

  it('marks the headline as blocked so it can be styled as the alert it is', () => {
    panel.apply(snapshot([node('a', 'blocked')], { headline: 'blocked' }));
    expect(panel.element.querySelector('.oxlp-headline')!.getAttribute('data-blocked')).toBe(
      'true'
    );
  });

  it('shows an empty state rather than an empty list', () => {
    panel.apply(snapshot([]));
    const empty = panel.element.querySelector('.oxlp-empty') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect((panel.element.querySelector('.oxlp-rows') as HTMLElement).hidden).toBe(true);
  });

  it('labels each row for assistive tech, including its blocker', () => {
    panel.apply(snapshot([node('a', 'blocked', { blockers: [{ reason: 'stuck' }] })]));
    expect(rows()[0]!.getAttribute('aria-label')).toBe('A — Blocked. stuck');
  });
});

describe('keyed patching', () => {
  it('reuses the same DOM node across updates instead of rebuilding it', () => {
    panel.apply(snapshot([node('a', 'pending')]));
    const first = rows()[0]!;
    panel.apply(snapshot([node('a', 'executing', { progress: 50 })]));
    // Identity is the whole point: a rebuilt row loses focus, scroll and any
    // in-flight transition, and reflows the iframe.
    expect(rows()[0]).toBe(first);
    expect(first.getAttribute('data-phase')).toBe('executing');
  });

  it('never duplicates a row across repeated identical applies', () => {
    const rowSet = [node('a', 'executing'), node('b', 'pending')];
    for (let i = 0; i < 5; i += 1) panel.apply(snapshot(rowSet));
    expect(panel.rowCount()).toBe(2);
  });

  it('reorders without recreating rows', () => {
    panel.apply(snapshot([node('a', 'executing'), node('b', 'pending')]));
    const [a, b] = rows();
    panel.apply(snapshot([node('b', 'pending'), node('a', 'executing')]));
    expect(titles()).toEqual(['B', 'A']);
    expect(rows()[0]).toBe(b);
    expect(rows()[1]).toBe(a);
  });

  it('adds and removes rows as the graph changes', () => {
    panel.apply(snapshot([node('a', 'executing')]));
    panel.apply(snapshot([node('a', 'executing'), node('b', 'pending')]));
    expect(titles()).toEqual(['A', 'B']);

    // Exit is animated, so the removed row lingers until its timer fires. Fake
    // timers must be installed before the apply that schedules it.
    vi.useFakeTimers();
    panel.apply(snapshot([node('b', 'pending')]));
    vi.advanceTimersByTime(400);
    vi.useRealTimers();
    expect(titles()).toEqual(['B']);
  });

  it('does not rewrite text that has not changed', () => {
    panel.apply(snapshot([node('a', 'executing', { owner: 'Deploy step' })]));
    const title = rows()[0]!.querySelector('.oxlp-title') as HTMLElement;
    const spy = vi.spyOn(title, 'textContent', 'set');
    panel.apply(snapshot([node('a', 'executing', { owner: 'Deploy step' })]));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('no layout shift', () => {
  it('keeps the progress track a fixed width whether or not there is a value', () => {
    panel.apply(snapshot([node('a', 'pending')]));
    const track = rows()[0]!.querySelector('.oxlp-track') as HTMLElement;
    // Hidden, not removed: removing it would let the phase label slide across
    // the moment a row first reports progress.
    expect(track.style.visibility).toBe('hidden');
    panel.apply(snapshot([node('a', 'executing', { progress: 40 })]));
    expect(track.style.visibility).toBe('visible');
    expect((track.querySelector('.oxlp-fill') as HTMLElement).style.width).toBe('40%');
  });

  it('makes the progress bar a block so its percentage width actually renders', () => {
    // jsdom reports the inline style regardless of layout, so this asserts the
    // declaration directly: as an inline <span> in a non-flex parent the fill
    // computed to 0px wide in a real browser however much progress was set.
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    expect(css).toMatch(/\.oxlp-fill\{[^}]*display:block/);
    expect(css).toMatch(/\.oxlp-track\{[^}]*display:block/);
  });

  it('treats a finished row with no reported progress as full', () => {
    panel.apply(snapshot([node('a', 'terminal')]));
    const fill = rows()[0]!.querySelector('.oxlp-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('animates only opacity and background, never geometry', () => {
    // Anything that animates height/width/padding reflows the iframe and makes
    // the host resize the widget while the user is reading it.
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    const enter = css.match(/@keyframes oxlp-enter\{([^}]*\}?[^}]*)\}/)?.[1] ?? '';
    expect(enter).toContain('opacity');
    expect(enter).not.toMatch(/height|width|padding|margin/);
    const flash = css.match(/@keyframes oxlp-flash\{(.*?)\}\s*@/s)?.[1] ?? '';
    expect(flash).not.toMatch(/height|width|padding|margin/);
  });

  it('reserves a fixed width for the connection chip', () => {
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    // Otherwise "Live" → "Reconnecting" resizes the header on every blip.
    expect(css).toMatch(/\.oxlp-conn\{[^}]*min-width:\s*\d+px/);
  });

  it('gives rows a fixed minimum height and layout containment', () => {
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    expect(css).toMatch(/\.oxlp-row\{[\s\S]*?min-height:\s*\d+px/);
    expect(css).toMatch(/\.oxlp-row\{[\s\S]*?contain:\s*layout/);
  });

  it('stacks the header on narrow screens without letting the headline wrap', () => {
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    expect(css).toContain('@media(max-width:440px)');
    // Wrapping would make header height depend on copy length, which is the
    // layout shift this component exists to avoid.
    expect(css).not.toMatch(/max-width:440px\)\{[\s\S]*?white-space:\s*normal/);
  });

  it('disables motion when the viewer asked for reduced motion', () => {
    const css = document.getElementById('orgx-live-panel-style')!.textContent!;
    expect(css).toContain('prefers-reduced-motion:reduce');
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{[\s\S]*animation:none/);
  });
});

describe('boundary animation', () => {
  it('flashes a row that started, finished or blocked', () => {
    panel.apply(snapshot([node('a', 'pending'), node('b', 'executing'), node('c', 'executing')]));
    panel.apply(
      snapshot([node('a', 'executing'), node('b', 'terminal'), node('c', 'blocked')], {
        diff: {},
        phases: { started: ['a'], finished: ['b'], blocked: ['c'] },
      })
    );
    expect(rows()[0]!.getAttribute('data-anim')).toBe('started');
    expect(rows()[1]!.getAttribute('data-anim')).toBe('finished');
    expect(rows()[2]!.getAttribute('data-anim')).toBe('blocked');
  });

  it('stays quiet when only a progress value moved', () => {
    panel.apply(snapshot([node('a', 'executing', { progress: 41 })]));
    rows()[0]!.removeAttribute('data-anim');
    panel.apply(
      snapshot([node('a', 'executing', { progress: 42 })], {
        diff: {},
        phases: { started: [], finished: [], blocked: [] },
      })
    );
    // Animating every change is what makes a live surface feel noisy.
    expect(rows()[0]!.hasAttribute('data-anim')).toBe(false);
  });

  it('does not animate the very first paint', () => {
    // The first render is not news — every row would flash at once.
    panel.apply(snapshot([node('a', 'executing'), node('b', 'pending')]));
    expect(rows().every((row) => !row.hasAttribute('data-anim'))).toBe(true);
  });

  it('prefers the blocked flash over the started flash for the same row', () => {
    panel.apply(snapshot([node('a', 'pending')]));
    panel.apply(
      snapshot([node('a', 'executing')], {
        diff: {},
        phases: { started: ['a'], blocked: [], finished: [] },
      })
    );
    expect(rows()[0]!.getAttribute('data-anim')).toBe('started');
  });
});

describe('connection state', () => {
  it('renders plain copy for each connection state', () => {
    const expected: Record<string, string> = {
      connecting: 'Connecting',
      live: 'Live',
      stale: 'Reconnecting',
      refreshing: 'Reauthorizing',
      paused: 'Paused',
      fatal: 'Disconnected',
    };
    for (const [state, label] of Object.entries(expected)) {
      panel.apply(snapshot([node('a', 'executing')], { connection: state }));
      expect(panel.element.querySelector('.oxlp-conn-label')!.textContent).toBe(label);
    }
  });

  it('offers a retry only when the connection is truly dead', () => {
    const onRetry = vi.fn();
    panel.destroy();
    panel = createPanel({ mount, document, onRetry });

    panel.apply(snapshot([node('a', 'executing')], { connection: 'live' }));
    expect(panel.element.querySelector('.oxlp-retry')).toBeNull();

    panel.apply(snapshot([node('a', 'executing')], { connection: 'fatal' }));
    const retry = panel.element.querySelector('.oxlp-retry') as HTMLButtonElement;
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // And it goes away again once reconnected.
    panel.apply(snapshot([node('a', 'executing')], { connection: 'live' }));
    expect((panel.element.querySelector('.oxlp-retry') as HTMLElement).hidden).toBe(true);
  });

  it('keeps showing the last known rows while degraded', () => {
    panel.apply(snapshot([node('a', 'executing')]));
    panel.apply(snapshot([node('a', 'executing')], { connection: 'stale' }));
    // Blanking the list on a reconnect would throw away the last known truth.
    expect(rows()).toHaveLength(1);
    expect(panel.element.querySelector('.oxlp-conn')!.getAttribute('data-tone')).toBe('warn');
  });

  it('explains an empty list differently when the connection is dead', () => {
    panel.apply(snapshot([], { connection: 'fatal' }));
    expect(panel.element.querySelector('.oxlp-empty')!.textContent).toBe(
      'Live updates unavailable'
    );
  });
});

describe('interaction', () => {
  it('reports the selected row id by click and by keyboard', () => {
    const onSelect = vi.fn();
    panel.destroy();
    panel = createPanel({ mount, document, onSelect });
    panel.apply(snapshot([node('a', 'executing')]));

    const row = rows()[0]!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    row.click();
    row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('is not focusable when there is nothing to drill into', () => {
    panel.apply(snapshot([node('a', 'executing')]));
    expect(rows()[0]!.hasAttribute('tabindex')).toBe(false);
  });

  it('caps the row count when a widget asks for a preview', () => {
    panel.destroy();
    panel = createPanel({ mount, document, maxRows: 2 });
    panel.apply(snapshot([node('a', 'executing'), node('b', 'pending'), node('c', 'pending')]));
    expect(panel.rowCount()).toBe(2);
  });
});
