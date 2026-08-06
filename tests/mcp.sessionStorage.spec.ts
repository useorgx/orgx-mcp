import { describe, expect, it } from 'vitest';

import {
  parseStoredSessionAuth,
  parseStoredSessionContext,
  toStoredSessionAuth,
  toStoredSessionContext,
} from '../src/sessionStorage';

describe('MCP session storage (DO persistence)', () => {
  it('parses stored session auth (snake_case)', () => {
    const parsed = parseStoredSessionAuth({
      user_id: 'user_123',
      scope: 'read write',
      email: 'test@example.com',
      authenticated_at: 1700000000000,
      updated_at: 1700000001000,
    });

    expect(parsed).toEqual({
      userId: 'user_123',
      scope: 'read write',
      email: 'test@example.com',
      authenticatedAt: 1700000000000,
    });
  });

  it('parses stored session auth (camelCase) and tolerates nulls', () => {
    const parsed = parseStoredSessionAuth({
      userId: 'user_456',
      scope: null,
      email: null,
      authenticatedAt: 1700000002000,
      updatedAt: 1700000003000,
    });

    expect(parsed).toEqual({
      userId: 'user_456',
      scope: undefined,
      email: undefined,
      authenticatedAt: 1700000002000,
    });
  });

  it('serializes stored session auth deterministically', () => {
    const stored = toStoredSessionAuth(
      {
        userId: 'user_789',
        scope: 'admin',
        email: 'a@b.com',
        authenticatedAt: 111,
      },
      222
    );

    expect(stored).toEqual({
      user_id: 'user_789',
      orgx_user_id: null,
      scope: 'admin',
      email: 'a@b.com',
      authenticated_at: 111,
      updated_at: 222,
    });
  });

  it('round-trips the orgx_user_id (Supabase UUID) through store + parse', () => {
    const uuid = '5c52c8ca-c1d0-48cc-a177-9cf1ac2c5b06';
    const stored = toStoredSessionAuth(
      {
        userId: 'user_789',
        orgxUserId: uuid,
        scope: 'admin',
        email: 'a@b.com',
        authenticatedAt: 111,
      },
      222
    );
    expect(stored.orgx_user_id).toBe(uuid);
    expect(parseStoredSessionAuth(stored)).toEqual({
      userId: 'user_789',
      orgxUserId: uuid,
      scope: 'admin',
      email: 'a@b.com',
      authenticatedAt: 111,
    });
  });

  it('omits orgxUserId when the stored row predates the UUID column', () => {
    const parsed = parseStoredSessionAuth({
      user_id: 'user_789',
      scope: 'admin',
      email: 'a@b.com',
      authenticated_at: 111,
    });
    expect(parsed?.orgxUserId).toBeUndefined();
  });

  it('parses stored session context (snake_case)', () => {
    const parsed = parseStoredSessionContext({
      workspace_id: 'ws_1',
      workspace_name: 'Default',
      initiative_id: 'init_1',
      updated_at: 1700000000000,
    });

    expect(parsed).toEqual({
      workspaceId: 'ws_1',
      workspaceName: 'Default',
      initiativeId: 'init_1',
    });
  });

  it('serializes stored session context deterministically', () => {
    const stored = toStoredSessionContext(
      { workspaceId: 'ws_2', initiativeId: 'init_2' },
      999
    );

    expect(stored).toEqual({
      workspace_id: 'ws_2',
      workspace_name: null,
      initiative_id: 'init_2',
      client_name: null,
      client_version: null,
      updated_at: 999,
    });
  });

  it('round-trips the initialize handshake clientInfo through store + parse', () => {
    const stored = toStoredSessionContext(
      {
        workspaceId: 'ws_3',
        clientName: 'claude-code',
        clientVersion: '2.1.0',
      },
      999
    );
    expect(stored.client_name).toBe('claude-code');
    expect(stored.client_version).toBe('2.1.0');

    expect(parseStoredSessionContext(stored)).toEqual({
      workspaceId: 'ws_3',
      clientName: 'claude-code',
      clientVersion: '2.1.0',
    });
  });

  it('keeps a context row alive when only the handshake identity is present', () => {
    expect(
      parseStoredSessionContext({ client_name: 'codex', updated_at: 1 })
    ).toEqual({ clientName: 'codex' });
    expect(parseStoredSessionContext({ updated_at: 1 })).toBeNull();
  });
});
