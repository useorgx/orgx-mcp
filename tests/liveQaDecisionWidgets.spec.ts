// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountWidget, readSharedScript, WIDGETS_DIR } from './fixtures/live';
import { installSharedFoundations } from './fixtures/sharedFoundations';

/**
 * Live QA in ChatGPT (2026-10-02, ledger items B1–B8): the decision-facing
 * widgets printed raw host payloads ("{" and {"detail":"MCP Resource not
 * found"}) as the reason a ruling was not sent, "status: unavailable" as a
 * recommendation, key:value dumps as "Why it matters", whole paragraphs as
 * headlines, a live spinner for a run nobody could check, raw codes like
 * model_budget_exhausted, and a degraded-data banner outside the card.
 *
 * widget-runtime.js rejects callTool with `{ code, message, details.raw }`:
 * tool_unavailable when the host has no such tool or resource, network when
 * the call never arrived. These tests drive the shipped widgets with exactly
 * that shape, and with the older raw shape, and read what a person would see.
 */

const D1 = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const D2 = '1c8d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e';
const D3 = '3e0f4051-6273-4d8e-9fa0-1b2c3d4e5f60';
const RUN_ID = '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99';
const RAW = '{"detail":"MCP Resource not found"}';
const LONG =
  "The OrgX floor stopped a merge action in an agent-cli session and is waiting for you. Agent's reason: please review PR #3239. Required GitHub CI did not start because the Actions budget is exhausted. Approve to let exactly this action run once in the next 24 hours.";

type Args = Record<string, unknown>;

const unavailable = () => Object.assign(new Error(RAW), { code: 'tool_unavailable', details: { raw: RAW } });
const network = () => Object.assign(new Error('Failed to fetch'), { code: 'network', details: { raw: 'TypeError: Failed to fetch' } });

function packetDecision(id: string, summary: string, packet: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    id,
    urgency: 'high',
    type: 'decision_queue',
    summary,
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    review_url: `https://useorgx.com/decisions/${id}?from=review`,
    review_packet: {
      id: `pkt-${id.slice(0, 8)}`,
      headDecisionId: id,
      question: summary,
      outcome: 'Outcome not linked',
      current: { state: 'pending', blocked: false },
      evidence: [],
      uncertainty: 'No LLM recommendation is available for this decision yet.',
      recommendation: { status: 'unavailable', action: null },
      consequences: {},
      ...packet,
    },
    ...extra,
  };
}

function plainDecision(id: string, summary: string) {
  return {
    id,
    urgency: 'high',
    agent_name: 'Eli - Engineering',
    type: 'decision_queue',
    summary,
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    recommendation: 'Go with it.',
  };
}

function ensureCssEscape() {
  const scope = window as unknown as { CSS?: { escape?: (value: string) => string } };
  if (!scope.CSS?.escape) scope.CSS = { ...(scope.CSS ?? {}), escape: (value: string) => value.replace(/["\\\]]/g, '\\$&') };
}

function mountDecisions(decisions: unknown[], tokens: Record<string, string>, decide: (args: Args) => unknown) {
  const callTool = vi.fn((name: string, args: Args) => {
    if (name === 'orgx_widget_decide') return Promise.resolve().then(() => decide(args));
    return Promise.resolve({ structuredContent: { kind: 'decision', id: args.id, state: 'succeeded', next_poll_after_ms: null } });
  });
  ensureCssEscape();
  mountWidget('decisions', { payload: { decisions }, callTool });
  (window as unknown as { openai: Record<string, unknown> }).openai.toolResponseMetadata = {
    'orgx/widgetApproval': { approval_tokens: tokens },
  };
  return callTool;
}

const decisionsFooter = () => document.querySelector('ox-footer.dq-footer') as HTMLElement | null;
const pressPrimary = (el: Element) => el.dispatchEvent(new CustomEvent('ox-primary', { bubbles: true, composed: true }));
const decideCalls = (callTool: ReturnType<typeof vi.fn>) => callTool.mock.calls.filter(([name]) => name === 'orgx_widget_decide');
/** Everything a person can read, attributes on the kit elements included. */
const visibleText = () => {
  const attrs = Array.from(document.querySelectorAll('ox-footer, ox-receipt-row, ox-state-chip'))
    .flatMap((el) => ['heading', 'detail', 'label', 'primary-label', 'action-label'].map((name) => el.getAttribute(name) ?? ''));
  return `${document.body.textContent ?? ''} ${attrs.join(' ')}`;
};
const RAW_MARKERS = [RAW, '"detail"', 'MCP Resource not found'];
const expectNoRawPayload = () => {
  const text = visibleText();
  for (const marker of RAW_MARKERS) expect(text).not.toContain(marker);
  // No lone brace standing in for a reason.
  expect(text).not.toMatch(/(^|\s)[{}](\s|$)/);
};

function withQuery(query: string) {
  window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
}

afterEach(() => {
  withQuery('');
  vi.useRealTimers();
});

describe('B1 · decisions: "Not sent" never shows a raw payload', () => {
  it('hands off to Decide in OrgX (the review URL) when the host has no decide tool, without Retry', async () => {
    const callTool = mountDecisions([plainDecision(D1, 'Rotate billing API keys?'), plainDecision(D2, 'Ship 4.2?')], { [D1]: 't1', [D2]: 't2' }, () =>
      Promise.reject(unavailable())
    );
    await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('needs-you'));
    pressPrimary(decisionsFooter()!);
    await vi.waitFor(() => expect(document.querySelector('.decide-in-orgx')).not.toBeNull());
    const handoff = document.querySelector('.decide-in-orgx')!;
    expect(handoff.querySelector('.t')!.textContent).toBe('Decide in OrgX');
    expect(handoff.querySelector('.d')!.textContent).toBe('This chat can’t settle it right now, so nothing was sent.');
    expect(decisionsFooter()).toBeNull();
    expect(visibleText()).not.toContain('Retry');
    // Nothing else offers a ruling this chat can't deliver.
    expect(document.querySelector('[data-action="approve-ready"]')).toBeNull();
    expectNoRawPayload();
    expect(decideCalls(callTool)).toHaveLength(1);
  });

  it('opens the item’s review_url from Decide in OrgX', async () => {
    mountDecisions([packetDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () => Promise.reject(unavailable()));
    await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('needs-you'));
    pressPrimary(decisionsFooter()!);
    await vi.waitFor(() => expect(document.querySelector('.decide-in-orgx')).not.toBeNull());
    expect(document.querySelector('.decide-in-orgx')!.getAttribute('href')).toBe(`https://useorgx.com/decisions/${D1}?from=review`);
  });

  it('treats the older raw host error (no code) the same way', async () => {
    mountDecisions([plainDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () => Promise.reject(new Error(RAW)));
    await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('needs-you'));
    pressPrimary(decisionsFooter()!);
    await vi.waitFor(() => expect(document.querySelector('.decide-in-orgx')).not.toBeNull());
    expectNoRawPayload();
  });

  it('keeps Retry for a network failure, in words', async () => {
    mountDecisions([plainDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () => Promise.reject(network()));
    await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('needs-you'));
    pressPrimary(decisionsFooter()!);
    await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('failed'));
    expect(decisionsFooter()!.getAttribute('heading')).toBe('Not sent');
    expect(decisionsFooter()!.getAttribute('primary-label')).toBe('Retry');
    expect(decisionsFooter()!.getAttribute('detail')).toBe('couldn’t reach OrgX · nothing changed');
  });

  it('never prints a lone brace or JSON as the detail of an unknown failure', async () => {
    for (const message of ['{', '{"error":"boom"}', '[object Object]']) {
      mountDecisions([plainDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () =>
        Promise.reject(Object.assign(new Error(message), { code: 'tool_failed' }))
      );
      await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('needs-you'));
      pressPrimary(decisionsFooter()!);
      await vi.waitFor(() => expect(decisionsFooter()?.getAttribute('state')).toBe('failed'));
      expect(decisionsFooter()!.getAttribute('detail')).toBe('nothing changed · try again');
    }
  });

  it('Approve N ready stops calling once the host says the tool is missing, and says so per item', async () => {
    const callTool = mountDecisions(
      [plainDecision(D1, LONG), plainDecision(D2, 'Ship 4.2?'), plainDecision(D3, 'Publish the checklist?')],
      { [D1]: 't1', [D2]: 't2', [D3]: 't3' },
      () => Promise.reject(unavailable())
    );
    await vi.waitFor(() => expect(document.querySelector('[data-action="approve-ready"]')).not.toBeNull());
    (document.querySelector('[data-action="approve-ready"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.dq-batch.is-result')?.getAttribute('aria-busy')).toBe('false'));
    expect(decideCalls(callTool)).toHaveLength(1);
    expect(document.querySelector('.dq-batch-copy')!.textContent).toBe('3 to decide in OrgX');
    const rows = Array.from(document.querySelectorAll('.dq-batch ox-receipt-row'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.getAttribute('detail')).toBe('This chat can’t settle it right now. Decide it in OrgX.');
      expect(row.getAttribute('href')).toMatch(/^https:\/\/useorgx\.com\//);
    }
    // The batch row names the item by its headline, not the whole paragraph.
    expect(rows[0]!.getAttribute('label')).toBe('The OrgX floor stopped a merge action in an agent-cli session and is waiting for you.');
    expectNoRawPayload();
  });
});

describe('B2 · decisions: no "status: unavailable", and the OrgX mark renders', () => {
  it('says "No recommendation yet" quietly and draws the OrgX mark inline', async () => {
    mountDecisions([packetDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.dq-rec')).not.toBeNull());
    const rec = document.querySelector('.dq-rec')!;
    expect(rec.classList.contains('is-quiet')).toBe(true);
    expect(rec.textContent).toContain('No recommendation yet');
    expect(visibleText()).not.toMatch(/status:\s*unavailable/i);
    expect(visibleText()).not.toContain('recommends');
    // The kit avatar draws the OrgX mark (never an empty circle) at the inline size (28 px).
    const avatar = rec.querySelector('.agent-avatar--system ox-avatar')!;
    expect(avatar.getAttribute('agent')).toBe('system');
    expect(avatar.getAttribute('size')).toBe('inline');
    expect(rec.querySelector('img')).toBeNull();
  });

  it('keeps a real packet recommendation and marks an unverified one', async () => {
    mountDecisions(
      [packetDecision(D1, 'Rotate billing API keys?', { recommendation: { status: 'unverified', action: 'Rotate tonight', rationale: 'Keys are 212 days old.' } })],
      { [D1]: 't1' },
      () => ({})
    );
    await vi.waitFor(() => expect(document.querySelector('.dq-why')).not.toBeNull());
    expect(document.querySelector('.dq-why')!.textContent).toBe('Rotate tonight. Keys are 212 days old.');
    expect(document.querySelector('.dq-rec')!.textContent).toContain('unverified');
  });
});

describe('B3 · decisions: "Evidence and consequence" in sentences', () => {
  it('drops booleans and empty unknowns instead of dumping key: value', async () => {
    mountDecisions([packetDecision(D1, 'Rotate billing API keys?')], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.decision-evidence')).not.toBeNull());
    const body = document.querySelector('.decision-evidence__body')!.textContent ?? '';
    for (const leak of ['outcome:', 'current:', 'state:', 'blocked:', 'uncertainty:', 'false', 'Outcome not linked', 'No LLM recommendation']) {
      expect(body).not.toContain(leak);
    }
    // Nothing left to say about why: the section is omitted, not printed empty.
    expect(document.querySelector('.decision-evidence__item')).toBeNull();
  });

  it('writes what the packet does know as short sentences', async () => {
    mountDecisions(
      [
        packetDecision(D1, 'Rotate billing API keys?', {
          outcome: 'Billing hardening',
          current: { state: 'in_progress', blocked: true },
          uncertainty: 'Partner sandbox keys may still be shared with the reseller.',
        }),
      ],
      { [D1]: 't1' },
      () => ({})
    );
    await vi.waitFor(() => expect(document.querySelector('.decision-evidence__copy')).not.toBeNull());
    const lines = Array.from(document.querySelectorAll('.decision-evidence__copy p'), (p) => p.textContent);
    expect(lines).toEqual([
      'It serves this outcome: Billing hardening.',
      'It is in progress right now.',
      'It is blocking work until you decide.',
      'Still uncertain: Partner sandbox keys may still be shared with the reseller.',
    ]);
  });
});

describe('B4 · short headlines', () => {
  it('decisions: the first sentence is the headline and the rest is structured body text', async () => {
    mountDecisions([packetDecision(D1, LONG)], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.dq-q')).not.toBeNull());
    expect(document.querySelector('.dq-q')!.textContent).toBe('The OrgX floor stopped a merge action in an agent-cli session and is waiting for you.');
    // No wall of text: the labelled reason is a fact, the rest a short lede, and what
    // approving does goes to "If approved".
    expect(document.querySelector('.dq-facts dt')!.textContent).toBe("Agent's reason");
    expect(document.querySelector('.dq-facts dd')!.textContent).toBe('Please review PR #3239.');
    expect(document.querySelector('.dq-lede')!.textContent).toBe('Required GitHub CI did not start because the Actions budget is exhausted.');
    expect(document.querySelector('.dq-cons .v')!.textContent).toBe('Let exactly this action run once in the next 24 hours.');
    expect(document.querySelector('.dq-detail')!.textContent).not.toContain('Approve to let');
  });

  it('decisions: a command is set as code and a URL is a link', async () => {
    const text = 'Merge PR #3239 once CI is green? Command: gh pr merge 3239 --squash. See https://github.com/useorgx/orgx/pull/3239 for the diff. Recommendation: approve once the Actions budget resets.';
    mountDecisions([{ ...plainDecision(D1, text), recommendation: undefined }], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.dq-q')).not.toBeNull());
    expect(document.querySelector('.dq-q')!.textContent).toBe('Merge PR #3239 once CI is green?');
    expect(document.querySelector('.dq-cmd pre code')!.textContent).toBe('gh pr merge 3239 --squash');
    const link = document.querySelector('.dq-detail a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/useorgx/orgx/pull/3239');
    expect(link.textContent).toBe('github.com/useorgx/orgx/pull/3239');
    // A stated recommendation fills the recommendation line, not the body.
    expect(document.querySelector('.dq-why')!.textContent).toBe('Approve once the Actions budget resets.');
  });

  it('decisions: a title field wins over the first sentence', async () => {
    mountDecisions([{ ...plainDecision(D1, LONG), title: 'Allow one merge of PR #3239' }], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.dq-q')).not.toBeNull());
    expect(document.querySelector('.dq-q')!.textContent).toBe('Allow one merge of PR #3239');
    expect(document.querySelector('.dq-detail')!.textContent).toContain('The OrgX floor stopped a merge action in an agent-cli session and is waiting for you.');
  });

  it('decisions: a long first sentence splits at its label, never into "…" plus an orphan', async () => {
    const run = 'Production verification of MCP PR #424: admission, privacy and plan compatibility changes are deployed as f9c40d233e4e13809d9f901b005fe3410b37a4b0. A green deployment alone does not approve marketing.';
    mountDecisions([plainDecision(D1, run)], { [D1]: 't1' }, () => ({}));
    await vi.waitFor(() => expect(document.querySelector('.dq-q')).not.toBeNull());
    const head = document.querySelector('.dq-q')!.textContent!;
    const body = document.querySelector('.dq-detail')!.textContent!;
    expect(head).toBe('Production verification of MCP PR #424');
    expect(head).not.toContain('…');
    expect(body.startsWith('…')).toBe(false);
    expect(body).toContain('Admission, privacy and plan compatibility changes are deployed as');
    // The hash is code, shortened, with the full value in its title.
    expect(document.querySelector('.dq-detail code[title="f9c40d233e4e13809d9f901b005fe3410b37a4b0"]')).not.toBeNull();
    expect(body).toContain('A green deployment alone does not approve marketing.');
  });

  it('decisions: a fallback decision_record scope is said approximately, never as an exact or capped count', async () => {
    ensureCssEscape();
    mountWidget('decisions', {
      payload: {
        decisions: [plainDecision(D1, 'Ship the pricing page?')],
        total_pending: 25,
        pending_decisions_scope: { level: 'workspace', workspace_id: 'w', initiative_id: null, kinds: ['decision'], urgency: 'all', includes_system: true, unit: 'decision_record', total: 25, capped: true },
      },
      callTool: vi.fn(() => Promise.resolve({})),
    });
    await vi.waitFor(() => expect(document.querySelector('#dqAttention')).not.toBeNull());
    const sentence = document.querySelector('#dqAttention > span:not([slot])')!.cloneNode(true) as HTMLElement;
    sentence.querySelectorAll('.dq-narrow').forEach((el) => el.remove());
    expect(sentence.textContent).toBe('1 here · about 25 across the workspace');
    expect(document.body.textContent).not.toContain('25+');
    expect(document.querySelector('.dq-more')!.textContent).toContain('About 24 more across the workspace in OrgX');
  });

  it('decisions: the header counts pending decisions in their scope', async () => {
    ensureCssEscape();
    mountWidget('decisions', {
      payload: {
        decisions: [plainDecision(D1, 'Ship the pricing page?')],
        total_pending: 25,
        pending_decisions_scope: { level: 'workspace', workspace_id: 'w', initiative_id: null, kinds: ['decision'], urgency: 'all', includes_system: false, unit: 'review_packet', total: 25, capped: false },
      },
      callTool: vi.fn(() => Promise.resolve({})),
    });
    await vi.waitFor(() => expect(document.querySelector('#dqAttention')).not.toBeNull());
    // The wide sentence, and its phone form (one line at 375 next to the "OrgX ↗" link).
    const sentence = document.querySelector('#dqAttention > span:not([slot])')!;
    const variant = (hide: string) => {
      const copy = sentence.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(hide).forEach((el) => el.remove());
      return copy.textContent;
    };
    expect(variant('.dq-narrow')).toBe('1 here · 25 across the workspace');
    expect(variant('.dq-wide')).toBe('1 here · 25 in workspace');
    expect(document.querySelector('.dq-more')!.textContent).toContain('24 more across the workspace in OrgX');
  });

  it('decisions: the headline is clamped to about three lines in CSS, never cut in the text', () => {
    const html = readFileSync(join(WIDGETS_DIR, 'decisions.html'), 'utf8');
    expect(html).toMatch(/\.dq-q \{[\s\S]*?-webkit-line-clamp: 3;/);
    expect(html).toContain('Show the whole request');
    expect(html).not.toMatch(/rest = '…'/);
  });

  it('panel: the packet headline is the first sentence with the rest as body text', async () => {
    withQuery('gallery=true&state=no-recommendation');
    mountPanel();
    await vi.waitFor(() => expect(document.querySelector('#pk-q')).not.toBeNull());
    expect(document.querySelector('#pk-q')!.textContent).toBe('The OrgX floor stopped a merge action in an agent-cli session and is waiting for you.');
    // The rest is structured: the labelled reason is a fact, the remainder a short lede.
    expect(document.querySelector('.fact dt')!.textContent).toBe('Agent’s reason');
    expect(document.querySelector('.q-body')!.textContent).toMatch(/^Required GitHub CI did not start/);
    // B2 in the panel: a recommendation OrgX couldn't make is said quietly.
    expect(document.querySelector('.fact dd.quiet')!.textContent).toBe('No recommendation yet');
    expect(document.body.textContent).not.toMatch(/status:\s*unavailable/i);
  });

  it('morning brief: a priority is a scannable row — the title, one line of why', async () => {
    mountBrief({
      generated_at: new Date().toISOString(),
      summary: 'One priority.',
      top_priorities: [{ domain: 'Engineering', title: LONG, reason: 'Blocks the release.' }],
    });
    await vi.waitFor(() => expect(document.querySelector('.priority-title')).not.toBeNull());
    const title = document.querySelector('.priority-title')!;
    expect(title.textContent).toBe('The OrgX floor stopped a merge action in an agent-cli session and is waiting for you.');
    // The whole text stays reachable; the row never grows a paragraph under the title.
    expect(title.getAttribute('title')).toBe(LONG);
    expect(document.querySelector('.priority-more')).toBeNull();
    expect(document.querySelector('.priority-note')!.textContent).toBe('Blocks the release.');
  });
});

function mountPanel(callTool: (...args: unknown[]) => unknown = () => Promise.resolve({})) {
  ensureCssEscape();
  window.eval(readSharedScript('openai-extensions.js'));
  window.eval(readSharedScript('interaction-kit.js'));
  mountWidget('orgx-panel', { callTool });
  // Gallery fixtures run on the standalone protocol; route the panel's calls to the stub.
  (window as unknown as { OrgXWidgetRuntime: { callTool: unknown } }).OrgXWidgetRuntime.callTool = callTool;
}

describe('B1 · panel: "Not sent" never shows a raw payload', () => {
  it('hands every item to Decide in OrgX when the host has no decide tool', async () => {
    withQuery('gallery=true&state=needs-you');
    const callTool = vi.fn((name: string) => (name === 'orgx_widget_decide' ? Promise.reject(unavailable()) : Promise.resolve({})));
    mountPanel(callTool);
    await vi.waitFor(() => expect(document.querySelector('ox-footer[data-id]')).not.toBeNull());
    pressPrimary(document.querySelector('ox-footer[data-id]')!);
    await vi.waitFor(() => expect(document.querySelector('.primary-btn')).not.toBeNull());
    expect(document.querySelector('.primary-btn')!.textContent).toContain('Decide in OrgX');
    expect(document.querySelector('.handoff-detail')!.textContent).toBe('This chat can’t settle it right now, so nothing was sent.');
    // The other rows lose their Approve too: nothing loops back into the same failure.
    expect(document.querySelector('.mini.approve')).toBeNull();
    expect(document.querySelector('.error-line')).toBeNull();
    expectNoRawPayload();
    expect(callTool.mock.calls.filter(([name]) => name === 'orgx_widget_decide')).toHaveLength(1);
  });

  it('says a network failure in words', async () => {
    withQuery('gallery=true&state=needs-you');
    mountPanel((name: unknown) => (name === 'orgx_widget_decide' ? Promise.reject(network()) : Promise.resolve({})));
    await vi.waitFor(() => expect(document.querySelector('ox-footer[data-id]')).not.toBeNull());
    pressPrimary(document.querySelector('ox-footer[data-id]')!);
    await vi.waitFor(() => expect(document.querySelector('.error-line')).not.toBeNull());
    expect(document.querySelector('.error-line')!.textContent).toBe('Couldn’t reach OrgX. Nothing changed; try again.');
  });

  it('never prints JSON from an unknown failure', async () => {
    withQuery('gallery=true&state=needs-you');
    mountPanel((name: unknown) =>
      name === 'orgx_widget_decide' ? Promise.reject(Object.assign(new Error('{'), { code: 'tool_failed' })) : Promise.resolve({})
    );
    await vi.waitFor(() => expect(document.querySelector('ox-footer[data-id]')).not.toBeNull());
    pressPrimary(document.querySelector('ox-footer[data-id]')!);
    await vi.waitFor(() => expect(document.querySelector('.error-line')).not.toBeNull());
    expect(document.querySelector('.error-line')!.textContent).toBe('Not recorded. Nothing changed; try again.');
    expectNoRawPayload();
  });
});

describe('B5 · one focus ring, keyboard only', () => {
  const theme = readFileSync(join(WIDGETS_DIR, 'shared', 'widget-theme.css'), 'utf8');
  const kitCss = readFileSync(join(WIDGETS_DIR, 'shared', 'interaction-kit.css'), 'utf8');

  it('defines the ring as the kit lime in every theme, never from the accent', () => {
    expect(theme).toContain('--ox-focus-color: #4d7c0f;');
    expect(theme.match(/--ox-focus-color: rgba\(191, 255, 0, 0\.8\);/g)).toHaveLength(2);
    expect(theme).not.toMatch(/--ox-focus[\w-]*:\s*rgba\(var\(--ox-primary-rgb\)/);
  });

  it('enforces one ring colour on every :focus-visible and hides it after a pointer press', () => {
    expect(theme).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--ox-focus\);\s*outline-offset: 2px;\s*\}/);
    expect(theme).toMatch(/:focus-visible,[\s\S]*?\{\s*outline-color: var\(--ox-focus\) !important;\s*\}/);
    expect(theme).toMatch(/:focus:not\(:focus-visible\) \{\s*outline: none;\s*\}/);
    expect(theme).toMatch(/:root\[data-ox-input="pointer"\] \{\s*--ox-focus: transparent;\s*\}/);
    // Text fields keep their ring after a click.
    expect(theme).toMatch(/:root\[data-ox-input="pointer"\] :is\(input, textarea, select, \[contenteditable\]\):focus-visible/);
  });

  it('draws kit buttons with the same outline ring, not an accent halo', () => {
    expect(kitCss).toMatch(/\.ox-icon-btn:focus-visible \{\s*outline: 2px solid var\(--ox-focus/);
    expect(kitCss).not.toMatch(/0 0 0 3px var\(\s*--ox-focus-ring/);
  });

  it('never paints a ring from a widget accent in any widget or shared sheet', () => {
    const sheets = [
      ...['decisions', 'orgx-panel', 'morning-brief', 'artifact-review', 'task-spawned', 'index'].map((name) => `${name}.html`),
      'shared/components.css',
      'shared/tokens.css',
      'shared/components/domain-accent.css',
    ];
    for (const sheet of sheets) {
      const css = readFileSync(join(WIDGETS_DIR, sheet), 'utf8');
      const rings = css.match(/outline:[^;]*;/g) ?? [];
      for (const ring of rings) {
        expect(ring, sheet).not.toMatch(/primary|domain-rgb|--ox-teal|--ox-iris/);
      }
    }
  });

  it('records the last input on <html> so a pointer press hides the ring and a key brings it back', () => {
    window.eval(readSharedScript('interaction-kit.js'));
    const root = document.documentElement;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.getAttribute('data-ox-input')).toBe('pointer');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root.getAttribute('data-ox-input')).toBe('keyboard');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
    expect(root.getAttribute('data-ox-input')).toBe('pointer');
  });

  it('keeps announcements for screen readers only', () => {
    expect(kitCss).toMatch(/\[data-orgx-live-region\] \{[\s\S]*?clip-path: inset\(50%\);/);
  });
});

describe('B6 · task-spawned: honest last-known state', () => {
  const payload = { _action: 'spawn', title: 'Run the QA pass', agent_name: 'Eli', run_id: RUN_ID, status: 'in_progress' };

  it('stops polling when the host has no status tool and shows last known, with no live spinner', async () => {
    const callTool = vi.fn().mockRejectedValue(unavailable());
    mountWidget('task-spawned', { payload, callTool });
    await vi.waitFor(() => expect(document.querySelector('ox-footer')?.getAttribute('heading')).toBe('Couldn’t check just now'));
    const footer = document.querySelector('ox-footer')!;
    expect(footer.getAttribute('state')).toBe('stale');
    expect(footer.getAttribute('variant')).toBe('reads');
    expect(footer.getAttribute('detail')).toBe('showing the last report');
    const chip = document.querySelector('ox-state-chip')!;
    expect(chip.getAttribute('state')).toBe('stale');
    expect(chip.getAttribute('label')).toBe('Last known: running');
    expect(document.querySelector('.wcard')!.getAttribute('data-edge')).toBe('mute');
    expect(visibleText()).not.toContain('is running');
    expect(visibleText()).not.toContain('Sync time unavailable');
    expect(document.querySelector('ox-receipt-row')!.getAttribute('status')).toBe('unverified');
    expectNoRawPayload();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('shows failed with the reason in words when the poll says failed', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { kind: 'run', id: RUN_ID, state: 'failed', outcome: 'model_budget_exhausted', next_poll_after_ms: null },
    });
    mountWidget('task-spawned', { payload, callTool });
    await vi.waitFor(() => expect(document.querySelector('ox-footer')?.getAttribute('state')).toBe('failed'));
    expect(document.querySelector('ox-footer')!.getAttribute('heading')).toBe('Run failed');
    expect(document.querySelector('.note')!.textContent).toBe('The run stopped: the model budget ran out.');
    expect(document.querySelector('ox-state-chip')!.getAttribute('state')).toBe('failed_step');
    expect(visibleText()).not.toContain('model_budget_exhausted');
  });

  it('turns an unknown outcome code into words', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { kind: 'run', id: RUN_ID, state: 'failed', outcome: 'sandbox_image_pull_failed', next_poll_after_ms: null },
    });
    mountWidget('task-spawned', { payload, callTool });
    await vi.waitFor(() => expect(document.querySelector('.note')?.textContent).toBe('The run stopped: sandbox image pull failed.'));
  });
});

describe('B7 · artifact-review: codes read as words', () => {
  const html = readFileSync(join(WIDGETS_DIR, 'artifact-review.html'), 'utf8');
  const script =
    Array.from(new JSDOM(html).window.document.querySelectorAll('script')).find((node) => node.textContent?.includes('buildQualityAnatomy'))
      ?.textContent ?? '';

  it('humanizes the title, summary and preview of a blocker artifact', () => {
    const dom = new JSDOM(html, { url: 'https://example.test/widgets/artifact-review.html?state=blocker', runScripts: 'outside-only', pretendToBeVisual: true });
    installSharedFoundations(dom.window);
    Object.defineProperty(dom.window, 'OrgXWidgetRuntime', {
      configurable: true,
      value: { detectProtocol: () => 'standalone', reportSize: vi.fn(), callTool: vi.fn(), openWidgetLink: vi.fn(), initWidget: vi.fn() },
    });
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    const doc = dom.window.document;
    const header = doc.querySelector('.hd .src')!.textContent!;
    const summary = doc.querySelector('.review-summary')!.textContent!;
    const preview = doc.querySelector('[data-preview-body]')!.textContent!;
    expect(header).toContain('Model call stopped: the model budget ran out');
    expect(summary).toBe('Model call stopped: the model budget ran out');
    expect(preview).toContain('Model call stopped: the model budget ran out');
    // An unknown code becomes words too, never snake_case.
    expect(preview).toContain('The run hit the provider rate limit twice');
    for (const text of [header, summary, preview]) expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });
});

function mountBrief(payload: Record<string, unknown>) {
  window.eval(readSharedScript('orgx-icons.js'));
  mountWidget('morning-brief', { payload });
}

describe('B8 · morning brief: one degraded notice, inside the card', () => {
  it('names the missing source inside the card and adds no banner above it', async () => {
    mountBrief({
      generated_at: new Date().toISOString(),
      summary: 'Two decisions wait on you.',
      degraded: ['workspace_pulse_unavailable'],
      degraded_reason: 'value_dashboard_timeout',
      pending_decisions: 2,
    });
    await vi.waitFor(() => expect(document.querySelector('.brief-partial')).not.toBeNull());
    expect(document.getElementById('orgx-data-availability')).toBeNull();
    expect(document.querySelector('.ox-card .brief-partial')).not.toBeNull();
    expect(document.querySelector('.brief-partial')!.textContent).toBe(
      'Partial brief. Couldn’t load the workspace pulse and value numbers for this brief. Counts may be low until the next refresh.'
    );
    const footer = document.querySelector('ox-footer.brief-footer')!;
    expect(footer.getAttribute('heading')).not.toBe('Partial brief');
    expect(footer.getAttribute('detail')).not.toContain('refreshing');
    expect(visibleText().match(/partial/gi)).toHaveLength(1);
  });

  it('says a fallback decision_record count approximately', async () => {
    mountBrief({
      generated_at: new Date().toISOString(),
      pending_decisions: 25,
      pending_decisions_scope: { level: 'workspace', workspace_id: 'w', initiative_id: null, kinds: ['decision'], urgency: 'all', includes_system: true, unit: 'decision_record', total: 25, capped: true },
    });
    await vi.waitFor(() => expect(document.querySelector('.app-action-card-title')).not.toBeNull());
    expect(document.querySelector('.app-action-card-title')!.textContent).toBe('About 25 decisions across the workspace need you');
    expect(document.body.textContent).toContain('Count may include duplicates');
    expect(document.body.textContent).not.toContain('25+');
  });

  it('names each source degraded_sources lists, and drops a status line posing as a summary', async () => {
    mountBrief({
      generated_at: new Date().toISOString(),
      message: 'Morning brief ready',
      pending_decisions: 25,
      pending_decisions_scope: { level: 'workspace', workspace_id: 'w', initiative_id: null, kinds: ['decision'], urgency: 'all', includes_system: false, unit: 'review_packet', total: 25, capped: false },
      degraded: ['operator_chronicle_unavailable'],
      degraded_sources: [
        { source: 'pending_decision_count', label: 'Pending decision count', reason: 'query_failed' },
        { source: 'operator_chronicle', label: 'Operator chronicle', reason: 'unavailable' },
      ],
    });
    await vi.waitFor(() => expect(document.querySelector('.brief-partial')).not.toBeNull());
    expect(document.querySelector('.brief-partial')!.textContent).toBe(
      'Partial brief. Couldn’t load the pending decision count and the operator chronicle for this brief. Counts may be low until the next refresh.'
    );
    expect(document.querySelector('.brief-summary')).toBeNull();
    expect(document.querySelector('.app-action-card-title')!.textContent).toBe('25 decisions across the workspace need you');
    // Empty sections are not offered: no "Output –", no "Receipts $0.00".
    expect(document.querySelector('#section-output')).toBeNull();
    expect(document.querySelector('#section-receipts')).toBeNull();
    expect(visibleText()).not.toMatch(/\$0\.00|–\s*$/m);
  });

  it('counts receipts instead of showing $0.00 when they carry no value', async () => {
    mountBrief({
      generated_at: new Date().toISOString(),
      summary: 'Quiet night.',
      top_receipts: [{ intent: 'Closed QA loop', attributed_value_usd: 0 }, { intent: 'Fixed routing', attributed_value_usd: 0 }],
    });
    await vi.waitFor(() => expect(document.querySelector('#section-receipts')).not.toBeNull());
    expect(document.querySelector('#section-receipts .app-accordion-trigger-badge')!.textContent).toBe('2');
    expect(document.querySelector('#section-receipts')!.innerHTML).not.toContain('$0');
  });

  it('says some sources are missing when the payload does not name one', async () => {
    mountBrief({ generated_at: new Date().toISOString(), summary: 'Quiet night.', degraded: true });
    await vi.waitFor(() => expect(document.querySelector('.brief-partial')).not.toBeNull());
    expect(document.querySelector('.brief-partial')!.textContent).toBe(
      'Partial brief. Some sources didn’t load for this brief. Counts may be low until the next refresh.'
    );
  });
});
