import { describe, expect, it } from 'vitest';

import {
  buildExecutionGraphHookBundle,
  executionGraphHookForClient,
  EXECUTION_GRAPH_HOOK_ENV,
  EXECUTION_GRAPH_HOOK_COMMAND,
} from '../src/executionGraphHookBundle';

describe('executionGraphHookBundle', () => {
  it('describes a native hook for Claude Code (Stop/SessionEnd)', () => {
    const hook = executionGraphHookForClient('claude');
    expect(hook?.mechanism).toBe('native_hook');
    expect(hook?.events).toEqual(['Stop', 'SessionEnd']);
  });

  it('uses notify for Codex (no native hook bundle)', () => {
    const hook = executionGraphHookForClient('codex');
    expect(hook?.mechanism).toBe('notify_program');
    expect(hook?.events).toEqual(['notify']);
  });

  it('binds the existing Stop hook for Cursor', () => {
    const hook = executionGraphHookForClient('cursor');
    expect(hook?.mechanism).toBe('native_hook');
    expect(hook?.events).toEqual(['Stop']);
  });

  it('emits from the gateway run-completed peer for OpenClaw', () => {
    const hook = executionGraphHookForClient('openclaw');
    expect(hook?.mechanism).toBe('gateway_peer');
  });

  it('returns null for clients without an emit path', () => {
    expect(executionGraphHookForClient('chatgpt')).toBeNull();
    expect(executionGraphHookForClient('other')).toBeNull();
  });

  it('builds a bundle that is opt-in and resolves docs against the web url', () => {
    const bundle = buildExecutionGraphHookBundle({
      sourceClient: 'claude',
      webUrl: 'https://useorgx.com/',
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.optIn).toBe(true);
    expect(bundle?.enableFlag).toBe('ORGX_EMIT_EXECUTION_GRAPH');
    expect(bundle?.emitter.ingestionEndpoint).toBe(
      'https://useorgx.com/api/client/live/execution-graph'
    );
    expect(bundle?.emitter.docs).toBe(
      'https://useorgx.com/docs/integrations/execution-graph-hook'
    );
    expect(bundle?.command).toBe(EXECUTION_GRAPH_HOOK_COMMAND);
  });

  it('the opt-in flag is the first required env var (safety floor)', () => {
    expect(EXECUTION_GRAPH_HOOK_ENV.required[0]).toBe(
      'ORGX_EMIT_EXECUTION_GRAPH'
    );
  });

  it('the Claude Code bundle never references a local .claude path', () => {
    // The hosted claude-code config must not advertise local file writes.
    const bundle = buildExecutionGraphHookBundle({
      sourceClient: 'claude',
      webUrl: 'https://useorgx.com',
    });
    expect(JSON.stringify(bundle)).not.toContain('.claude');
  });
});
