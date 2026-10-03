// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mountWidget, readSharedScript, WIDGETS_DIR } from './fixtures/live';

/**
 * Base styling every widget must inherit, and the copy it must not show.
 *
 * Three widgets shipped without a base font or reset — entity-card,
 * work-ledger and workspace-map. They rendered in the browser's default serif
 * and, keeping the default 8px body margin with content-box sizing, scrolled
 * sideways by exactly 16px at phone width. Neither failure looks like "a
 * stylesheet is missing"; they look like the widget is broken, which is why
 * they reached production.
 *
 * The fix lives in shared/widget-theme.css, which the MCP serving layer inlines
 * into every widget document. These tests hold that arrangement in place.
 */

const THEME = readFileSync(
  join(WIDGETS_DIR, 'shared', 'widget-theme.css'),
  'utf8'
);

const WIDGETS = readdirSync(WIDGETS_DIR)
  .filter((name) => name.endsWith('.html'))
  .map((name) => name.replace(/\.html$/, ''));

describe('the shared theme carries the base reset', () => {
  it('sets a body font, so nothing falls back to the browser serif', () => {
    expect(THEME).toMatch(/body\s*\{[^}]*font-family:/s);
  });

  it('sets border-box and clears the default body margin', () => {
    // The 8px default margin is exactly the 16px of horizontal overflow those
    // widgets showed at phone width.
    expect(THEME).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box/s);
    expect(THEME).toMatch(/body\s*\{\s*margin:\s*0/s);
  });
});

describe('every widget receives the base reset', () => {
  it.each(WIDGETS)('%s links the shared theme', (name) => {
    // The reset only reaches a widget that references the file; the serving
    // layer inlines by replacing that reference, so a widget without one gets
    // nothing.
    const html = readFileSync(join(WIDGETS_DIR, `${name}.html`), 'utf8');
    expect(html).toMatch(/href=["'][^"']*shared\/widget-theme\.css/);
  });
});

describe('work-ledger survives untidy production data', () => {
  const MESSY = {
    chronicle: {
      workspaceName: 'OrgX Business',
      period: 'week',
      headline: '57 items need a decision or unblock',
      metrics: { receiptsProduced: 7, decisionsResolved: 2, artifactsProduced: 72, prReceipts: 59 },
      continuity: {
        clients: [
          { label: 'Claude Code', evidenceLabel: 'Verified work', sessions: 80, artifacts: 0, decisions: 0, pullRequests: 0 },
          { label: 'OrgX', evidenceLabel: 'Verified work', sessions: 0, artifacts: 13, decisions: 17, pullRequests: 0 },
        ],
        events: [
          { kind: 'report', title: 'Reporting · codex', sourceLabel: 'Codex', occurredAt: '2026-09-28' },
          { kind: 'report', title: 'Reporting · codex', sourceLabel: 'Codex', occurredAt: '2026-09-28' },
          { kind: 'report', title: 'Reporting · codex', sourceLabel: 'Codex', occurredAt: '2026-09-28' },
          { kind: 'report', title: 'Reporting · codex', sourceLabel: 'Codex', occurredAt: '2026-09-28' },
        ],
      },
      flywheel: { summary: ['Build: 59 merged PRs'] },
    },
  };

  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('omits the counts a client does not have', () => {
    // Every row used to print all three, so "80 sessions · 0 artifacts · 0
    // decisions" made the reader filter zeros to find the one real number.
    mountWidget('work-ledger', { payload: MESSY });
    // Assert on the client rows, and with a word boundary: a plain substring
    // check for "0 sessions" also matches the tail of "80 sessions".
    // Client rows are <ox-receipt-row>s: the name is the label, the counts and
    // evidence tier are the detail line.
    const rows = Array.from(document.querySelectorAll('ox-receipt-row.wl-client')).map(
      (el) => `${el.getAttribute('label')} ${el.getAttribute('detail')}`.replace(/\s+/g, ' ')
    );
    const clientRows = rows.filter((row) => /Claude Code|OrgX/.test(row));
    expect(clientRows.some((row) => row.includes('80 sessions'))).toBe(true);
    expect(clientRows.some((row) => row.includes('13 artifacts'))).toBe(true);
    for (const row of clientRows) {
      expect(row, row).not.toMatch(/\b0 (sessions|artifacts|decisions|PRs)\b/);
    }
  });

  it('collapses a repeated entry into one row with its count', () => {
    mountWidget('work-ledger', { payload: MESSY });
    const entries = Array.from(document.querySelectorAll('ox-receipt-row.wl-entry')).map(
      (el) => el.getAttribute('label') ?? ''
    );
    const reporting = entries.filter((t) => t.includes('Reporting'));
    expect(reporting).toHaveLength(1);
    expect(reporting[0]).toContain('×4');
  });

  it('labels the metrics as windowed, so they do not contradict the headline', () => {
    // The headline is a standing backlog ("57 items need a decision") and the
    // metrics are what happened in the window. Unlabelled and adjacent, "57"
    // over "Decisions 2" reads as a contradiction.
    mountWidget('work-ledger', { payload: MESSY });
    expect(document.body.textContent).toContain('Produced in this window');
  });

  it('marks a verified client differently from an observed one', () => {
    mountWidget('work-ledger', { payload: MESSY });
    const tiers = Array.from(document.querySelectorAll('.wl-client[data-tier]')).map((el) =>
      el.getAttribute('data-tier')
    );
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers).toContain('verified');
  });
});

describe('empty states speak to the person, not the tool caller', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('entity-card does not print tool-calling instructions at the reader', () => {
    // It used to say "Call orgx_inspect with a type and id from orgx_search",
    // which is a note to an agent shown to a human.
    mountWidget('entity-card', { payload: {} });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Nothing to show here');
    expect(text).not.toContain('orgx_inspect');
    expect(text).not.toContain('orgx_search');
  });
});

describe('workspace-map describes surfaces without naming tools', () => {
  // orgx_bootstrap is the first call of a session, and workspace-map is its
  // widget — so this is the first thing a person sees. It used to render the
  // payload's routing arrays verbatim ("Read orgx_recommend orgx_tail",
  // "Change orgx_act") and a "Start with" footer of tool ids. Those are for the
  // model, which reads them from structuredContent either way.
  const PAYLOAD = {
    profile: 'v2',
    visible_tools_count: 21,
    granted_scopes: ['entities:read'],
    workspace: { id: 'ws-1', name: 'Atina Labs' },
    safe_first_calls: [{ tool: 'orgx_recommend', args: {} }],
    surfaces: [
      {
        id: 'command',
        name: 'Command',
        url: 'https://useorgx.com/command',
        purpose: 'What needs you now.',
        read: ['orgx_recommend', 'orgx_tail'],
        control: ['orgx_act'],
      },
      {
        id: 'quality',
        name: 'Quality Studio',
        url: 'https://useorgx.com/settings/quality',
        purpose: 'The checks an artifact must pass.',
        read: ['orgx_inspect'],
        control: [],
      },
      {
        id: 'execution',
        name: 'Execution',
        url: 'https://useorgx.com/settings/execution',
        purpose: 'Route priority and spend limits.',
        read: [],
        control: [],
      },
    ],
  };

  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('prints no tool id anywhere in the rendered map', () => {
    mountWidget('workspace-map', { payload: PAYLOAD });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Atina Labs');
    expect(text).not.toMatch(/orgx_[a-z_]+/);
    expect(text).not.toMatch(/get_[a-z_]+/);
  });

  it('marks only the surfaces this session is limited on', () => {
    mountWidget('workspace-map', { payload: PAYLOAD });
    const cards = Array.from(document.querySelectorAll('.wm-surface'));
    expect(cards).toHaveLength(3);
    const note = (card: Element) =>
      card.querySelector('.wm-tools')?.textContent ?? null;
    // Command has both read and control: full access needs no caveat, and a
    // line repeated on every card is one the eye skips.
    expect(note(cards[0]!)).toBeNull();
    expect(note(cards[1]!)).toContain('Read-only here');
    expect(note(cards[2]!)).toContain('Only in OrgX');
  });

  it('asks an unbound session to sign in rather than to call a tool', () => {
    mountWidget('workspace-map', { payload: { surfaces: [] } });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Sign in to an OrgX workspace');
    expect(text).not.toContain('orgx_bootstrap');
  });
});
