// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('task spawned widget', () => {
  const widgetSource = readFileSync(
    resolve(process.cwd(), 'public/widgets/task-spawned.html'),
    'utf8'
  );

  it('distinguishes dispatches from consolidated spawn preflight actions', () => {
    expect(widgetSource).toContain("payload._action || payload.action || 'spawn'");
    expect(widgetSource).toContain(
      "const dispatched = action === 'spawn' || action === 'handoff'"
    );
    expect(widgetSource).toContain(
      'Routing and cost context only. No agent work was dispatched.'
    );
    expect(widgetSource).toContain('Preflight only · no dispatch');
  });
});

describe('task spawned widget run status', () => {
  const RUN_ID = '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99';

  it('polls orgx_command_status for the spawned run and shows what it says', async () => {
    const { mountWidget } = await import('./fixtures/live');
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { kind: 'run', id: RUN_ID, state: 'succeeded', outcome: 'checks passed', next_poll_after_ms: null },
    });
    mountWidget('task-spawned', {
      payload: { _action: 'spawn', title: 'Ship the rate limiter', agent_name: 'Eli', run_id: RUN_ID, status: 'queued' },
      callTool,
    });

    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledWith('orgx_command_status', { kind: 'run', id: RUN_ID });
    });
    await vi.waitFor(() => {
      const footer = document.querySelector('ox-footer');
      expect(footer?.getAttribute('state')).toBe('done');
      expect(footer?.getAttribute('detail')).toBe('checks passed');
    });
    // next_poll_after_ms was null: the state is final, so no further checks.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('never polls a run id the status tool cannot accept', async () => {
    const { mountWidget } = await import('./fixtures/live');
    const callTool = vi.fn();
    mountWidget('task-spawned', {
      payload: { _action: 'spawn', title: 'Ship the rate limiter', agent_name: 'Eli', run_id: 'run-local-1', status: 'queued' },
      callTool,
    });
    await vi.waitFor(() => {
      expect(document.querySelector('ox-footer')?.getAttribute('state')).toBe('queued');
    });
    expect(callTool).not.toHaveBeenCalled();
  });
});
