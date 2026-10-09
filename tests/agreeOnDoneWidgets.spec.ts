import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DECISION = '5b1c9e2a-4f3d-4a8b-9e61-2c7d0a9f4b13';
const INITIATIVE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A scaffold_initiative result as the worker returns it, with the bar in `expectations`. */
function scaffoldResult(expectations: Record<string, unknown> | null, launch: Record<string, unknown> = { attempted: false, ok: false }) {
  return {
    mode: 'scaffold',
    initiative_id: INITIATIVE,
    hierarchy: {
      initiative: { id: INITIATIVE, title: 'Launch the new pricing page', status: 'scaffolded' },
      workstreams: [
        { id: 'w1', ref: 'ws-1', title: 'Build the page', agent_name: 'Eli', milestones: [{ id: 'm1', title: 'Page', tasks: [{ id: 't1', ref: 'task-1-1-1', title: 'Ship it' }] }] },
        { id: 'w2', ref: 'ws-2', title: 'Launch post', agent_name: 'Mark', milestones: [{ id: 'm2', title: 'Post', tasks: [{ id: 't2', title: 'Write it' }] }] },
      ],
    },
    agent_assignment: { assignments: [
      { workstream_id: 'w1', agent_id: 'engineering-agent', agent_name: 'Eli', domain: 'engineering' },
      { workstream_id: 'w2', agent_id: 'marketing-agent', agent_name: 'Mark', domain: 'marketing' },
    ] },
    launch,
    ...(expectations ? { expectations } : {}),
  };
}
const checks = [
  { scope: 'workstream', scope_id: 'w1', statement: 'Every PR is reviewed by a person', verify: 'manual', source: 'rule', owner_agent: 'engineering-agent' },
  { scope: 'task', scope_id: 'task-1-1-1', statement: 'Checkout e2e passes', verify: 'command', source: 'artifact_type', owner_agent: 'engineering-agent' },
  { scope: 'workstream', scope_id: 'ws-2', statement: 'Ends with one clear call to action', verify: 'manual', source: 'learned', source_label: 'your call on the launch post', owner_agent: 'marketing-agent' },
  { scope: 'initiative', statement: 'No outbound email without approval', verify: 'manual', source: 'rule' },
];
const set = (status: string, extra: Record<string, unknown> = {}) => ({ status, decision_id: DECISION, checks, ...extra });

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

async function openWidget(path: string, host: { toolOutput?: unknown; meta?: unknown; launchError?: string } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  page.setDefaultTimeout(5_000);
  await page.route('**/*', (route) => route.abort());
  await page.route('https://mcp.useorgx.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes('..')) return route.abort();
    try {
      const body = readFileSync('public' + pathname);
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
      await route.fulfill({ body, contentType });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.addInitScript((h) => {
    const w = window as unknown as Record<string, unknown> & { calls: unknown[] };
    w.calls = [];
    if (!h.toolOutput) return;
    w.openai = {
      toolOutput: h.toolOutput,
      toolResponseMetadata: h.meta || null,
      setWidgetHeight() {},
      async callTool(tool: string, args: Record<string, unknown>) {
        w.calls.push({ tool, args });
        if (tool === 'orgx_launch_initiative' && h.launchError) throw new Error(h.launchError);
        return { structuredContent: { ok: true } };
      },
    };
  }, host);
  await page.goto('https://mcp.useorgx.test/widgets/' + path, { waitUntil: 'domcontentloaded' });
  return page;
}
const footer = (page: Page) => page.locator('#scaffoldFooter');
const press = (page: Page) => page.evaluate(() => document.getElementById('scaffoldFooter')!.dispatchEvent(new CustomEvent('ox-primary')));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

describe('scaffold widget: Done means', () => {
  it('drafted (can agree here): Agree and launch settles the decision with its single-use token', async () => {
    const page = await openWidget('scaffolded-initiative.html', {
      toolOutput: scaffoldResult(set('drafted'), { attempted: true, ok: false, held_for_agreement: true, decision_id: DECISION }),
      meta: { 'orgx/widgetApproval': { approval_tokens: { [DECISION]: 'single-use-token' } } },
    });
    try {
      await page.locator('.dm[data-state="can_agree"]').waitFor();
      expect(await footer(page).getAttribute('primary-label')).toBe('Agree and launch');
      expect(await footer(page).getAttribute('heading')).toBe('Agree on what done means');
      // Done means keeps the makeup and the initiative-wide checks; each workstream row carries its own.
      expect(await page.locator('.dm .xp-lg').allTextContents()).toEqual(['2rules', '1kind of work', '1learned']);
      expect(await page.locator('.dm .xp-gh .xp-gn').allTextContents()).toEqual(['Across the initiative']);
      expect(await page.locator('.dm .xp-look.is-calm .xp-h').textContent()).toContain('Nothing new');
      expect(await page.locator('.ws .ws-checks').allTextContents()).toEqual(['2 checks', '1 check']);
      await page.locator('.node-toggle').first().click();
      // Task checks fold under their workstream.
      expect(await page.locator('.ws').first().locator('.ws-done .xp-rt').allTextContents()).toEqual(['Every PR is reviewed by a person', 'Checkout e2e passes']);
      expect(await noOverflow(page)).toBe(true);
      await press(page);
      await page.locator('.dm[data-state="agreed"]').waitFor();
      const calls = await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
      expect(calls).toEqual([{ tool: 'orgx_widget_decide', args: { decision_id: DECISION, action: 'approve', kind: 'decision', approval_token: 'single-use-token' } }]);
      expect(await footer(page).getAttribute('heading')).toBe('Agreed · launching');
    } finally { await page.close(); }
  });

  it('waiting: without a token it points to Needs you and never launches from here', async () => {
    const page = await openWidget('scaffolded-initiative.html', {
      toolOutput: scaffoldResult(set('drafted'), { attempted: true, ok: false, held_for_agreement: true, decision_id: DECISION }),
    });
    try {
      await page.locator('.dm[data-state="waiting"]').waitFor();
      expect(await footer(page).getAttribute('heading')).toBe('Waiting for you in Needs you');
      expect(await footer(page).getAttribute('primary-label')).toBeNull();
      expect(await page.locator('[data-open-live-view]').getAttribute('data-href')).toContain(DECISION);
    } finally { await page.close(); }
  });

  it('drafted before launch: Hold to launch, and a held launch turns into waiting', async () => {
    const page = await openWidget('scaffolded-initiative.html', {
      toolOutput: scaffoldResult(set('drafted', { decision_id: null })),
      launchError: `Launch is waiting for you to agree on what done means (decision ${DECISION}).`,
    });
    try {
      await page.locator('.dm[data-state="drafted"]').waitFor();
      expect(await footer(page).getAttribute('primary-label')).toBe('Hold to launch');
      expect(await footer(page).getAttribute('detail')).toBe('you agree on what done means next');
      await press(page);
      await page.locator('.dm[data-state="waiting"]').waitFor();
      expect(await footer(page).getAttribute('state')).toBe('waiting');
      expect(await page.locator('[data-open-live-view]').getAttribute('data-href')).toContain(DECISION);
    } finally { await page.close(); }
  });

  it('agreed: the bar folds to one line with its date', async () => {
    const page = await openWidget('scaffolded-initiative.html', { toolOutput: scaffoldResult(set('agreed', { agreed_at: '2026-10-08T15:20:00.000Z' })) });
    try {
      await page.locator('.dm[data-state="agreed"]').waitFor();
      expect(await page.locator('.dm-state').textContent()).toMatch(/^agreed \w+ \d+$/);
      expect(await page.locator('#dm-body').isHidden()).toBe(true);
      expect(await page.locator('[data-dm-toggle]').textContent()).toBe('Show 4');
      expect(await footer(page).getAttribute('primary-label')).toBe('Hold to launch');
    } finally { await page.close(); }
  });

  it('sent back: says OrgX is redrafting it and offers nothing to press', async () => {
    const page = await openWidget('scaffolded-initiative.html', { toolOutput: scaffoldResult(set('sent_back')) });
    try {
      await page.locator('.dm[data-state="sent_back"]').waitFor();
      expect(await footer(page).getAttribute('heading')).toBe('Sent back');
      expect(await footer(page).getAttribute('primary-label')).toBeNull();
    } finally { await page.close(); }
  });

  it('no bar: the card is unchanged', async () => {
    const page = await openWidget('scaffolded-initiative.html', { toolOutput: scaffoldResult(null) });
    try {
      await footer(page).waitFor();
      await page.waitForFunction(() => document.getElementById('scaffoldFooter')!.getAttribute('heading') === 'Ready to launch');
      expect(await page.locator('.dm').count()).toBe(0);
      expect(await footer(page).getAttribute('detail')).toContain('checks green');
    } finally { await page.close(); }
  });
});

describe('decisions widget: an Agree on done decision', () => {
  it('shows the bar, says Agree, and is never swept into Approve all', async () => {
    const page = await openWidget('decisions.html?state=agree');
    try {
      await page.locator('.dq-bar').waitFor();
      expect(await page.locator('.dq-bar .xp-gh .xp-gn').allTextContents()).toEqual(['Eli', 'Mark', 'Across the initiative']);
      expect(await page.locator('.dq-bar .xp-look[data-xp-view=""] .xp-rt').allTextContents()).toEqual(['Plans on the page match the billing catalog (new)', 'Lighthouse performance is 90 or higher']);
      const ft = page.locator('ox-footer[data-decision-id="x1"]');
      expect(await ft.getAttribute('primary-label')).toBe('Agree · start work');
      expect(await ft.getAttribute('heading')).toBe('Agree on done');
      expect(await page.locator('.dq-batch-copy').textContent()).toBe('2 need only your approval');
      expect(await noOverflow(page)).toBe(true);
    } finally { await page.close(); }
  });
});
