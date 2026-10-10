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
      'What this would cost and which model would run it. Nothing was started.'
    );
    expect(widgetSource).toContain("heading: 'Nothing started'");
    // Plain words, no routing jargon.
    for (const jargon of ['Dispatch guard', 'Agent work preflight', 'Requested owner', 'Preflight only', 'no dispatch', 'awaiting receipt ID']) {
      expect(widgetSource).not.toContain(jargon);
    }
  });
});

describe('task spawned widget run status', () => {
  const RUN_ID = '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99';

  it('polls orgx_get_operation_status for the spawned run and shows what it says', async () => {
    const { mountWidget } = await import('./fixtures/live');
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { kind: 'run', id: RUN_ID, state: 'succeeded', outcome: 'checks passed', next_poll_after_ms: null },
    });
    mountWidget('task-spawned', {
      payload: { _action: 'spawn', title: 'Ship the rate limiter', agent_name: 'Eli', run_id: RUN_ID, status: 'queued' },
      callTool,
    });

    await vi.waitFor(() => {
      expect(callTool).toHaveBeenCalledWith('orgx_get_operation_status', { kind: 'run', id: RUN_ID });
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

describe('task spawned widget model mark (canvas M1)', () => {
  it('marks the agent with the provider and says the model, tier and who chose it', async () => {
    const { mountWidget, readSharedScript } = await import('./fixtures/live');
    mountWidget('task-spawned', {
      payload: {
        _action: 'spawn',
        title: 'Ship the rate limiter',
        agent_name: 'Eli',
        run_id: 'run-local-1',
        status: 'queued',
        model_tier: 'standard',
        requested_model_tier: 'precision',
        resolved_model: 'claude-sonnet-5',
        provider: 'auto',
        route_reason: 'precision would pass the cap',
        budget_mode: 'balanced',
        max_cost_usd: 2,
      },
    });
    // The served widget inlines agent-identity.js; the card commits after its
    // minimum loading dwell, so installing it here is in time.
    window.eval(readSharedScript('agent-identity.js'));
    await vi.waitFor(() => expect(document.querySelector('.model')).not.toBeNull());

    // auto is not a provider; the model name is.
    const mark = document.querySelector('.av-mark .pmark')!;
    expect(mark.getAttribute('data-provider')).toBe('anthropic');
    expect(mark.getAttribute('aria-label')).toBe('Model: claude-sonnet-5 · Anthropic');
    expect(document.querySelector('.model')!.textContent).toContain('claude-sonnet-5');
    expect(document.querySelector('.model')!.textContent).toContain('Standard tier · You picked the tier');

    const details = document.querySelector('.model-kv') as HTMLElement;
    expect(details.hidden).toBe(true);
    (document.querySelector('[data-model-toggle]') as HTMLElement).click();
    const open = document.querySelector('.model-kv') as HTMLElement;
    expect(open.hidden).toBe(false);
    expect(document.querySelector('[data-model-toggle]')!.getAttribute('aria-expanded')).toBe('true');
    const pairs = Array.from(open.querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(pairs).toEqual([
      ['Model', 'claude-sonnet-5 · Anthropic'],
      ['Chosen by', 'You picked the tier · precision would pass the cap'],
      ['Tier', 'Standard · you asked for Precision'],
      ['Budget', 'balanced · cap $2.00'],
    ]);
  });

  it('shows no model line when the dispatch reported none', async () => {
    const { mountWidget } = await import('./fixtures/live');
    mountWidget('task-spawned', {
      payload: { _action: 'spawn', title: 'Ship the rate limiter', agent_name: 'Eli', run_id: 'run-local-1', status: 'queued' },
    });
    await vi.waitFor(() => expect(document.querySelector('ox-footer')).not.toBeNull());
    expect(document.querySelector('.model')).toBeNull();
    expect(document.querySelector('.pmark')).toBeNull();
  });
});
