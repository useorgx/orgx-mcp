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

function mount(query: string, callTool = vi.fn().mockImplementation((name: string, args: { artifact_id: string }) => Promise.resolve({ structuredContent: { ok: true, artifact: { id: args.artifact_id, status: name === 'orgx_widget_approve_artifact' ? 'approved' : 'changes_requested' } } })), protocol = 'standalone', tokens: Record<string, string> = {}) {
  const dom = new JSDOM(widgetHtml, {
    url: `https://example.test/widgets/artifact-review.html?${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  installSharedFoundations(dom.window);
  const initWidget = vi.fn();
  Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
    configurable: true,
    value: {
      detectProtocol: () => protocol,
      reportSize: vi.fn(),
      callTool,
      openWidgetLink: vi.fn(),
      initWidget,
      getToolResponseMetadata: (key: string) => key === 'orgx/artifactReview' ? { approval_tokens: tokens } : null,
    },
  });
  dom.window.eval(scriptSource);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { dom, doc: dom.window.document, callTool, renderIncoming: (payload: unknown) => initWidget.mock.calls[0][0].render(payload) };
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
    expect(doc.querySelector('.review-question')!.textContent).toBe('Approval recorded');
  });

  it('offers the OrgX review link when the host result grants no human review token', () => {
    const { doc, callTool } = mount('state=ready', vi.fn(), 'chatgpt');
    expect(doc.querySelector('[data-action="approve"]')).toBeNull();
    expect(doc.querySelector('[data-action="request-changes"]')).toBeNull();
    expect(doc.querySelector('#handoffFooter')!.getAttribute('action-label')).toBe('Open in OrgX ↗');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('records a valid acknowledgment for the current host artifact using its hidden capability', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { ok: true, artifact: { id, status: 'approved' } } });
    const { doc, renderIncoming } = mount('', callTool, 'chatgpt', { [id]: 'hidden-review-token' });
    renderIncoming({ artifact: { id, name: 'The current review', version: 3, status: 'in_review', artifact_type: 'document' } });
    doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    await wait(20);
    expect(callTool).toHaveBeenCalledExactlyOnceWith('orgx_widget_approve_artifact', { artifact_id: id, expected_version: 3, approval_token: 'hidden-review-token' });
    expect(doc.querySelector('.review-question')!.textContent).toBe('Approval recorded');
  });

  it('keeps the review open when the server only acknowledges the request', async () => {
    const { doc } = mount('state=ready', vi.fn().mockResolvedValue({ structuredContent: { ok: true, review_status: 'pending' } }));
    doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    await wait(20);
    expect(doc.getElementById('reviewFooter')!.getAttribute('state')).toBe('failed');
    expect(doc.querySelector('.review-question')!.textContent).not.toBe('Approval recorded');
  });

  it.each([
    { ok: true, artifact: { id: 'ART-OTHER', status: 'approved' } },
    { ok: true, artifact: { status: 'approved' } },
    { ok: true, artifact: { id: 'ART-DEMO' }, review_status: 'approved' },
    { artifact: { id: 'ART-DEMO', status: 'approved' } },
  ])('keeps the displayed review open for an unconfirmed or different artifact acknowledgment: %j', async (acknowledgment) => {
    const { doc, callTool } = mount('state=ready', vi.fn().mockResolvedValue({ structuredContent: acknowledgment }));
    doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    await wait(20);
    expect(doc.getElementById('reviewFooter')!.getAttribute('state')).toBe('failed');
    expect(doc.querySelector('[data-stage]')!.textContent).not.toContain('Approval recorded');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it.each(['awaiting acknowledgment', 'playing the exit animation'])('does not paint an older approval over a newer host artifact while %s', async (phase) => {
    let acknowledge!: (value: unknown) => void;
    const callTool = vi.fn(() => new Promise((resolve) => { acknowledge = resolve; }));
    const id = '11111111-1111-4111-8111-111111111111';
    const { dom, doc, renderIncoming } = mount('', callTool, 'chatgpt', { [id]: 'hidden-review-token' });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn() });
    const artifact = (version: number) => ({ artifact: { id, name: `Review version ${version}`, version, status: 'in_review', artifact_type: 'document' } });
    renderIncoming(artifact(1));
    doc.querySelector<HTMLButtonElement>('[data-action="approve"]')!.click();
    expect(callTool).toHaveBeenCalledWith('orgx_widget_approve_artifact', { artifact_id: id, expected_version: 1, approval_token: 'hidden-review-token' });
    if (phase === 'playing the exit animation') {
      acknowledge({ structuredContent: { ok: true, artifact: { id, status: 'approved' } } });
      await wait(20);
      expect(doc.querySelector('[data-stage]')?.classList.contains('is-resolving')).toBe(true);
    }
    renderIncoming(artifact(2));
    if (phase === 'awaiting acknowledgment') acknowledge({ structuredContent: { ok: true, artifact: { id, status: 'approved' } } });
    await wait(400);
    expect(doc.querySelector('[data-stage]')!.textContent).toContain('Review version 2');
    expect(doc.querySelector('[data-stage]')!.textContent).not.toContain('Approval recorded');
    expect(callTool).toHaveBeenCalledTimes(1);
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
