import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveFeedDO } from '../src/liveFeedDO';

/**
 * Behavioural tests for the Durable Object, driving real streams rather than
 * asserting on source text.
 *
 * An earlier version of these checks grepped liveFeedDO.ts for the strings the
 * fixes introduced. That passes whether or not the code works: the ordering fix
 * it was guarding was itself wrong — the flag was cleared before the queue
 * drained, so fan-out still overtook replay — and a source-string assertion had
 * no way to notice.
 */

interface Frame {
  type?: string;
  ts?: number;
  data?: unknown;
}

/** Minimal DurableObjectState: storage alarms only. */
function createCtx() {
  let alarm: number | null = null;
  const waits: Promise<unknown>[] = [];
  return {
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p.catch(() => {}));
    },
    settle: () => Promise.all(waits),
    get alarmAt() {
      return alarm;
    },
  } as never as DurableObjectState & { settle(): Promise<unknown>; alarmAt: number | null };
}

function agentsPayload(progress: number) {
  return {
    agents: [{ id: 'a', name: 'Alpha', status: 'running', progress }],
  };
}

/** Read an SSE body into parsed frames until it closes or `want` arrive. */
async function readFrames(body: ReadableStream<Uint8Array>, want: number): Promise<Frame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  const deadline = Date.now() + 2000;
  while (frames.length < want && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        frames.push(JSON.parse(line.slice(6)));
      } catch {
        // heartbeat payloads and comments are not graph frames
      }
    }
  }
  reader.cancel().catch(() => {});
  return frames;
}

function streamRequest(url: string): Request {
  return new Request(url, { headers: { accept: 'text/event-stream' } });
}

const ENV = {
  ORGX_API_URL: 'https://api.test',
  ORGX_SERVICE_KEY: 'oxk-test',
  ORGX_INTERNAL_SECRET: 'secret',
} as never;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a cold connection completes', () => {
  it('returns the response before any write, then delivers a snapshot', async () => {
    // The defect this guards: awaiting a write before returning the Response
    // deadlocks, because a TransformStream write does not resolve until the
    // readable is read and the readable only reaches the runtime at the return.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(10)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);

    const response = await Promise.race([
      feed.fetch(streamRequest('https://do/live-feed/agent-status/init-1/stream')),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
    ]);
    expect(response).not.toBe('timeout');

    const frames = await readFrames((response as Response).body!, 1);
    expect(frames[0]!.type).toBe('snapshot');
    expect((frames[0]!.data as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('arms the alarm once backfill has finished', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(10)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(
      streamRequest('https://do/live-feed/agent-status/init-1/stream')
    );
    await readFrames(response.body!, 1);
    await ctx.settle();
    expect(ctx.alarmAt).not.toBeNull();
  });
});

describe('replay and live events cannot interleave', () => {
  it('drains everything queued during backfill before writing directly', async () => {
    // The ordering bug, exercised rather than grepped: the client joins the
    // broadcast map before its history is written, so a poll landing mid-drain
    // must queue behind the remaining history, not overtake it.
    let progress = 10;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(progress)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);

    const first = await feed.fetch(
      streamRequest('https://do/live-feed/agent-status/init-1/stream')
    );
    const firstFrames = readFrames(first.body!, 3);
    await ctx.settle();

    // Drive a couple of polls so the DO has history and a live client.
    progress = 50;
    await feed.alarm();
    progress = 90;
    await feed.alarm();

    const frames = await firstFrames;
    const timestamps = frames.map((f) => f.ts ?? 0);
    const sorted = [...timestamps].sort((a, b) => a - b);
    // Monotonic: an out-of-order frame would move the client's cursor backwards
    // and let an older graph overwrite a newer one.
    expect(timestamps).toEqual(sorted);
  });
});

describe('capacity and teardown', () => {
  it('refuses a new client past the cap rather than unbounded fan-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(10)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);

    const responses: Response[] = [];
    for (let i = 0; i < 65; i += 1) {
      responses.push(
        await feed.fetch(streamRequest('https://do/live-feed/agent-status/init-1/stream'))
      );
    }
    const rejected = responses.filter((r) => r.status === 503);
    expect(rejected.length).toBeGreaterThan(0);
    expect(await rejected[0]!.json()).toMatchObject({ error: 'feed_at_capacity' });
    // And it tells the caller when to come back.
    expect(rejected[0]!.headers.get('Retry-After')).toBeTruthy();
  });

  it('reports an upstream failure to the client instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(
      streamRequest('https://do/live-feed/agent-status/init-1/stream')
    );
    const frames = await readFrames(response.body!, 1);
    expect(frames[0]!.type).toBe('error');
  });

  it('404s an unknown feed type', async () => {
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(streamRequest('https://do/live-feed/nope/i/stream'));
    expect(response.status).toBe(404);
  });
});

describe('only changed rows are sent after the first snapshot', () => {
  it('follows a snapshot with deltas, not repeated snapshots', async () => {
    let progress = 10;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(progress)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(
      streamRequest('https://do/live-feed/agent-status/init-1/stream')
    );
    const pending = readFrames(response.body!, 2);
    await ctx.settle();

    progress = 75;
    await feed.alarm();

    const frames = await pending;
    expect(frames[0]!.type).toBe('snapshot');
    expect(frames[1]!.type).toBe('delta');
    expect((frames[1]!.data as { changed: unknown[] }).changed).toHaveLength(1);
  });

  it('sends nothing when a poll finds no change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(agentsPayload(10)), { status: 200 }))
    );
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(
      streamRequest('https://do/live-feed/agent-status/init-1/stream')
    );
    const pending = readFrames(response.body!, 2);
    await ctx.settle();
    await feed.alarm();

    const frames = await Promise.race([
      pending,
      new Promise<Frame[]>((r) => setTimeout(() => r([]), 400)),
    ]);
    // Only the snapshot; an unchanged poll is silence, not a repeated payload.
    expect(frames.filter((f) => f.type === 'delta')).toHaveLength(0);
  });
});
