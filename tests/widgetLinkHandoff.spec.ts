// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../public/widgets/shared/widget-runtime.js';

const host = window as any;
const runtime = host.OrgXWidgetRuntime;
const originalParent = window.parent;
const url = 'https://useorgx.com/decisions/d-1';
const click = () => new MouseEvent('click', { bubbles: true, cancelable: true });

describe('widget link handoff failures', () => {
  afterEach(() => {
    runtime.__resetForTests();
    delete host.openai;
    delete host.McpApps;
    document.body.innerHTML = '';
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the documented ChatGPT openExternal href argument', () => {
    // The real host accepts href. A permissive spy used to hide the adapter's
    // incorrect { url } shape while every fixture click appeared successful.
    const opened: string[] = [];
    host.openai = { openExternal: (request: { href?: string; url?: string }) => {
      if (typeof request.href !== 'string' || request.url !== undefined) throw new Error('openExternal requires href');
      opened.push(request.href);
    } };
    const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    runtime.openWidgetLink(url, click());
    expect(opened).toEqual([url]);
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it.each([undefined, () => { throw new Error('Unavailable'); }])('preserves native anchor navigation when ChatGPT cannot open a link', (openExternal) => {
    host.openai = { openExternal };
    document.body.innerHTML = `<a ${runtime.links.attrs(url)}>Open</a>`;
    const event = click();
    document.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens a canceled button click synchronously when the host has no link capability', () => {
    host.openai = {};
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const event = click();
    event.preventDefault();
    expect(runtime.openWidgetLink(url, event)).toBe(false);
    expect(open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
  });

  it('uses ChatGPT immediately while an opted-in SDK handshake stalls', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: {} });
    const sdkOpen = vi.fn();
    host.McpApps = { App: class {
      connect() { return new Promise(() => {}); }
      openLink = sdkOpen;
      close() {}
    } };
    const openExternal = vi.fn();
    host.openai = { toolOutput: {}, openExternal };
    runtime.initWidget({ bridge: 'mcp-apps-sdk', render: vi.fn() });
    const event = click();
    expect(runtime.openWidgetLink(url, event)).toBe(false);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ href: url });
    expect(sdkOpen).not.toHaveBeenCalled();
  });

  it.each([() => Promise.reject(new Error('Refused')), () => Promise.resolve({ isError: true })])('offers a clickable recovery anchor after host refusal', async (openExternal) => {
    host.openai = { openExternal };
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    runtime.openWidgetLink(url, click());
    await Promise.resolve();
    const anchor = document.querySelector('#ox-link-recovery a') as HTMLAnchorElement;
    expect(anchor.href).toBe(url);
    expect(anchor.target).toBe('_blank');
    expect(anchor.hasAttribute('data-ox-link')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('shows recovery when a host never acknowledges the click', async () => {
    vi.useFakeTimers();
    host.openai = { openExternal: () => new Promise(() => {}) };
    runtime.openWidgetLink(url, click());
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector('#ox-link-recovery a')?.getAttribute('href')).toBe(url);
  });

  it('does not route the same component event twice', () => {
    const openExternal = vi.fn();
    host.openai = { openExternal };
    const event = new CustomEvent('ox-open', { detail: { href: url }, cancelable: true });
    runtime.openWidgetLink(url, event);
    runtime.openWidgetLink(url, event);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
