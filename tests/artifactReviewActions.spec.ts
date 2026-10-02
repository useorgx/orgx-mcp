// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const widgetHtml = readFileSync(join(process.cwd(), 'public', 'widgets', 'artifact-review.html'), 'utf8');
const scriptSource =
  Array.from(new JSDOM(widgetHtml).window.document.querySelectorAll('script')).find((script) =>
    script.textContent?.includes('buildQualityAnatomy'),
  )?.textContent ?? '';

function mount(query: string, callTool = vi.fn().mockResolvedValue({})) {
  const dom = new JSDOM(widgetHtml, {
    url: `https://example.test/widgets/artifact-review.html?${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => 'standalone',
      reportSize: vi.fn(),
      callTool,
      openWidgetLink: vi.fn(),
      initWidget: vi.fn(),
    },
  });
  dom.window.eval(scriptSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { dom, doc: dom.window.document, callTool };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('artifact review actions in the kit footer', () => {
  it('keeps approve and request changes as slotted footer controls', () => {
    const { doc } = mount('state=ready');
    const footer = doc.getElementById('reviewFooter')!;
    const approve = footer.querySelector('[data-action="approve"]')!;
    const changes = footer.querySelector('[data-action="request-changes"]')!;
    expect(approve.getAttribute('slot')).toBe('primary');
    expect(changes.getAttribute('slot')).toBe('action');
    expect(changes.getAttribute('aria-controls')).toBe('artifact-change-composer');
  });

  it('approves on a full hold with the same orgx_act call', async () => {
    const { dom, doc, callTool } = mount('state=ready');
    const approve = doc.querySelector('[data-action="approve"]')!;
    approve.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
    await wait(900);
    expect(callTool).toHaveBeenCalledWith('orgx_act', { type: 'artifact', id: 'ART-DEMO', action: 'approve' });
    await wait(400);
    expect(doc.body.textContent).toContain('Approval recorded');
  });

  it('puts request changes first when approval is held, and files the same decision', async () => {
    const { doc, callTool } = mount('state=urgent');
    const footer = doc.getElementById('reviewFooter')!;
    const changes = footer.querySelector<HTMLButtonElement>('[data-action="request-changes"]')!;
    expect(changes.getAttribute('slot')).toBe('primary');
    expect(footer.querySelector<HTMLButtonElement>('[data-action="approve"]')!.disabled).toBe(true);

    changes.click();
    expect(footer.getAttribute('heading')).toBe('Request changes');
    const input = doc.querySelector<HTMLTextAreaElement>('[data-composer-input]')!;
    input.value = 'Cite the source studies.';
    footer.querySelector<HTMLButtonElement>('[data-composer-submit]')!.click();
    await wait(20);
    expect(callTool).toHaveBeenNthCalledWith(1, 'orgx_decide', expect.objectContaining({
      action: 'create',
      summary: 'Cite the source studies.',
      entity_type: 'artifact',
      entity_id: 'ART-DEMO',
    }));
    expect(callTool).toHaveBeenNthCalledWith(2, 'orgx_act', { type: 'artifact', id: 'ART-DEMO', action: 'request_changes' });
  });

  it('keeps the note and the controls when the change request fails', async () => {
    const { doc } = mount('state=urgent', vi.fn().mockRejectedValue(new Error('refused')));
    const footer = doc.getElementById('reviewFooter')!;
    footer.querySelector<HTMLButtonElement>('[data-action="request-changes"]')!.click();
    doc.querySelector<HTMLTextAreaElement>('[data-composer-input]')!.value = 'Cite the source studies.';
    footer.querySelector<HTMLButtonElement>('[data-composer-submit]')!.click();
    await wait(20);
    expect(footer.getAttribute('state')).toBe('failed');
    expect(doc.querySelector<HTMLTextAreaElement>('[data-composer-input]')!.value).toBe('Cite the source studies.');
    expect(footer.querySelector<HTMLButtonElement>('[data-composer-submit]')!.disabled).toBe(false);
  });
});
