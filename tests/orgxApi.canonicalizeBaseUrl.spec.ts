import { describe, expect, it } from 'vitest';
import { canonicalizeOrgxApiBaseUrl } from '../src/orgxApi';

describe('canonicalizeOrgxApiBaseUrl', () => {
  it('strips a leading www. (the host that 301-redirects /api/*)', () => {
    expect(canonicalizeOrgxApiBaseUrl('https://www.useorgx.com')).toBe('https://useorgx.com');
  });
  it('upgrades http to https (308-redirects otherwise)', () => {
    expect(canonicalizeOrgxApiBaseUrl('http://useorgx.com')).toBe('https://useorgx.com');
  });
  it('fixes both at once and drops a trailing slash', () => {
    expect(canonicalizeOrgxApiBaseUrl('http://www.useorgx.com/')).toBe('https://useorgx.com');
  });
  it('leaves an already-canonical apex https URL unchanged', () => {
    expect(canonicalizeOrgxApiBaseUrl('https://useorgx.com')).toBe('https://useorgx.com');
  });
  it('leaves non-www subdomains (e.g. next) intact', () => {
    expect(canonicalizeOrgxApiBaseUrl('https://next.useorgx.com')).toBe('https://next.useorgx.com');
  });
  it('passes unparseable values through unchanged', () => {
    expect(canonicalizeOrgxApiBaseUrl('not a url')).toBe('not a url');
  });
});
