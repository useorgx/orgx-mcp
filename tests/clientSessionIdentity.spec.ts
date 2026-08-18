import { describe, expect, it } from 'vitest';

import {
  buildClientSessionIdentity,
  CLIENT_SESSION_IDENTITY_TOOL_IDS,
  withClientSessionIdentity,
} from '../src/clientSessionIdentity';

describe('clientSessionIdentity', () => {
  const ORGX_SESSION_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('prefers the client-declared conversation id and records its origin', () => {
    const identity = buildClientSessionIdentity({
      context: {
        client: { name: 'claude-code', version: '2.1.0', platform: 'macos' },
        conversation: {
          id: 'conv-abc',
          title: 'Unblock outreach',
          startedAt: '2026-08-18T10:00:00.000Z',
        },
        session: { orgxSessionId: ORGX_SESSION_UUID },
      },
      clientName: 'claude-code',
      clientVersion: '2.1.0',
      mcpSessionId: 'mcp-sess-9',
    });

    expect(identity?.session).toEqual({
      conversation_id: 'conv-abc',
      orgx_session_id: ORGX_SESSION_UUID,
      client_name: 'claude-code',
      title: 'Unblock outreach',
    });
    expect(identity?.detail).toEqual({
      conversation_id_source: 'client_context',
      mcp_session_id: 'mcp-sess-9',
      conversation_started_at: '2026-08-18T10:00:00.000Z',
      client_version: '2.1.0',
      client_platform: 'macos',
    });
  });

  it('drops a non-uuid orgx session id from the typed field but keeps it', () => {
    const identity = buildClientSessionIdentity({
      context: {
        conversation: { id: 'conv-abc' },
        session: { orgxSessionId: 'not-a-uuid' },
      },
      mcpSessionId: 'mcp-1',
    });

    expect(identity?.session.orgx_session_id).toBeUndefined();
    expect(identity?.detail.unverified_orgx_session_id).toBe('not-a-uuid');
  });

  it('caps client_name at the server bound so validation cannot fail', () => {
    const identity = buildClientSessionIdentity({
      context: { conversation: { id: 'conv-abc' } },
      clientName: 'c'.repeat(200),
      mcpSessionId: 'mcp-1',
    });

    expect(identity?.session.client_name).toHaveLength(60);
  });

  it('falls back to the MCP session id when the agent sent no _context', () => {
    const identity = buildClientSessionIdentity({
      context: undefined,
      clientName: 'codex',
      clientVersion: null,
      mcpSessionId: 'mcp-sess-9',
    });

    expect(identity?.session).toEqual({
      conversation_id: 'mcp-sess-9',
      client_name: 'codex',
    });
    expect(identity?.detail.conversation_id_source).toBe('mcp_session');
  });

  it('returns null when no session identity exists at all', () => {
    expect(
      buildClientSessionIdentity({
        context: undefined,
        clientName: 'codex',
        mcpSessionId: null,
      })
    ).toBeNull();
    expect(
      buildClientSessionIdentity({
        context: { client: { name: 'codex' }, conversation: { id: '   ' } },
        mcpSessionId: '',
      })
    ).toBeNull();
  });

  it('attaches session identity additively without touching other fields', () => {
    const identity = buildClientSessionIdentity({
      context: { client: { name: 'claude-code' }, conversation: { id: 'c-1' } },
      mcpSessionId: 'mcp-1',
    });

    const body = withClientSessionIdentity(
      {
        initiative_id: 'init-1',
        message: 'did a thing',
        metadata: { via: 'lifecycle-hook' },
      },
      identity
    );

    expect(body.initiative_id).toBe('init-1');
    expect(body.message).toBe('did a thing');
    expect(body.session).toEqual({
      conversation_id: 'c-1',
      client_name: 'claude-code',
    });
    expect(body.metadata).toEqual({
      via: 'lifecycle-hook',
      session: {
        conversation_id: 'c-1',
        client_name: 'claude-code',
        conversation_id_source: 'client_context',
        mcp_session_id: 'mcp-1',
      },
    });
  });

  it('never overrides an explicitly supplied session', () => {
    const identity = buildClientSessionIdentity({
      context: { conversation: { id: 'derived' } },
      mcpSessionId: 'mcp-1',
    });

    const body = withClientSessionIdentity(
      {
        session: { conversation_id: 'explicit' },
        metadata: { session: { conversation_id: 'explicit-meta' } },
      },
      identity
    );

    expect(body.session).toEqual({ conversation_id: 'explicit' });
    expect(body.metadata).toEqual({
      session: { conversation_id: 'explicit-meta' },
    });
  });

  it('is a no-op when there is no identity to attach', () => {
    const body = { message: 'x' };
    expect(withClientSessionIdentity(body, null)).toBe(body);
  });

  it('targets only reporting tools whose schema derives from runContextBase', () => {
    expect([...CLIENT_SESSION_IDENTITY_TOOL_IDS].sort()).toEqual([
      'orgx_apply_changeset',
      'orgx_emit_activity',
      'orgx_emit_execution_graph',
      'orgx_request_question',
    ]);
  });
});
