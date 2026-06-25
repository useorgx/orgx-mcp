import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiCalls: Array<{ path: string; userId?: string | null }> = [];
const apiResponses: Array<
  | { kind: 'ok'; body: unknown; wait?: Promise<void> }
  | { kind: 'error'; statusCode?: number; message?: string; wait?: Promise<void> }
> = [];

vi.mock('../src/orgxApi', async () => {
  const actual = await vi.importActual<typeof import('../src/orgxApi')>(
    '../src/orgxApi'
  );
  return {
    ...actual,
    callOrgxApiJson: vi.fn(async (_env, path, _init, opts) => {
      apiCalls.push({ path, userId: opts?.userId ?? null });
      const next = apiResponses.shift();
      if (!next) {
        throw new Error(`no response queued for path ${path}`);
      }
      if ('wait' in next && next.wait) await next.wait;
      if (next.kind === 'ok') return next.body;
      throw new actual.OrgXApiError(
        next.message ?? 'api error',
        next.message ?? 'api error',
        next.statusCode
      );
    }),
  };
});

import {
  requireWorkspace,
  detectWorkspaceArgConflict,
  _clearMembershipCacheForTests,
} from '../src/requireWorkspace';

const env = {
  ORGX_API_URL: 'https://test.useorgx.com',
  ORGX_SERVICE_KEY: 'oxk-test',
} as const;

beforeEach(() => {
  apiCalls.length = 0;
  apiResponses.length = 0;
  _clearMembershipCacheForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

function queueOk(body: unknown = { id: 'ws-A' }) {
  apiResponses.push({ kind: 'ok', body });
}
function queueErr(statusCode?: number) {
  apiResponses.push({ kind: 'error', statusCode });
}

describe('requireWorkspace', () => {
  it('returns ok when caller owns the workspace from args.workspace_id', async () => {
    queueOk();
    const result = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspaceId).toBe('ws-A');
    expect(apiCalls[0].path).toBe('/api/workspaces/ws-A');
    expect(apiCalls[0].userId).toBe('user_alice');
  });

  it('falls back to sessionWorkspaceId when args is empty', async () => {
    queueOk();
    const result = await requireWorkspace({
      args: {},
      sessionWorkspaceId: 'ws-A',
      userId: 'user_alice',
      env,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspaceId).toBe('ws-A');
  });

  it('accepts deprecated command_center_id alias', async () => {
    queueOk();
    const result = await requireWorkspace({
      args: { command_center_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    expect(result.ok).toBe(true);
  });

  it('returns 404 when caller does not own the workspace', async () => {
    queueErr(404);
    const result = await requireWorkspace({
      args: { workspace_id: 'ws-X' },
      userId: 'user_bob',
      env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).toContain('not_found');
    }
  });

  it('collapses underlying 403 to a 404-shape error', async () => {
    queueErr(403);
    const result = await requireWorkspace({
      args: { workspace_id: 'ws-X' },
      userId: 'user_bob',
      env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).toContain('not_found');
    }
  });

  it('returns 503 (not 404) on transient errors so we do not poison cache', async () => {
    queueErr(500);
    const result = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).toContain('membership_check_failed');
    }
  });

  it('returns 400 when no workspace_id is resolvable', async () => {
    const result = await requireWorkspace({
      args: {},
      userId: 'user_alice',
      env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).toContain('missing_workspace');
    }
    expect(apiCalls).toHaveLength(0);
  });

  it('returns 401 when no userId is supplied', async () => {
    const result = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: null,
      env,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).toContain('unauthorized');
    }
    expect(apiCalls).toHaveLength(0);
  });

  it('caches positive membership for repeated calls in the same session', async () => {
    queueOk();
    const a = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    const b = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    expect(a.ok && b.ok).toBe(true);
    expect(apiCalls).toHaveLength(1);
  });

  it('dedupes concurrent membership checks for the same user and workspace', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiResponses.push({ kind: 'ok', body: { id: 'ws-A' }, wait });

    const first = requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    const second = requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });

    await Promise.resolve();
    expect(apiCalls).toHaveLength(1);
    release();

    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(apiCalls).toHaveLength(1);
  });

  it('caches negative membership too (no extra API calls)', async () => {
    queueErr(404);
    const a = await requireWorkspace({
      args: { workspace_id: 'ws-X' },
      userId: 'user_alice',
      env,
    });
    const b = await requireWorkspace({
      args: { workspace_id: 'ws-X' },
      userId: 'user_alice',
      env,
    });
    expect(a.ok || b.ok).toBe(false);
    expect(apiCalls).toHaveLength(1);
  });

  it('does not cache transient errors (avoids cache poisoning)', async () => {
    queueErr(500);
    queueOk(); // second call — succeeds
    await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    const second = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    expect(second.ok).toBe(true);
    expect(apiCalls).toHaveLength(2);
  });

  it('per-user caching: alice and bob are tracked independently', async () => {
    queueOk(); // alice owns
    queueErr(404); // bob does not
    const alice = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_alice',
      env,
    });
    const bob = await requireWorkspace({
      args: { workspace_id: 'ws-A' },
      userId: 'user_bob',
      env,
    });
    expect(alice.ok).toBe(true);
    expect(bob.ok).toBe(false);
    expect(apiCalls).toHaveLength(2);
  });
});

describe('detectWorkspaceArgConflict', () => {
  it('returns null when neither key is present', () => {
    expect(detectWorkspaceArgConflict({})).toBeNull();
  });

  it('returns null when only workspace_id is present', () => {
    expect(detectWorkspaceArgConflict({ workspace_id: 'ws-A' })).toBeNull();
  });

  it('returns null when only command_center_id is present', () => {
    expect(detectWorkspaceArgConflict({ command_center_id: 'ws-A' })).toBeNull();
  });

  it('returns null when both match', () => {
    expect(
      detectWorkspaceArgConflict({
        workspace_id: 'ws-A',
        command_center_id: 'ws-A',
      })
    ).toBeNull();
  });

  it('returns a 400 CallToolResult when they differ', () => {
    const err = detectWorkspaceArgConflict({
      workspace_id: 'ws-A',
      command_center_id: 'ws-B',
    });
    expect(err).not.toBeNull();
    expect(JSON.stringify(err)).toContain('invalid_input');
  });
});
