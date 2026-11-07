import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Boots the real widget in JSDOM with its shared scripts (the MCP Apps SDK is
// skipped). The degraded fixture shows the map with its Retry strip.
async function bootMap(callTool: ReturnType<typeof vi.fn>) {
  const root = resolve(process.cwd(), 'public/widgets');
  const html = readFileSync(resolve(root, 'workspace-map.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/workspace-map.html?state=degraded', runScripts: 'outside-only' });
  Object.assign(dom.window, { openai: { toolOutput: null, callTool, setWidgetHeight: vi.fn() }, fetch: vi.fn().mockResolvedValue({ ok: true }) });
  for (const script of dom.window.document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    if (src && /mcp-apps-sdk/.test(src)) continue;
    dom.window.eval(src ? readFileSync(resolve(root, src), 'utf8') : script.textContent!);
  }
  await vi.advanceTimersByTimeAsync(50);
  return dom;
}

describe('workspace map re-check', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the surfaces when the workspace context for the same workspace carries none', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { workspace: { id: 'ws-demo', name: 'Atina Labs' }, initiative: null } });
    const dom = await bootMap(callTool);
    const doc = dom.window.document;
    expect(doc.querySelectorAll('.wm-surface').length).toBe(6);
    (doc.querySelector('[data-action="retry"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(50);
    expect(callTool).toHaveBeenCalledWith('orgx_get_workspace_context', { workspace_id: 'ws-demo' });
    expect(doc.querySelectorAll('.wm-surface').length).toBe(6);
    expect(doc.querySelector('[data-action="retry"]')).toBeNull();
    expect(doc.getElementById('content')!.textContent).not.toContain('This is the connected workspace');
    dom.window.close();
  });

  it('shows the context card when the check reads another workspace', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { workspace: { id: 'ws-other', name: 'Other' } } });
    const dom = await bootMap(callTool);
    (dom.window.document.querySelector('[data-action="retry"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(50);
    expect(dom.window.document.getElementById('content')!.textContent).toContain('This is the connected workspace');
    dom.window.close();
  });
});
