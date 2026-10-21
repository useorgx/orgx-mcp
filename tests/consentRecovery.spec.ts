import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const consentHtml = readFileSync(resolve('public/consent.html'), 'utf8');
const consentScript = readFileSync(resolve('public/consent.js'), 'utf8');
const origin = 'https://mcp.useorgx.test';
const payload = {
  client: { name: 'ChatGPT', icon: 'chatgpt', redirect_uri: 'https://chatgpt.com/callback' },
  account: { email: 'person@example.com' },
  authorization_policy: {
    version: 'test',
    resources: [{
      id: 'memory', label: 'Memory', description: 'Read saved context.',
      actions: [{ access: 'read', scope: 'memory:read', description: 'Read saved context.' }],
    }],
  },
  requested_scopes: ['memory:read'],
};

describe('OAuth consent request recovery', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function open(options: { hangLoad?: boolean; hangApprove?: boolean; dnt?: boolean } = {}) {
    const page = await browser.newPage();
    await page.clock.install();
    if (options.dnt) {
      await page.addInitScript(() => Object.defineProperty(navigator, 'doNotTrack', { value: '1' }));
    }
    const traces: Array<Record<string, unknown>> = [];
    let callbackRequests = 0;
    let hangLoad = options.hangLoad;
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/consent.html') {
        return route.fulfill({ contentType: 'text/html', body: consentHtml });
      }
      if (path === '/consent.js') {
        return route.fulfill({ contentType: 'application/javascript', body: consentScript });
      }
      if (path === '/oauth/consent-trace') {
        traces.push(JSON.parse(request.postData() ?? '{}'));
        return route.fulfill({ status: 204 });
      }
      if (path === '/oauth/consent-session') {
        if (hangLoad) return;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      }
      if (path === '/oauth/consent-callback') {
        callbackRequests++;
        if (options.hangApprove) return;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ redirect_to: '/connected' }) });
      }
      return route.fulfill({ status: 404 });
    });
    await page.goto(`${origin}/consent.html?state_key=opaque-test-session`);
    return { page, traces, resumeLoad: () => { hangLoad = false; }, callbackRequests: () => callbackRequests };
  }

  it('ends a hung session load after 15 seconds and safely retries the read', async () => {
    const setup = await open({ hangLoad: true });
    try {
      await setup.page.clock.fastForward(16_000);
      await setup.page.getByRole('heading', { name: 'Connection could not be prepared' }).waitFor();
      expect(await setup.page.locator('#status-panel').innerText()).toContain('within 15 seconds');
      setup.resumeLoad();
      await setup.page.getByRole('button', { name: 'Retry loading' }).click();
      await setup.page.locator('#panel:not([hidden])').waitFor();
      await expect.poll(() => setup.traces.map((trace) => trace.stage)).toContain('consent_viewed');
      expect(setup.traces).toContainEqual({
        state_key: 'opaque-test-session', stage: 'consent_failed', reason: 'request_timeout',
      });
      expect(setup.callbackRequests()).toBe(0);
    } finally { await setup.page.close(); }
  });

  it('bounds an uncertain approval and never resubmits a duplicate click', async () => {
    const setup = await open({ hangApprove: true });
    try {
      await setup.page.locator('#panel:not([hidden])').waitFor();
      await setup.page.getByRole('button', { name: 'Review access', exact: true }).click();
      const request = setup.page.waitForRequest(`${origin}/oauth/consent-callback`);
      await setup.page.evaluate(() => {
        const button = document.getElementById('authorize-button') as HTMLButtonElement;
        button.click();
        button.click();
      });
      await request;
      await setup.page.clock.fastForward(16_000);
      await setup.page.getByRole('heading', { name: 'Connection could not be completed' }).waitFor();
      expect(await setup.page.locator('#status-panel').innerText()).toContain('start the OrgX connection again');
      expect(await setup.page.getByRole('button', { name: 'Retry loading' }).count()).toBe(0);
      expect(setup.callbackRequests()).toBe(1);
      await expect.poll(() => setup.traces.map((trace) => trace.stage)).toEqual([
        'consent_viewed', 'consent_reviewed', 'consent_failed',
      ]);
      expect(setup.traces.at(-1)?.reason).toBe('request_timeout');
      expect(setup.traces.every((trace) => Object.keys(trace).every((key) => ['state_key', 'stage', 'reason'].includes(key)))).toBe(true);
    } finally { await setup.page.close(); }
  });

  it('also bounds an unfinished JSON response body', async () => {
    const page = await browser.newPage();
    await page.clock.install();
    await page.addInitScript(() => {
      const realFetch = window.fetch;
      window.fetch = (input, init) => String(input).startsWith('/oauth/consent-session')
        ? Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }))
        : realFetch(input, init);
    });
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill(path === '/consent.html'
        ? { contentType: 'text/html', body: consentHtml }
        : path === '/consent.js'
          ? { contentType: 'application/javascript', body: consentScript }
          : { status: 204 });
    });
    try {
      await page.goto(`${origin}/consent.html?state_key=opaque-test-session`);
      await page.clock.fastForward(16_000);
      await page.getByRole('heading', { name: 'Connection could not be prepared' }).waitFor();
      expect(await page.locator('#status-panel').innerText()).toContain('within 15 seconds');
    } finally { await page.close(); }
  });

  it('honors browser DNT while leaving consent usable', async () => {
    const setup = await open({ dnt: true });
    try {
      await setup.page.locator('#panel:not([hidden])').waitFor();
      await setup.page.getByRole('button', { name: 'Review access', exact: true }).click();
      expect(await setup.page.getByRole('button', { name: 'Authorize ChatGPT' }).isVisible()).toBe(true);
      expect(setup.traces).toEqual([]);
    } finally { await setup.page.close(); }
  });
});
