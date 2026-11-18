import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directory = resolve('public/widgets');
const workspace = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const receipt = 'trail:opaque/receipt';
const receiptPath = '/work-ledger/receipts/' + encodeURIComponent(receipt);
let dom: JSDOM;

async function mount(period = 'week') {
  const events = [
    { id: 'receipt:one', kind: 'receipt', title: 'Scoped receipt', url: receiptPath },
    { id: 'receipt:two', kind: 'receipt', title: 'Explicit receipt scope', url: receiptPath + '?center=' + otherWorkspace },
    { id: 'session:one', kind: 'session', title: 'Session ledger', url: '/work-ledger' },
    { id: 'pull_request:one', kind: 'pull_request', title: 'Pull request', url: 'https://github.com/useorgx/orgx-mcp/pull/605' },
  ].map((event) => ({ ...event, proofState: 'recorded', occurredAt: '2026-11-16T14:00:00Z' }));
  const payload = { chronicle: {
    workspaceId: workspace, workspaceName: 'Widget workspace', period,
    generatedAt: '2026-11-16T14:00:00Z', headline: 'Work recorded',
    metrics: { pendingDecisions: 1 }, reportingNarrative: { nextAction: 'Review the pending decision.' },
    continuity: { clients: [], events },
  } };
  dom = new JSDOM(readFileSync(resolve(directory, 'work-ledger.html'), 'utf8'), {
    url: 'https://mcp.useorgx.com/widgets/work-ledger.html', runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const scope = dom.window as any;
  const openExternal = vi.fn((request: { href?: string; url?: string }) => {
    if (typeof request.href !== 'string' || request.url !== undefined) throw new Error('ChatGPT requires href');
  });
  scope.openai = {
    toolOutput: payload, openExternal, setWidgetHeight() {},
    requestDisplayMode: vi.fn(async (request) => request),
  };
  scope.open = vi.fn();
  for (const script of dom.window.document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    // ChatGPT supplies its own bridge. The standard MCP Apps SDK is exercised
    // separately by the browser host matrix.
    if (src?.endsWith('mcp-apps-sdk.umd.js')) continue;
    scope.eval(src ? readFileSync(resolve(directory, src), 'utf8') : script.textContent || '');
  }
  await vi.waitFor(() => expect(dom.window.document.querySelector('.wl-attn')).not.toBeNull());
  return { document: dom.window.document, openExternal };
}

afterEach(() => dom?.window.close());

describe('Work Ledger navigation from a different active browser workspace', () => {
  it('opens both decision queue buttons in the card workspace through the documented host bridge', async () => {
    const { document, openExternal } = await mount();
    (document.querySelector('.wl-attn') as HTMLButtonElement).click();
    (document.querySelector('.wl-next button') as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenNthCalledWith(1, { href: `https://useorgx.com/decisions?status=pending&center=${workspace}` });
    expect(openExternal).toHaveBeenNthCalledWith(2, { href: `https://useorgx.com/decisions?status=pending&center=${workspace}` });
  });

  it('keeps opaque receipt identity and the card workspace on actual shadow-DOM row clicks', async () => {
    const { document, openExternal } = await mount();
    const row = document.querySelector('.wl-entry[label="Scoped receipt"]')!;
    const anchor = row.shadowRoot!.querySelector('a')!;
    anchor.click();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ href: `https://useorgx.com${receiptPath}?center=${workspace}` });
  });

  it('preserves a receipt URL’s explicit workspace instead of replacing it', async () => {
    const { document, openExternal } = await mount();
    const row = document.querySelector('.wl-entry[label="Explicit receipt scope"]')!;
    (row.shadowRoot!.querySelector('a')!).click();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith({ href: `https://useorgx.com${receiptPath}?center=${otherWorkspace}` });
  });

  it.each([['day', '7d'], ['week', '7d'], ['30d', '30d']])('keeps %s workspace and range through the footer and session link', async (period, range) => {
    const { document, openExternal } = await mount(period);
    const row = document.querySelector('.wl-entry[label="Session ledger"]')!;
    (row.shadowRoot!.querySelector('a')!).click();
    const footer = document.querySelector('ox-footer')!;
    (footer.shadowRoot!.querySelector('[part="action"]') as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenNthCalledWith(1, { href: `https://useorgx.com/work-ledger?center=${workspace}&range=${range}` });
    expect(openExternal).toHaveBeenNthCalledWith(2, { href: `https://useorgx.com/work-ledger?center=${workspace}&range=${range}` });
  });

  it('preserves receipt scope in the explorer while leaving GitHub evidence unchanged', async () => {
    const { document, openExternal } = await mount();
    (document.querySelector('.wl-explore') as HTMLButtonElement).click();
    const receiptRow = document.querySelector('.kx-entry[label="Scoped receipt"]')!;
    (receiptRow.shadowRoot!.querySelector('a')!).click();
    const pr = document.querySelector('.kx-entry[label="Pull request"]')!;
    (pr.shadowRoot!.querySelector('a')!).click();
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenNthCalledWith(1, { href: `https://useorgx.com${receiptPath}?center=${workspace}` });
    expect(openExternal).toHaveBeenNthCalledWith(2, { href: 'https://github.com/useorgx/orgx-mcp/pull/605' });
  });
});
