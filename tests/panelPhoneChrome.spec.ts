import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { snapshot, D1 } from './fixtures/panel';

/**
 * ChatGPT's phone app, as the panel meets it: a full-screen view with the
 * host's title bar (back, title, menu) above and its composer drawn over the
 * bottom. Real captures showed the content start below the bar at scroll
 * top, then scroll under it (the mark and the tabs gone), and the queue and
 * the tour's buttons under the composer.
 *
 * These tests draw that chrome as pointer-blocking overlays, then tap the
 * real controls at their on-screen coordinates. A tap that lands on the
 * chrome instead of the control fails the test, so this holds only when the
 * panel actually keeps its controls in the open area. Two cases: the host
 * reports its insets (the bar drawn over the view, as a host that reports
 * a top inset would), and it reports none (the host starts the content
 * below its bar itself; only the composer is over the view, and the floor
 * keeps the bottom clear).
 */
const PHONE = { width: 390, height: 844 };
const BAR = 108;
const COMPOSER = 90;
const HOST_BAR = `<div id="host-bar" style="position:fixed;left:0;right:0;top:0;height:${BAR}px;z-index:2147483647;background:rgba(10,12,16,.8);pointer-events:auto"></div>`;
const HOST_COMPOSER = `<div id="host-composer" style="position:fixed;left:0;right:0;bottom:0;height:${COMPOSER}px;z-index:2147483647;background:rgba(10,12,16,.8);pointer-events:auto"></div>`;
const CHROME = HOST_BAR + HOST_COMPOSER;

const panelUrl = pathToFileURL(resolve('public/widgets/orgx-panel.html')).href;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); });
afterAll(async () => { await browser?.close(); });

type Host = { insets?: { top: number; right: number; bottom: number; left: number }; barOverView?: boolean; auth?: boolean; tour?: boolean };

async function open(host: Host) {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:/, (route) => route.abort());
  // A queue long enough that the view scrolls, as a real one does.
  const base = snapshot();
  const data = snapshot({
    attention: { ...base.attention, pending: 8 },
    queue: Array.from({ length: 8 }, (_, i) => ({ ...base.queue[i % 2]!, id: `${i}${base.queue[i % 2]!.id.slice(1)}`, title: `Decision ${i + 1}: ${base.queue[i % 2]!.title}` })),
  });
  await page.addInitScript(({ data, host, D1 }) => {
    const w = window as unknown as Record<string, unknown> & { __calls: { name: string; args: unknown }[] };
    w.__calls = [];
    // The first-use tour starts by itself; only the tour case wants it.
    try { if (host.tour) localStorage.removeItem('orgx.panel.tour.v1'); else localStorage.setItem('orgx.panel.tour.v1', 'done'); } catch (_) { /* fine */ }
    w.openai = {
      theme: 'dark',
      displayMode: 'fullscreen',
      userAgent: { device: { type: 'mobile' }, capabilities: { hover: false, touch: true } },
      ...(host.insets ? { safeArea: { insets: host.insets } } : {}),
      toolOutput: host.auth ? { ok: false, error: { code: 'authentication_required', message: 'Sign in' } } : data,
      toolResponseMetadata: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'synthetic-token' } } },
      setWidgetHeight() {},
      async callTool(name: string, args: unknown) {
        w.__calls.push({ name, args });
        return { structuredContent: { ...data, generated_at: '2026-10-02T12:09:00.000Z', work: { status: 'ok', total: 0, items: [] } } };
      },
    };
  }, { data, host, D1 });
  await page.goto(panelUrl);
  if (host.auth) await page.locator('.pn-so').waitFor(); else await page.locator('#pk-q').waitFor();
  // The cold start hands over to the content as a view transition; hit-testing waits for it to settle.
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
  await page.waitForTimeout(150);
  await page.evaluate((html) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); }, (host.barOverView ? HOST_BAR : '') + HOST_COMPOSER);
  return { page, errors, close: () => ctx.close() };
}

/** What a finger would hit at the control's centre: the control, or the host's chrome over it. */
async function hitAtCenter(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return { found: false, hit: null, inOpenArea: false };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
    return { found: true, hit: hit ? (hit.id || hit.className || hit.tagName) : null, hitsSelf: Boolean(hit && (hit === el || el.contains(hit))), top: r.top, bottom: r.bottom };
  }, selector);
}

describe('the harness itself', () => {
  it('sees the title bar cover the tabs when nothing keeps the panel out from under it', async () => {
    // An inline view never gets the floor; with no insets reported the header lands at the top, under the bar.
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.route(/^https?:/, (route) => route.abort());
    await page.addInitScript(({ data, D1 }) => {
      try { localStorage.setItem('orgx.panel.tour.v1', 'done'); } catch (_) { /* fine */ }
      (window as unknown as Record<string, unknown>).openai = {
        theme: 'dark', displayMode: 'inline', userAgent: { device: { type: 'mobile' }, capabilities: { hover: false, touch: true } },
        toolOutput: data, toolResponseMetadata: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 't' } } }, setWidgetHeight() {}, async callTool() { return { structuredContent: data }; },
      };
    }, { data: snapshot(), D1 });
    await page.goto(panelUrl);
    await page.locator('#pk-q').waitFor();
    await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
    await page.evaluate((html) => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); }, CHROME);
    try {
      const tab = await hitAtCenter(page, '#pn-tab-work');
      expect(tab.hitsSelf).toBe(false);
      expect(tab.hit).toBe('host-bar');
    } finally { await ctx.close(); }
  }, 30000);
});

describe.each([
  ['the host draws its bar over the view and reports its insets', { insets: { top: BAR, right: 0, bottom: COMPOSER, left: 0 }, barOverView: true }],
  ['the host starts the content below its bar and reports nothing (the floor)', {}],
])('ChatGPT phone chrome, when %s', (_label, host: Host) => {
  it('keeps the mark, the workspace name and every tab tappable under the title bar', async () => {
    const { page, errors, close } = await open(host);
    try {
      for (const sel of ['.pn-mark-slot', '.ws-btn', '#pn-tab-needs', '#pn-tab-work', '#pn-tab-done', '#pn-tab-start']) {
        const r = await hitAtCenter(page, sel);
        expect(r.found, sel).toBe(true);
        expect(r.hitsSelf, `${sel} is covered by ${r.hit}`).toBe(true);
        if (host.barOverView) expect(r.top, `${sel} starts under the title bar`).toBeGreaterThanOrEqual(BAR);
      }
      // A real tap on In progress switches the view; the host's bar does not swallow it.
      await page.locator('#pn-tab-work').tap();
      await page.locator('.pn-work').waitFor();
      expect(await page.locator('.pn-tab[aria-selected="true"]').getAttribute('data-tab')).toBe('work');
      await page.locator('#pn-tab-done').tap();
      await page.locator('.pn-done').waitFor();
      await page.locator('#pn-tab-needs').tap();
      await page.locator('#pk-q').waitFor();
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 30000);

  it('keeps the header pinned and the tabs reachable after the view has scrolled', async () => {
    const { page, close } = await open(host);
    try {
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
      const header = await hitAtCenter(page, '.ws-btn');
      expect(header.hitsSelf, `workspace selector is covered by ${header.hit}`).toBe(true);
      // Pinned: the header sits at the top of the open area, not scrolled away.
      expect(header.top).toBeLessThanOrEqual((host.barOverView ? BAR : 0) + 24);
      const r = await hitAtCenter(page, '#pn-tab-start');
      expect(r.hitsSelf, `Start tab is covered by ${r.hit}`).toBe(true);
      await page.locator('#pn-tab-start').tap();
      await page.locator('.pn-start').waitFor();
    } finally { await close(); }
  }, 30000);

  it('lets a person finish connecting: the steps read and the button can be pressed', async () => {
    const { page, errors, close } = await open({ ...host, auth: true });
    try {
      const title = await hitAtCenter(page, '.so-h');
      expect(title.hitsSelf, `title is covered by ${title.hit}`).toBe(true);
      const button = await hitAtCenter(page, '.so-acts [data-action="refresh"]');
      expect(button.hitsSelf, `connect button is covered by ${button.hit}`).toBe(true);
      expect(button.bottom).toBeLessThanOrEqual(PHONE.height - COMPOSER);
      await page.locator('.so-acts [data-action="refresh"]').tap();
      await page.locator('#pk-q').waitFor();
      const calls = await page.evaluate(() => (window as unknown as { __calls: { name: string }[] }).__calls.map((c) => c.name));
      expect(calls).toContain('orgx_panel_snapshot');
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 30000);

  it('keeps the tour card and its buttons out from under both bars', async () => {
    const { page, close } = await open({ ...host, tour: true });
    try {
      await page.locator('.pn-coach').waitFor();
      await page.waitForTimeout(400);
      for (let step = 0; step < 4; step += 1) {
        const next = await hitAtCenter(page, '[data-tour="next"]');
        expect(next.hitsSelf, `step ${step}: Next is covered by ${next.hit}`).toBe(true);
        const card = await page.locator('.pn-coach').boundingBox();
        if (host.barOverView) expect(card!.y, `step ${step}: card under the title bar`).toBeGreaterThanOrEqual(BAR);
        expect(card!.y + card!.height, `step ${step}: card under the composer`).toBeLessThanOrEqual(PHONE.height - COMPOSER + 1);
        await page.locator('[data-tour="next"]').tap();
        await page.waitForTimeout(450);
      }
    } finally { await close(); }
  }, 30000);
});
