// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildPanelThread, handlePanelSnapshot, type PanelSurfaceHost } from '../src/panelSurface';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { ORGX_SERVER_INSTRUCTIONS } from '../src/serverInstructions';
import { mountPanel, snapshot } from './fixtures/panel';

const WS = '11111111-1111-4111-8111-111111111111';
const INIT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const DECISION = '44444444-4444-4444-8444-444444444444';

function host(overrides: Partial<PanelSurfaceHost> = {}): PanelSurfaceHost {
  return {
    authRequired: vi.fn(() => null),
    viewerUserIds: vi.fn(() => ['u1']),
    sessionWorkspace: vi.fn(() => ({ id: WS, name: 'Acme' })),
    inferWorkspace: vi.fn(async () => null),
    fetchPendingDecisions: vi.fn(async () => ({
      ok: true,
      data: {
        decisions: [{
          id: DECISION, title: 'Ship the pilot?', urgency: 'high', created_at: '2026-10-01T10:00:00.000Z',
          context: { initiative_id: INIT, run_id: RUN },
          review_packet: { question: 'Ship the pilot?', references: [{ type: 'initiative', id: INIT, label: 'Pilot launch' }] },
        }],
      },
    })),
    fetchArtifacts: vi.fn(async () => []),
    run: vi.fn((runner) => runner()),
    now: () => new Date('2026-10-08T15:00:00.000Z'),
    ...overrides,
  };
}

describe('buildPanelThread', () => {
  it('prefers the agent-declared conversation, then the host session id', () => {
    expect(buildPanelThread({ context: { conversation: { id: 'chat-1' } }, requestMeta: { 'openai/session': 'sess-1' } }))
      .toMatchObject({ conversation_id: 'chat-1', source: 'client_context' });
    expect(buildPanelThread({ requestMeta: { 'openai/session': 'sess-1' } }))
      .toMatchObject({ conversation_id: 'sess-1', source: 'host_session' });
  });

  it('is absent without a conversation, and never clips an id', () => {
    expect(buildPanelThread({})).toBeNull();
    expect(buildPanelThread({ requestMeta: { 'openai/session': 'x'.repeat(256) } })).toBeNull();
  });

  it('takes the initiative from the session and only its title from the queue', () => {
    const thread = buildPanelThread({
      requestMeta: { 'openai/session': 's' },
      initiativeId: INIT,
      queue: [{ initiative_id: 'other', initiative_title: 'Nope' }, { initiative_id: INIT, initiative_title: 'Pilot launch' }] as never,
    });
    expect(thread).toEqual({ conversation_id: 's', source: 'host_session', initiative_id: INIT, initiative_title: 'Pilot launch' });
    expect(buildPanelThread({ requestMeta: { 'openai/session': 's' }, initiativeId: 'not-a-uuid' })!.initiative_id).toBeNull();
  });
});

describe('orgx_panel_snapshot: bound to the conversation', () => {
  it('returns the thread, the initiative and run ids, and matches the output schema', async () => {
    const result = await handlePanelSnapshot(
      host({ sessionInitiative: () => INIT }),
      { focus: { type: 'decision', id: DECISION } },
      { 'openai/session': 'sess-1' }
    );
    const s = result.structuredContent as Record<string, any>;
    expect(s.thread).toEqual({ conversation_id: 'sess-1', source: 'host_session', initiative_id: INIT, initiative_title: 'Pilot launch' });
    expect(s.queue[0]).toMatchObject({ initiative_id: INIT });
    expect(s.focus).toMatchObject({ initiative_id: INIT, run_id: RUN });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('leaves the sidebar unbound when the host names no conversation', async () => {
    const result = await handlePanelSnapshot(host(), {});
    expect((result.structuredContent as Record<string, unknown>).thread).toBeUndefined();
  });
});

const mounted: Array<{ dom: { window: { close(): void } } }> = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

describe('the panel widget', () => {
  it('opens on the thread view when OrgX names the conversation', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot({ thread: { conversation_id: 'c', source: 'host_session', initiative_id: null, initiative_title: null } }), _meta: {} });
    await m.flush();
    const doc = m.dom.window.document;
    expect(doc.querySelector('.thread-foot')).not.toBeNull();
  });

  it('stays on the sidebar view when no conversation is named', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot(), _meta: {} });
    await m.flush();
    expect(m.dom.window.document.querySelector('.thread-foot')).toBeNull();
  });

  it('joins the work behind a decision by its run before any PR number', async () => {
    const base = snapshot();
    const focus = { ...(base.focus as Record<string, unknown>), run_id: RUN, question: 'Merge it?\n\ngh pr merge 3236' };
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: { ok: true, total: 0, results: [] } });
    m.app().ontoolresult({ structuredContent: snapshot({ focus }), _meta: { 'orgx/widgetApproval': { approval_tokens: {} } } });
    await m.flush(); await m.flush(); await m.flush(); await m.flush();
    const queries = m.calls.callServerTool.mock.calls
      .filter(([call]: [{ name: string }]) => call.name === 'orgx_list_work_receipts')
      .map(([call]: [{ arguments: { query: string } }]) => call.arguments.query);
    expect(queries[0]).toBe('run:' + RUN);
    expect(queries[1]).toBe('pr:3236');
  });
});

describe('server instructions', () => {
  it('name the brief, the receipt and the person deciding, in three sentences', () => {
    expect(ORGX_SERVER_INSTRUCTIONS).toContain('orgx_inspect');
    expect(ORGX_SERVER_INSTRUCTIONS).toContain('orgx_submit_work_receipt');
    expect(ORGX_SERVER_INSTRUCTIONS).toMatch(/Never approve/);
    expect(ORGX_SERVER_INSTRUCTIONS.split(/(?<=\.) /)).toHaveLength(3);
  });
});
