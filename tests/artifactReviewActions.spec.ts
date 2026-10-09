// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { installSharedFoundations } from './fixtures/sharedFoundations';

const widgetHtml = readFileSync(join(process.cwd(), 'public', 'widgets', 'artifact-review.html'), 'utf8');
const scriptSource =
  Array.from(new JSDOM(widgetHtml).window.document.querySelectorAll('script')).find((script) =>
    script.textContent?.includes('buildQualityAnatomy'),
  )?.textContent ?? '';

function mount(query: string, callTool = vi.fn().mockImplementation((name: string) => Promise.resolve({ structuredContent: { ok: true, review_status: name === 'orgx_widget_approve_artifact' ? 'approved' : 'changes_requested' } })), protocol = 'standalone') {
  const dom = new JSDOM(widgetHtml, {
    url: `https://example.test/widgets/artifact-review.html?${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  installSharedFoundations(dom.window);
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => protocol,
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

  it('approves on a single click with the explicit human review call, once', async () => {
    const { doc, callTool } = mount('state=ready');
    const footer = doc.getElementById('reviewFooter')!;
    expect(footer.getAttribute('detail')).toBe('recorded in OrgX');
    expect(footer.hasAttribute('hold')).toBe(false);
    const approve = doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    expect(approve.hasAttribute('aria-describedby')).toBe(false);
    approve.click();
    approve.click();
    await wait(20);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('orgx_widget_approve_artifact', { artifact_id: 'ART-DEMO', expected_version: 5 });
    await wait(400);
    expect(doc.body.textContent).toContain('Approval recorded');
  });

  it('offers the OrgX review link when the host result grants no human review token', () => {
    const { doc, callTool } = mount('state=ready', vi.fn(), 'chatgpt');
    expect(doc.querySelector('[data-action="approve"]')).toBeNull();
    expect(doc.querySelector('[data-action="request-changes"]')).toBeNull();
    expect(doc.querySelector('#handoffFooter')!.getAttribute('action-label')).toBe('Open in OrgX ↗');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('keeps the review open when the server only acknowledges the request', async () => {
    const { doc } = mount('state=ready', vi.fn().mockResolvedValue({ structuredContent: { ok: true, review_status: 'pending' } }));
    doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    await wait(20);
    expect(doc.getElementById('reviewFooter')!.getAttribute('state')).toBe('failed');
    expect(doc.querySelector('.review-question')!.textContent).not.toBe('Approval recorded');
  });

  it('hands Approve back after a failure so one more click retries', async () => {
    const callTool = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue({});
    const { doc } = mount('state=ready', callTool);
    const approve = () => doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!;
    approve().click();
    await wait(20);
    expect(doc.getElementById('reviewFooter')!.getAttribute('state')).toBe('failed');
    expect(approve().disabled).toBe(false);
    approve().click();
    await wait(20);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('puts request changes first when approval is held, and records guidance with the review atomically', async () => {
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
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('orgx_widget_request_artifact_changes', {
      artifact_id: 'ART-DEMO', expected_version: 4, note: 'Cite the source studies.',
    });
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
