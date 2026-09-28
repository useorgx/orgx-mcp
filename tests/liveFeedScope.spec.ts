import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';
import { signStreamToken } from '../src/streamToken';
import { FEED_VIEWER_HEADER } from '../src/live/feedRegistry';

/**
 * Durable Object keying for live feeds.
 *
 * `agent-status` and `initiative-pulse` describe an initiative, so every
 * watcher can share one instance. `decisions` describes a person — the queue is
 * whatever *you* have to approve — so sharing an instance across viewers would
 * serve one person's decisions to another. These tests hold that boundary, and
 * hold that the viewer identity can only come from the verified stream token.
 */

const SECRET = 'test-jwt-secret';

function createCtx() {
  return { waitUntil: vi.fn() } as any;
}

/** Records the DO name the handler asked for, and the request it forwarded. */
function createLiveFeedBinding() {
  const names: string[] = [];
  const forwarded: Request[] = [];
  return {
    names,
    forwarded,
    idFromName(name: string) {
      names.push(name);
      return { name } as any;
    },
    get() {
      return {
        async fetch(request: Request) {
          forwarded.push(request);
          return new Response('data: {}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        },
      } as any;
    },
  };
}

function env(binding: ReturnType<typeof createLiveFeedBinding>) {
  return {
    MCP_SERVER_URL: 'https://mcp.useorgx.com',
    ORGX_API_URL: 'https://useorgx.test',
    ORGX_WEB_URL: 'https://useorgx.com',
    MCP_JWT_SECRET: SECRET,
    LIVE_FEED: binding,
  } as any;
}

async function openStream(
  feedType: string,
  feedId: string,
  options: { userId?: string; headers?: Record<string, string> } = {}
) {
  const binding = createLiveFeedBinding();
  const token = await signStreamToken({
    feedType,
    feedId,
    ...(options.userId ? { userId: options.userId } : {}),
    secret: SECRET,
  });
  const response = await authHandler.fetch(
    new Request(
      `https://mcp.useorgx.com/live-feed/${feedType}/${feedId}/stream?t=${encodeURIComponent(token)}`,
      { headers: options.headers }
    ),
    env(binding),
    createCtx()
  );
  return { binding, response };
}

describe('initiative-scoped feeds share one Durable Object', () => {
  it('keys on feed and initiative only, so watchers converge', async () => {
    const first = await openStream('agent-status', 'init-1', { userId: 'user-a' });
    const second = await openStream('agent-status', 'init-1', { userId: 'user-b' });
    expect(first.binding.names).toEqual(['agent-status:init-1']);
    // Two different viewers, one instance: one upstream poll serves both.
    expect(second.binding.names).toEqual(['agent-status:init-1']);
  });

  it('still separates different initiatives', async () => {
    const a = await openStream('initiative-pulse', 'init-1', { userId: 'user-a' });
    const b = await openStream('initiative-pulse', 'init-2', { userId: 'user-a' });
    expect(a.binding.names[0]).toBe('initiative-pulse:init-1');
    expect(b.binding.names[0]).toBe('initiative-pulse:init-2');
  });

  it('opens without a user id at all', async () => {
    const { response, binding } = await openStream('agent-status', 'init-1');
    expect(response.status).toBe(200);
    expect(binding.names[0]).toBe('agent-status:init-1');
  });
});

describe('user-scoped feeds get one Durable Object per viewer', () => {
  it('keys on the viewer as well as the initiative', async () => {
    const a = await openStream('decisions', 'init-1', { userId: 'user-a' });
    const b = await openStream('decisions', 'init-1', { userId: 'user-b' });
    expect(a.binding.names).toEqual(['decisions:init-1:user-a']);
    expect(b.binding.names).toEqual(['decisions:init-1:user-b']);
    // The whole point: same initiative, different instance.
    expect(a.binding.names[0]).not.toBe(b.binding.names[0]);
  });

  it('refuses to open a user-scoped stream with an anonymous token', async () => {
    // A token with no viewer cannot say whose queue to serve, and defaulting to
    // "everyone's" is exactly the leak this guards.
    const { response, binding } = await openStream('decisions', 'init-1');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'user_scope_requires_identity',
    });
    expect(binding.names).toEqual([]);
  });

  it('forwards the viewer to the Durable Object', async () => {
    const { binding } = await openStream('decisions', 'init-1', { userId: 'user-a' });
    expect(binding.forwarded).toHaveLength(1);
    expect(binding.forwarded[0]!.headers.get(FEED_VIEWER_HEADER)).toBe('user-a');
  });
});

describe('the viewer header is not caller-controlled', () => {
  it('strips an inbound copy and replaces it with the token identity', async () => {
    // Otherwise any client could name itself someone else and read their queue.
    const { binding } = await openStream('decisions', 'init-1', {
      userId: 'user-a',
      headers: { [FEED_VIEWER_HEADER]: 'user-victim' },
    });
    expect(binding.forwarded[0]!.headers.get(FEED_VIEWER_HEADER)).toBe('user-a');
  });

  it('strips it on initiative-scoped feeds too, where no viewer is forwarded', async () => {
    const { binding } = await openStream('agent-status', 'init-1', {
      headers: { [FEED_VIEWER_HEADER]: 'user-victim' },
    });
    expect(binding.forwarded[0]!.headers.get(FEED_VIEWER_HEADER)).toBeNull();
  });

  it('rejects a token minted for a different feed or initiative', async () => {
    const binding = createLiveFeedBinding();
    const token = await signStreamToken({
      feedType: 'decisions',
      feedId: 'init-OTHER',
      userId: 'user-a',
      secret: SECRET,
    });
    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/live-feed/decisions/init-1/stream?t=${encodeURIComponent(token)}`
      ),
      env(binding),
      createCtx()
    );
    expect(response.status).toBe(403);
    expect(binding.names).toEqual([]);
  });
});
