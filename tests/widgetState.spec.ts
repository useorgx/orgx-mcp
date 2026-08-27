import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vm from 'node:vm';

import { describe, expect, it } from 'vitest';

function loadStateModel() {
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(
    readFileSync(resolve(process.cwd(), 'public/widgets/shared/widget-state.js'), 'utf8'),
    context
  );
  return context.window.OrgXWidgetState as {
    derive(value: Record<string, unknown>, options?: { now?: number; staleAfterMs?: number }): Record<string, unknown>;
    formatAge(value: unknown, now?: number): string;
  };
}

describe('widget state model', () => {
  it('does not call a dispatch live before a receipt or heartbeat exists', () => {
    const state = loadStateModel();
    const result = state.derive(
      { status: 'in_progress', updated_at: '2026-08-27T00:00:00.000Z' },
      { now: Date.parse('2026-08-27T00:00:30.000Z') }
    );
    expect(result.state).toBe('starting');
    expect(result.label).toBe('Starting');
  });

  it('marks an old heartbeat as needing refresh', () => {
    const state = loadStateModel();
    const result = state.derive(
      {
        status: 'running',
        run_id: 'run-1',
        last_heartbeat_at: '2026-08-27T00:00:00.000Z',
      },
      { now: Date.parse('2026-08-27T00:04:00.000Z') }
    );
    expect(result.state).toBe('stale');
    expect(result.label).toBe('Needs refresh');
  });

  it('keeps completed state terminal and gives the UI a compact freshness label', () => {
    const state = loadStateModel();
    const now = Date.parse('2026-08-27T00:01:00.000Z');
    const result = state.derive({ status: 'completed', completed_at: '2026-08-27T00:00:55.000Z' }, { now });
    expect(result.state).toBe('completed');
    expect(result.isTerminal).toBe(true);
    expect(state.formatAge({ updated_at: '2026-08-27T00:00:55.000Z' }, now)).toBe('Updated 5s ago');
  });
});
