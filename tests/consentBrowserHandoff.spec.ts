import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const consentHtml = readFileSync(resolve('public/consent.html'), 'utf8');

describe('OAuth consent browser handoff', () => {
  it('completes consent through same-origin fetch before navigating to the client callback', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cspErrors: string[] = [];
    const consoleMessages: string[] = [];
    let callbackAccept = '';
    let callbackBody = '';

    page.on('console', (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
      if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
        cspErrors.push(message.text());
      }
    });

    await page.route('https://mcp.useorgx.test/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (url.pathname === '/consent.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self' https://chatgpt.com",
            ].join('; '),
          },
          body: consentHtml,
        });
        return;
      }

      if (url.pathname === '/oauth/consent-session') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            client: {
              id: 'chatgpt-test-client',
              name: 'ChatGPT',
              icon: 'chatgpt',
              identity_trust: 'verified_redirect',
              redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
              redirect_host: 'chatgpt.com',
            },
            account: {
              email: 'user@example.com',
              scope_boundary: 'accessible_workspaces',
            },
            authorization_policy: {
              version: 'test.v1',
              resources: [
                {
                  id: 'memory',
                  label: 'Memory',
                  description: 'Read durable organizational context.',
                  actions: [
                    {
                      access: 'read',
                      scope: 'memory:read',
                      description: 'Read durable organizational context.',
                    },
                  ],
                },
              ],
            },
            requested_scopes: ['memory:read'],
          }),
        });
        return;
      }

      if (url.pathname === '/oauth/consent-callback') {
        callbackAccept = request.headers().accept ?? '';
        callbackBody = request.postData() ?? '';
        if (!callbackAccept.includes('application/json')) {
          await route.fulfill({
            status: 302,
            headers: {
              location: 'https://chatgpt.com/connector_platform_oauth_redirect?code=test-code',
            },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            redirect_to:
              'https://chatgpt.com/connector_platform_oauth_redirect?code=test-code',
          }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: 'not found' });
    });

    await page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: 'connected' });
    });

    try {
      await page.goto('https://mcp.useorgx.test/consent.html?state_key=test-state');
      await page.waitForSelector('#configure-stage.active');
      await page.getByRole('button', { name: 'Review access', exact: true }).click();
      try {
        await Promise.all([
          page.waitForURL(
            'https://chatgpt.com/connector_platform_oauth_redirect?code=test-code',
            { timeout: 3_000 }
          ),
          page.getByRole('button', { name: 'Authorize ChatGPT', exact: true }).click(),
        ]);
      } catch {
        throw new Error(JSON.stringify({
          url: page.url(),
          body: await page.locator('body').innerText(),
          callbackAccept,
          callbackBody,
          consoleMessages,
        }));
      }

      expect(callbackAccept).toContain('application/json');
      expect(callbackBody).toContain('name="state_key"');
      expect(callbackBody).toContain('test-state');
      expect(callbackBody).toContain('name="action"');
      expect(callbackBody).toContain('approve');
      expect(cspErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
