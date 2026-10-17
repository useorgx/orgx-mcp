// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot } from './fixtures/panel';

type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

async function open() {
  const m = await mountPanel({}, {});
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: snapshot() });
  await m.flush();
  return m;
}

describe('observed ChatGPT panel journey regressions', () => {
  it('shows Start prompts when the tour introduces starting work, without sending anything', async () => {
    const m = await open();
    const doc = m.dom.window.document;
    (doc.querySelector('[data-action="tour"]') as HTMLElement).click();
    await new Promise((resolve) => m.dom.window.setTimeout(resolve, 60));
    for (let step = 0; step < 6; step += 1) {
      (doc.querySelector('[data-tour="next"]') as HTMLElement).click();
      await new Promise((resolve) => m.dom.window.setTimeout(resolve, 60));
    }
    expect(doc.querySelector('.pn-coach-t')?.textContent).toBe('Start new work with a sentence');
    expect(doc.querySelector('.pn-tab[aria-selected="true"]')?.getAttribute('data-tab')).toBe('start');
    expect(doc.querySelector('.pn-start')).not.toBeNull();
    expect(m.calls.sendMessage).not.toHaveBeenCalled();
    expect(m.calls.callServerTool.mock.calls.filter(([call]) => /decide|launch|spawn/.test(call.name))).toHaveLength(0);
  });

  it.each(['Oct 9', '3d ago', 'just now', ''])('labels a stale task honestly when the clock returns %j', async (relative) => {
    const m = await open();
    const win = m.dom.window as unknown as {
      OrgXTime: { relative: () => string };
      OrgXPanelViews: { workHtml: (work: Record<string, unknown>, phase: string, launch: string, opts: Record<string, unknown>) => string };
    };
    win.OrgXTime.relative = () => relative;
    const item = { id: 'task', agent: 'Eli', title: 'Review fixture', state: 'running', stale: true, updated_at: '2026-10-09T00:00:00Z', url: 'https://useorgx.test/tasks/task' };
    const holder = m.dom.window.document.createElement('div');
    holder.innerHTML = win.OrgXPanelViews.workHtml({ status: 'ok', total: 1, items: [item] }, 'ready', '', { sel: 'task' });
    const labels = Array.from(holder.querySelectorAll('ox-state-chip[state="stale"]')).map((chip) => chip.getAttribute('label'));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label === (relative ? `Last update ${relative}` : 'No recent update'))).toBe(true);
    expect(holder.textContent).not.toContain('reported for Oct 9');
  });
});
