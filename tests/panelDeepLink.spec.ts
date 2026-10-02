// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import '../public/widgets/shared/openai-extensions.js';

type Target = { type: 'decision' | 'initiative'; id: string; initiativeId?: string } | null;

interface Shim {
  parsePanelDeepLink(url: unknown): Target;
  normalizeDeepLinkState(state: unknown): { url: string } | undefined;
  createExtensions(app: unknown): { deepLink?: { getCurrent(): { url: string } | undefined } };
}

const shim = (window as unknown as { OrgXOpenAIExtensions: Shim }).OrgXOpenAIExtensions;

const D = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
const I = 'c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f';

describe('panel deep-link allowlist', () => {
  it.each([
    [`https://useorgx.com/decisions/${D}`, { type: 'decision', id: D }],
    [`https://www.useorgx.com/decisions/${D}`, { type: 'decision', id: D }],
    [`https://useorgx.com/decisions/${D.toUpperCase()}`, { type: 'decision', id: D }],
    [`https://useorgx.com/initiatives/${I}?decision=${D}`, { type: 'decision', id: D, initiativeId: I }],
    [`https://useorgx.com/initiatives/${I}?focus=decisions&decision=${D}`, { type: 'decision', id: D, initiativeId: I }],
    [`https://useorgx.com/live/${I}`, { type: 'initiative', id: I }],
    [`https://useorgx.com:443/decisions/${D}`, { type: 'decision', id: D }],
    // Host-relative links (the package's older path/query form) resolve
    // against https://useorgx.com and pass the same checks.
    [`/decisions/${D}`, { type: 'decision', id: D }],
  ])('accepts %s', (url, expected) => {
    expect(shim.parsePanelDeepLink(url)).toEqual(expected);
  });

  it.each([
    [`https://useorgx.com.evil.com/decisions/${D}`],
    [`https://evil.com/decisions/${D}`],
    [`https://evil.useorgx.com/decisions/${D}`],
    [`https://app.useorgx.com/decisions/${D}`],
    [`http://useorgx.com/decisions/${D}`],
    [`javascript:alert(1)//useorgx.com/decisions/${D}`],
    [`data:text/html,https://useorgx.com/decisions/${D}`],
    [`//evil.com/decisions/${D}`],
    [`/\\evil.com/decisions/${D}`],
    [`https://user:pass@useorgx.com/decisions/${D}`],
    [`https://useorgx.com:8443/decisions/${D}`],
    [`https://useorgx.com/decisions/not-a-uuid`],
    [`https://useorgx.com/decisions/${D}x`],
    [`https://useorgx.com/decisions/${D}/edit`],
    [`https://useorgx.com/decisions/${D}/`],
    [`https://useorgx.com/en/decisions/${D}`],
    [`https://useorgx.com/decisions/${D}?decision=${D}`],
    [`https://useorgx.com/decisions/%2F${D}`],
    [`https://useorgx.com/initiatives/${I}`],
    [`https://useorgx.com/initiatives/${I}?decision=nope`],
    [`https://useorgx.com/initiatives/${I}?decision=${D}&decision=${D}`],
    [`https://useorgx.com/artifacts/${D}`],
    [`https://useorgx.com/live/${I}/x`],
    [''],
    [null],
    [42],
  ])('rejects %s', (url) => {
    expect(shim.parsePanelDeepLink(url)).toBeNull();
  });

  it('normalizes the older path/query host state the package also accepts', () => {
    expect(shim.normalizeDeepLinkState({ path: ['initiatives', I], query: [['decision', D]] })).toEqual({
      url: `/initiatives/${I}?decision=${D}`,
    });
    expect(shim.normalizeDeepLinkState({ url: `https://useorgx.com/decisions/${D}` })).toEqual({
      url: `https://useorgx.com/decisions/${D}`,
    });
    expect(shim.normalizeDeepLinkState({ nope: true })).toBeUndefined();
  });

  it('exposes deep links only when the host context carries openai/deepLink', () => {
    const withLink = { getHostContext: () => ({ 'openai/deepLink': { url: `https://useorgx.com/decisions/${D}` } }) };
    const without = { getHostContext: () => ({ theme: 'dark' }) };
    expect(shim.createExtensions(withLink).deepLink?.getCurrent()).toEqual({ url: `https://useorgx.com/decisions/${D}` });
    expect(shim.createExtensions(without).deepLink).toBeUndefined();
    expect(shim.createExtensions(null).deepLink).toBeUndefined();
  });
});
