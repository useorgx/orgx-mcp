import { describe, expect, it, vi } from 'vitest';

import {
  applySessionToolObservation,
  buildSessionSummary,
  buildSessionSummaryActivityBody,
  createEmptySessionToolStats,
  installSessionToolObservationWrapper,
  parseStoredSessionToolStats,
  totalSessionToolCalls,
} from '../src/sessionSummary';

describe('sessionSummary', () => {
  it('accumulates per-tool counts and first/last activity timestamps', () => {
    let stats = createEmptySessionToolStats();
    stats = applySessionToolObservation(stats, 'orgx_search', 1_000);
    stats = applySessionToolObservation(stats, 'orgx_search', 2_000);
    stats = applySessionToolObservation(stats, 'orgx_emit_activity', 3_000);

    expect(stats).toEqual({
      firstActivityAt: 1_000,
      lastActivityAt: 3_000,
      toolCounts: { orgx_search: 2, orgx_emit_activity: 1 },
    });
    expect(totalSessionToolCalls(stats)).toBe(3);
  });

  it('parses stored stats defensively and rejects empty or malformed state', () => {
    expect(parseStoredSessionToolStats(null)).toBeNull();
    expect(parseStoredSessionToolStats({})).toBeNull();
    expect(
      parseStoredSessionToolStats({
        firstActivityAt: 1_000,
        lastActivityAt: 2_000,
        toolCounts: { orgx_search: 2, bad: 'nope', negative: -3 },
      })
    ).toEqual({
      firstActivityAt: 1_000,
      lastActivityAt: 2_000,
      toolCounts: { orgx_search: 2 },
    });
  });

  it('builds a compact session summary with the handshake identity and bindings', () => {
    let stats = createEmptySessionToolStats();
    stats = applySessionToolObservation(stats, 'orgx_search', 1_000);
    stats = applySessionToolObservation(stats, 'orgx_attach', 2_000);

    const summary = buildSessionSummary({
      sessionId: 'sess-1',
      clientName: 'claude-code',
      clientVersion: '2.1.0',
      stats,
      workspaceId: 'ws-1',
      initiativeId: 'init-1',
    });

    expect(summary).toEqual({
      session_summary: true,
      session_id: 'sess-1',
      client_name: 'claude-code',
      client_version: '2.1.0',
      tool_call_count: 2,
      unique_tool_count: 2,
      tool_counts: { orgx_search: 1, orgx_attach: 1 },
      first_activity_at: new Date(1_000).toISOString(),
      last_activity_at: new Date(2_000).toISOString(),
      workspace_id: 'ws-1',
      initiative_id: 'init-1',
    });
  });

  it('builds a valid activity body: correlation id, source_client, completed phase', () => {
    const stats = applySessionToolObservation(
      createEmptySessionToolStats(),
      'orgx_search',
      1_000
    );
    const summary = buildSessionSummary({
      sessionId: 'sess-1',
      clientName: 'claude-code',
      stats,
      initiativeId: 'init-1',
    });

    const body = buildSessionSummaryActivityBody(summary, 'claude-code');
    expect(body).toMatchObject({
      initiative_id: 'init-1',
      correlation_id: 'mcp-session-sess-1',
      source_client: 'claude-code',
      phase: 'completed',
      level: 'info',
      metadata: summary,
    });
    expect(body.message).toContain('1 tool call');
    expect(body.message).toContain('claude-code');

    // Unidentified clients still satisfy the schema's source_client requirement.
    const anonymous = buildSessionSummaryActivityBody(
      { ...summary, client_name: null },
      null
    );
    expect(anonymous.source_client).toBe('api');
    expect(anonymous.message).toContain('unidentified client');
  });

  it('observes every registered tool invocation and contains observer failures', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const fakeServer = {
      registerTool: vi.fn(
        (
          name: string,
          _config: Record<string, unknown>,
          handler: (...args: unknown[]) => unknown
        ) => {
          registered.set(name, handler);
        }
      ),
    };
    const observed: string[] = [];
    const observe = vi.fn((toolName: string) => {
      observed.push(toolName);
      if (toolName === 'exploding_tool') {
        throw new Error('observer boom');
      }
    });

    installSessionToolObservationWrapper(fakeServer as never, observe);
    fakeServer.registerTool('orgx_search', {}, async () => 'search-result');
    fakeServer.registerTool('exploding_tool', {}, async () => 'still-works');

    await expect(registered.get('orgx_search')?.({})).resolves.toBe(
      'search-result'
    );
    await expect(registered.get('orgx_search')?.({})).resolves.toBe(
      'search-result'
    );
    // Observer throwing must never break the tool handler.
    await expect(registered.get('exploding_tool')?.({})).resolves.toBe(
      'still-works'
    );
    expect(observed).toEqual(['orgx_search', 'orgx_search', 'exploding_tool']);
  });
});
