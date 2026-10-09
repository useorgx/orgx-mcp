// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { mountWidget } from './fixtures/live';

const COMMAND_ID = '3a9e6f2c-7d41-4b8e-9c15-0f2d8b6a4e71';

const draftScaffold = {
  initiative: { id: 'INI-7', title: 'Checkout v2', status: 'scaffolded' },
  hierarchy: {
    initiative: { id: 'INI-7', title: 'Checkout v2', status: 'scaffolded' },
    workstreams: [
      { id: 'WS-1', title: 'Payments', milestones: [{ id: 'MS-1', title: 'Card flow', tasks: [{ id: 'TSK-1', title: 'Wire Stripe' }] }] },
      { id: 'WS-2', title: 'Comms', milestones: [{ id: 'MS-2', title: 'Launch note', tasks: [{ id: 'TSK-2', title: 'Draft note' }] }] },
    ],
  },
  agent_assignment: { assignments: [{ workstream_id: 'WS-1', domain: 'engineering', agent_name: 'Eli' }] },
};

function footer(): HTMLElement {
  return document.getElementById('scaffoldFooter') as HTMLElement;
}

describe('scaffolded initiative launch', () => {
  it('launches with orgx_launch_initiative and follows the command through orgx_get_operation_status', async () => {
    const callTool = vi.fn((name: string) => {
      if (name === 'orgx_launch_initiative') return Promise.resolve({ structuredContent: { ok: true, command_id: COMMAND_ID } });
      return Promise.resolve({ structuredContent: { kind: 'command', id: COMMAND_ID, state: 'succeeded', outcome: '2 workstreams running', next_poll_after_ms: null } });
    });
    mountWidget('scaffolded-initiative', { payload: draftScaffold, callTool });

    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));
    expect(footer().hasAttribute('hold')).toBe(true);
    expect(footer().getAttribute('primary-label')).toBe('Hold to launch');

    footer().dispatchEvent(new CustomEvent('ox-primary'));

    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledWith('orgx_launch_initiative', { initiative_id: 'INI-7' });
      expect(callTool).toHaveBeenCalledWith('orgx_get_operation_status', { kind: 'command', id: COMMAND_ID });
    });
    await vi.waitFor(() => {
      expect(footer().getAttribute('state')).toBe('done');
      expect(footer().getAttribute('detail')).toBe('2 workstreams running');
    });
  });

  it('says the launch failed and offers the same launch again', async () => {
    const callTool = vi.fn(() => Promise.reject(new Error('Launch refused')));
    mountWidget('scaffolded-initiative', { payload: draftScaffold, callTool });
    await vi.waitFor(() => expect(footer()?.getAttribute('state')).toBe('needs-you'));

    footer().dispatchEvent(new CustomEvent('ox-primary'));
    await vi.waitFor(() => expect(footer().getAttribute('state')).toBe('failed'));
    expect(footer().getAttribute('primary-label')).toBe('Retry');

    footer().dispatchEvent(new CustomEvent('ox-primary'));
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    expect(callTool).toHaveBeenLastCalledWith('orgx_launch_initiative', { initiative_id: 'INI-7' });
  });

  it('renders authoritative aggregate creation counts without inventing hierarchy details or readiness', async () => {
    const callTool = vi.fn();
    mountWidget('scaffolded-initiative', { payload: { data: { initiativeId: 'INI-7', initiative: draftScaffold.initiative, created: { workstreams: 2, milestones: 4, tasks: 8, dependency_edges: 3, agents_assigned: 0 } }, meta: { apiVersion: '1' } }, callTool });
    await vi.waitFor(() => expect(footer()?.getAttribute('heading')).toBe('Hierarchy created'));
    expect(document.body.textContent).toContain('2 workstreams · 4 milestones · 8 tasks created');
    expect(document.body.textContent).not.toContain('No workstreams yet');
    expect(footer().getAttribute('primary-label')).toBeNull();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('keeps the Live View link and workstream disclosure', async () => {
    mountWidget('scaffolded-initiative', { payload: draftScaffold, callTool: vi.fn() });
    await vi.waitFor(() => expect(document.querySelector('[data-open-live-view]')).not.toBeNull());
    expect(document.querySelector('[data-open-live-view]')?.getAttribute('data-href')).toBe('https://useorgx.com/live/INI-7');
    const toggle = document.querySelector('.node-toggle') as HTMLButtonElement;
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect((document.querySelector('[data-ws-children]') as HTMLElement).hidden).toBe(false);
  });
});
