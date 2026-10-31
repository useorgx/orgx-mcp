// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Empty views carry one calm line, at most one sentence and at most one action,
// with no section shells, links or launch buttons stacked under nothing.
const DIR = resolve(__dirname, '../public/widgets/shared/panel');
function load() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  for (const f of ['panel-icons.js', 'panel-views.js', 'panel-outputs.js', 'panel-goals.js']) dom.window.eval(readFileSync(resolve(DIR, f), 'utf8'));
  const w = dom.window as unknown as Record<string, any>;
  const frag = (html: string) => { const d = dom.window.document.createElement('div'); d.innerHTML = html; return d; };
  return { Views: w.OrgXPanelViews, Outputs: w.OrgXPanelOutputs, Goals: w.OrgXPanelGoals, frag };
}
const actions = (el: Element) => el.querySelectorAll('button, a[href]').length;

describe('panel empty states', () => {
  const { Views, Outputs, Goals, frag } = load();

  it('In progress with nothing running: one line, one sentence, the launch, no runs link', () => {
    const el = frag(Views.workHtml({ status: 'ok', items: [], total: 0 }, 'ready', '<div class="st-link"><button type="button">Start work</button></div>', {}));
    expect(el.querySelector('.pn-empty-h')!.textContent).toBe('Nothing is running right now.');
    expect(el.querySelectorAll('.pn-empty-p')).toHaveLength(1);
    expect(actions(el)).toBe(1);
    expect(el.textContent).not.toContain('All runs in OrgX');
  });

  it('Outputs with none: no art, no action', () => {
    const el = frag(Outputs.html({ status: 'ok', items: [], total: 0 }, 'ready', {}));
    expect(el.querySelector('.pn-empty-h')!.textContent).toBe('No outputs yet.');
    expect(el.querySelector('.pn-empty-art')).toBeNull();
    expect(actions(el)).toBe(0);
  });

  it('Outputs filtered to nothing: the filters, one line and Clear filters, without a zero count line', () => {
    const items = [{ id: 'o1', title: 'Post', type: 'blog', family: 'writing', status: 'draft', made_at: '2020-01-01T00:00:00.000Z', made_by: 'Mark', accepted: { state: 'accepted' }, checks: [] }];
    const el = frag(Outputs.html({ status: 'ok', items, total: 1 }, 'ready', { range: 'today' }));
    expect(el.querySelector('.pn-empty-h')!.textContent).toBe('No outputs match these filters.');
    expect(el.querySelector('.pn-done-sum')).toBeNull();
    expect(el.querySelector('.pn-empty [data-action="out-clear"]')!.textContent).toBe('Clear filters');
  });

  it('Goals with none: the form alone, no quality-bar section', () => {
    const el = frag(Goals.html({ status: 'ok', items: [], total: 0, unlinked: [], unlinked_total: 0, quality_bars: [] }, 'ready', { qualityUrl: 'https://useorgx.com' }));
    expect(el.querySelector('.pn-empty-h')!.textContent).toBe('No goals yet.');
    expect(el.querySelector('.gl-judge')).toBeNull();
    expect(el.textContent).not.toContain('Review in OrgX');
    expect(el.querySelectorAll('button')).toHaveLength(1);
  });

  it('Done with nothing settled this session: no acceptance card, links or launch', () => {
    const el = frag(Views.doneHtml({ lens: 'decisions', session: [], range: 'session', overviewHtml: '<div class="proof">x</div>', launch: '<div class="st-link"><button>Start</button></div>' }));
    expect(el.querySelector('.pn-empty-h')!.textContent).toBe('Nothing decided here yet.');
    expect(el.querySelector('.md-overview')).toBeNull();
    expect(el.querySelector('.st-link')).toBeNull();
    expect(el.textContent).not.toContain('Work ledger');
  });
});
