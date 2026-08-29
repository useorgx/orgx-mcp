import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const consentHtml = readFileSync(resolve('public/consent.html'), 'utf8');

const resources = [
  {
    id: 'decisions',
    label: 'Decisions',
    description: 'Organizational decisions, approvals, and decision history.',
    actions: [
      {
        access: 'read',
        scope: 'decisions:read',
        description: 'View decisions, approvals, and their history.',
      },
      {
        access: 'operate',
        scope: 'decisions:write',
        description: 'Create, approve, reject, or update decisions.',
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    description: 'Delegated agent work, status, handoffs, and lifecycle.',
    actions: [
      {
        access: 'read',
        scope: 'agents:read',
        description: 'View agent work, status, and execution history.',
      },
      {
        access: 'operate',
        scope: 'agents:write',
        description: 'Delegate, hand off, retry, pause, resume, or cancel work.',
      },
    ],
  },
  {
    id: 'initiatives',
    label: 'Initiatives',
    description: 'Initiatives, milestones, tasks, artifacts, and receipts.',
    actions: [
      {
        access: 'read',
        scope: 'initiatives:read',
        description: 'View initiatives, work state, artifacts, and receipts.',
      },
      {
        access: 'operate',
        scope: 'initiatives:write',
        description: 'Create or update work and attach artifacts or proof.',
      },
    ],
  },
  {
    id: 'memory',
    label: 'Organizational memory',
    description: 'Durable organizational context and recalled knowledge.',
    actions: [
      {
        access: 'read',
        scope: 'memory:read',
        description: 'Search and recall organizational memory.',
      },
    ],
  },
];

type ConsentPayload = {
  client: {
    id: string;
    name: string;
    icon: string;
    identity_trust: string;
    redirect_uri: string;
    redirect_host: string;
  };
  account: { email: string; scope_boundary: string };
  authorization_policy: { version: string; resources: unknown[] };
  requested_scopes: string[];
  scope_resolution: { source: string; status: string };
};

const defaultPayload: ConsentPayload = {
  client: {
    id: 'claude-code-orgx',
    name: 'Claude Code (orgx)',
    icon: 'claude',
    identity_trust: 'registered_metadata',
    redirect_uri: 'http://127.0.0.1:3118/callback',
    redirect_host: '127.0.0.1:3118',
  },
  account: {
    email: 'operator@example.com',
    scope_boundary: 'accessible_workspaces',
  },
  authorization_policy: { version: 'test.v1', resources },
  requested_scopes: [
    'decisions:read',
    'agents:read',
    'initiatives:read',
    'memory:read',
  ],
  scope_resolution: { source: 'server_read_default', status: 'ready' },
};

async function openConsent(
  browser: Browser,
  payload: ConsentPayload,
  viewport: { width: number; height: number }
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.route('https://mcp.useorgx.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/consent.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: consentHtml,
      });
      return;
    }
    if (url.pathname === '/oauth/consent-session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('https://mcp.useorgx.test/consent.html?state_key=test-state');
  await page.waitForSelector('#shell:not(.loading)');
  return page;
}

describe('OAuth consent presentation', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('shows Claude identity, the closed-registry ambient theme, and disclosed read defaults', async () => {
    const page = await openConsent(browser, defaultPayload, {
      width: 1440,
      height: 960,
    });
    try {
      expect(await page.locator('#client-name').textContent()).toBe(
        'Claude Code (orgx)'
      );
      expect(
        await page.locator('#client-icon').getAttribute('data-client-kind')
      ).toBe('claude');
      expect(await page.locator('#client-icon path').getAttribute('fill')).toBe(
        '#D97757'
      );
      expect(await page.locator('#client-identity-copy').textContent()).toBe(
        'Name supplied by this OAuth client'
      );
      expect(await page.locator('#scope-notice').textContent()).toContain(
        'Read-only baseline applied.'
      );
      expect(await page.locator('.resource-row').count()).toBe(4);
      expect(await page.locator('#review-button').isEnabled()).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.dataset.clientKind)
      ).toBe('claude');
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--client-accent-rgb')
            .trim()
        )
      ).toBe('217, 119, 87');
      expect(
        await page.locator('#field-client-mark path').getAttribute('fill')
      ).toBe('#D97757');
    } finally {
      await page.close();
    }
  });

  it('renders Cursor explicit-empty access as a blocked explanation, never a blank policy well', async () => {
    const page = await openConsent(
      browser,
      {
        ...defaultPayload,
        client: {
          ...defaultPayload.client,
          id: 'cursor-orgx',
          name: 'Cursor (orgx)',
          icon: 'cursor',
        },
        requested_scopes: [],
        scope_resolution: { source: 'client_request', status: 'empty' },
      },
      { width: 768, height: 960 }
    );
    try {
      expect(await page.locator('.resource-row').count()).toBe(0);
      expect(await page.locator('.resource-empty').textContent()).toContain(
        'No OrgX access requested'
      );
      expect(await page.locator('#scope-notice').textContent()).toContain(
        'Nothing can be authorized yet.'
      );
      expect(await page.locator('#review-button').isDisabled()).toBe(true);
      expect(await page.locator('[data-preset="read"]').isDisabled()).toBe(
        true
      );
      expect(
        await page.evaluate(() => document.documentElement.dataset.clientKind)
      ).toBe('cursor');
    } finally {
      await page.close();
    }
  });

  it('fails visibly when the canonical authorization policy is unavailable', async () => {
    const page = await openConsent(
      browser,
      {
        ...defaultPayload,
        authorization_policy: { version: 'test.v1', resources: [] },
      },
      { width: 768, height: 960 }
    );
    try {
      expect(await page.locator('#status-panel').getAttribute('class')).toContain(
        'active'
      );
      expect(await page.locator('#status-panel').textContent()).toContain(
        'Connection could not be prepared'
      );
      expect(await page.locator('#status-panel').textContent()).toContain(
        'authorization policy could not be loaded'
      );
      expect(
        await page.evaluate(() => document.documentElement.dataset.clientKind)
      ).toBe('claude');
    } finally {
      await page.close();
    }
  });

  it('keeps long identity and policy content usable at 375px with keyboard-visible controls', async () => {
    const longResource = {
      ...resources[0],
      label:
        'Decisions, authorization reviews, delegated approvals, and durable organizational judgments',
      description:
        'Organizational decisions with unusually long explanatory context that must stay contained on a narrow viewport.',
    };
    const page = await openConsent(
      browser,
      {
        ...defaultPayload,
        client: {
          ...defaultPayload.client,
          name: 'Claude Code (orgx) — long local workspace connection identity',
        },
        account: {
          ...defaultPayload.account,
          email: 'operator-with-a-very-long-address@example-long-domain.test',
        },
        authorization_policy: {
          version: 'test.long.v1',
          resources: [longResource],
        },
        requested_scopes: ['decisions:read'],
        scope_resolution: { source: 'client_request', status: 'ready' },
      },
      { width: 375, height: 812 }
    );
    try {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      const readPreset = page.locator('[data-preset="read"]');
      await readPreset.focus();
      expect(
        await readPreset.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
        })
      ).toBe(true);

      const resourceSummary = page.locator('.resource-summary');
      await resourceSummary.focus();
      await page.keyboard.press('Enter');
      expect(await resourceSummary.getAttribute('aria-expanded')).toBe('true');
      const minimumTarget = await resourceSummary.evaluate((element) =>
        Math.min(element.getBoundingClientRect().width, element.getBoundingClientRect().height)
      );
      expect(minimumTarget).toBeGreaterThanOrEqual(44);
    } finally {
      await page.close();
    }
  });
});
