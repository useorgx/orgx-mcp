import { describe, expect, it, vi } from 'vitest';

import {
  applySessionToolObservation,
  buildSessionSummary,
  buildSessionSummaryActivityBody,
  buildSessionSummaryIngestBody,
  createEmptySessionToolStats,
  installSessionToolObservationWrapper,
  parseStoredSessionToolStats,
  SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS,
  SESSION_SUMMARY_INGEST_PATH,
  totalSessionToolCalls,
} from '../src/sessionSummary';

const WORKSPACE_UUID = '11111111-2222-3333-4444-555555555555';
const INITIATIVE_UUID = '66666666-7777-8888-9999-aaaaaaaaaaaa';

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

  describe('v1 ingest body', () => {
    const buildStats = () => {
      let stats = createEmptySessionToolStats();
      stats = applySessionToolObservation(stats, 'orgx_search', 1_000);
      stats = applySessionToolObservation(
        stats,
        'orgx_emit_activity',
        61_000
      );
      return stats;
    };

    it('targets the initiative-optional ingest path', () => {
      expect(SESSION_SUMMARY_INGEST_PATH).toBe('/api/v1/sessions/summary');
    });

    it('builds a flat body an unbound session can post', () => {
      const summary = buildSessionSummary({
        sessionId: 'sess-1',
        clientName: 'claude-code',
        clientVersion: '2.1.0',
        stats: buildStats(),
        workspaceId: null,
        initiativeId: null,
      });

      const body = buildSessionSummaryIngestBody(summary, 'claude-code');

      expect(body).toEqual({
        source: 'orgx-mcp-worker',
        session_id: 'sess-1',
        source_client: 'claude-code',
        started_at: '1970-01-01T00:00:01.000Z',
        ended_at: '1970-01-01T00:01:01.000Z',
        duration_min: 1,
        tool_calls: 2,
        tools: { orgx_search: 1, orgx_emit_activity: 1 },
        metadata: {
          mcp_session_summary: true,
          unique_tool_count: 2,
          client_name: 'claude-code',
          client_version: '2.1.0',
        },
      });
    });

    it('forwards only uuid-shaped bindings so the schema cannot 400', () => {
      const bound = buildSessionSummaryIngestBody(
        buildSessionSummary({
          sessionId: 'sess-2',
          stats: buildStats(),
          workspaceId: WORKSPACE_UUID,
          initiativeId: INITIATIVE_UUID,
        }),
        'codex'
      );
      expect(bound.workspace_id).toBe(WORKSPACE_UUID);
      expect(bound.initiative_id).toBe(INITIATIVE_UUID);

      const legacy = buildSessionSummaryIngestBody(
        buildSessionSummary({
          sessionId: 'sess-3',
          stats: buildStats(),
          workspaceId: 'ws-not-a-uuid',
          initiativeId: 'init-not-a-uuid',
        }),
        'codex'
      );
      expect(legacy.workspace_id).toBeUndefined();
      expect(legacy.initiative_id).toBeUndefined();
      // The non-uuid binding is still recorded, just not in a uuid column.
      expect(legacy.metadata).toMatchObject({
        workspace_id: 'ws-not-a-uuid',
        initiative_id: 'init-not-a-uuid',
      });
    });

    it('records an unrecognized client verbatim rather than dropping it', () => {
      const summary = buildSessionSummary({
        sessionId: 'sess-4',
        clientName: 'brand-new-client',
        stats: buildStats(),
      });
      expect(buildSessionSummaryIngestBody(summary, null).source_client).toBe(
        'brand-new-client'
      );

      const anonymous = buildSessionSummary({
        sessionId: 'sess-5',
        stats: buildStats(),
      });
      expect(buildSessionSummaryIngestBody(anonymous, null).source_client).toBe(
        'api'
      );
    });

    it('caps the tool histogram to the busiest tools', () => {
      let stats = createEmptySessionToolStats();
      for (let i = 0; i < SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS + 5; i += 1) {
        for (let n = 0; n <= i; n += 1) {
          stats = applySessionToolObservation(stats, `tool_${i}`, 1_000 + i);
        }
      }
      const body = buildSessionSummaryIngestBody(
        buildSessionSummary({ sessionId: 'sess-6', stats }),
        'codex'
      );
      const tools = body.tools as Record<string, number>;
      expect(Object.keys(tools)).toHaveLength(
        SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS
      );
      // The dropped keys are the least-used ones.
      expect(tools.tool_0).toBeUndefined();
      expect(
        tools[`tool_${SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS + 4}`]
      ).toBeDefined();
    });
  });
});
