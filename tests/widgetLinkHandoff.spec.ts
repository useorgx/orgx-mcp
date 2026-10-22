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
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ url });
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

  it.each([() => undefined, () => Promise.resolve({})])('keeps recovery visible when a host silently completes without navigation', async (openExternal) => {
    host.openai = { openExternal };
    runtime.openWidgetLink(url, click());
    await Promise.resolve();
    const anchor = document.querySelector('#ox-link-recovery a') as HTMLAnchorElement;
    expect(anchor?.href).toBe(url);
    expect(anchor?.hasAttribute('data-ox-link')).toBe(false);
    expect(document.querySelector('#ox-link-recovery')?.textContent).toContain('If OrgX didn’t open');
  });

  it('keeps a recovery anchor when browser fallback produces no window handle', () => {
    host.openai = {};
    vi.spyOn(window, 'open').mockReturnValue(null);
    const event = click();
    event.preventDefault();
    runtime.openWidgetLink(url, event);
    expect(document.querySelector('#ox-link-recovery a')?.getAttribute('href')).toBe(url);
  });

  it.each([undefined, {}])('retains recovery after a legacy ui/open-link silent response: %j', async (result) => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage } });
    runtime.openWidgetLink(url, click());
    expect(postMessage).toHaveBeenCalledTimes(1);
    const request = postMessage.mock.calls[0]![0];
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'ui/open-link', params: { url } });
    window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', id: request.id, result } }));
    await Promise.resolve();
    expect(document.querySelector('#ox-link-recovery a')?.getAttribute('href')).toBe(url);
    expect(postMessage).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
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
