/**
 * LiveFeedDO — Durable Object for real-time polling SSE feeds.
 *
 * One instance per (feedType, feedId) pair, keyed as `${feedType}:${feedId}`.
 * Polls the OrgX API on a 10-second alarm cycle, diffs state, and fans out
 * only changed data to all connected SSE clients.
 *
 * Supported feed types:
 *   agent-status    → GET /api/live/agents?initiative=<id>
 *   initiative-pulse → GET /api/live/initiatives?id=<id>
 *
 * Routes (handled by authHandler.ts, proxied into this DO):
 *   GET /live-feed/agent-status/:initiativeId/stream
 *   GET /live-feed/initiative-pulse/:initiativeId/stream
 */

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_STORED_EVENTS = 500;
const HEARTBEAT_MS = 15_000;

export type LiveFeedEvent =
  | { type: 'snapshot'; feedType: string; feedId: string; data: unknown; ts: number }
  | { type: 'delta'; feedType: string; feedId: string; data: unknown; ts: number }
  | { type: 'error'; message: string; ts: number };

interface LiveFeedEnv {
  ORGX_API_URL: string;
  ORGX_SERVICE_KEY?: string;
}

interface SSEClient {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  connectedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

export class LiveFeedDO {
  private clients = new Map<string, SSEClient>();
  private events: LiveFeedEvent[] = [];
  private lastSnapshot: unknown = null;
  private feedType = '';
  private feedId = '';
  private encoder = new TextEncoder();
  private initialized = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveFeedEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Parse feed type + id from path: /live-feed/:feedType/:feedId/stream
    const match = url.pathname.match(
      /^\/live-feed\/(agent-status|initiative-pulse)\/([^/]+)\/stream$/
    );
    if (!match || request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const feedType = match[1]!;
    const feedId = match[2]!;

    // Persist feed identity across DO lifetime
    if (!this.initialized) {
      this.feedType = feedType;
      this.feedId = feedId;
      this.initialized = true;
    }

    return this.handleStream(request, feedType, feedId);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SSE stream handler
  // ────────────────────────────────────────────────────────────────────────────
  private async handleStream(
    request: Request,
    feedType: string,
    feedId: string
  ): Promise<Response> {
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
    const clientId = crypto.randomUUID();

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Replay missed events
    const replay = since > 0 ? this.events.filter((e) => e.ts > since) : this.events;
    for (const event of replay) {
      try {
        await writer.write(this.sseChunk(event));
      } catch {
        writer.close().catch(() => {});
        return new Response(readable, { headers: sseHeaders() });
      }
    }

    // If no stored events yet, do an immediate poll to give the client initial data
    if (this.events.length === 0) {
      try {
        const snapshot = await this.poll(feedType, feedId);
        if (snapshot) {
          await writer.write(this.sseChunk(snapshot));
        }
      } catch {
        // Best-effort — don't block the stream
      }
    }

    // Heartbeat
    const heartbeatTimer = setInterval(async () => {
      if (!this.clients.has(clientId)) {
        clearInterval(heartbeatTimer);
        return;
      }
      try {
        await writer.write(this.encoder.encode(': heartbeat\n\n'));
      } catch {
        clearInterval(heartbeatTimer);
        this.clients.delete(clientId);
      }
    }, HEARTBEAT_MS);

    this.clients.set(clientId, { writer, connectedAt: Date.now(), heartbeatTimer });

    // Schedule first alarm if none running
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }

    // Clean up on disconnect
    request.signal.addEventListener('abort', () => {
      const client = this.clients.get(clientId);
      if (client) {
        clearInterval(client.heartbeatTimer);
        client.writer.close().catch(() => {});
        this.clients.delete(clientId);
      }
    });

    return new Response(readable, { headers: sseHeaders() });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Alarm handler — periodic poll + fan-out
  // ────────────────────────────────────────────────────────────────────────────
  async alarm(): Promise<void> {
    if (this.clients.size === 0) {
      // No clients — let alarm expire, restart on next connection
      return;
    }

    try {
      const event = await this.poll(this.feedType, this.feedId);
      if (event) {
        await this.fanOut(event);
      }
    } catch (err) {
      const errorEvent: LiveFeedEvent = {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      };
      await this.fanOut(errorEvent).catch(() => {});
    }

    // Reschedule while clients are connected
    if (this.clients.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Fetch data from OrgX API, diff against last state
  // ────────────────────────────────────────────────────────────────────────────
  private async poll(feedType: string, feedId: string): Promise<LiveFeedEvent | null> {
    const apiUrl = this.buildApiUrl(feedType, feedId);
    if (!apiUrl) return null;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.env.ORGX_SERVICE_KEY) {
      headers['Authorization'] = `Bearer ${this.env.ORGX_SERVICE_KEY}`;
      headers['x-orgx-service-key'] = this.env.ORGX_SERVICE_KEY;
    }

    const resp = await fetch(apiUrl, { headers });
    if (!resp.ok) {
      throw new Error(`API ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    const data = await resp.json();
    const ts = Date.now();

    const isFirstSnapshot = this.lastSnapshot === null;
    const hasChanged = !isFirstSnapshot && JSON.stringify(data) !== JSON.stringify(this.lastSnapshot);

    this.lastSnapshot = data;

    if (isFirstSnapshot || hasChanged) {
      const event: LiveFeedEvent = {
        type: isFirstSnapshot ? 'snapshot' : 'delta',
        feedType,
        feedId,
        data,
        ts,
      };
      // Store event (cap buffer)
      this.events.push(event);
      if (this.events.length > MAX_STORED_EVENTS) {
        this.events.splice(0, this.events.length - MAX_STORED_EVENTS);
      }
      return event;
    }

    return null;
  }

  private buildApiUrl(feedType: string, feedId: string): string | null {
    const base = this.env.ORGX_API_URL;
    switch (feedType) {
      case 'agent-status':
        return `${base}/api/live/agents?initiative=${encodeURIComponent(feedId)}`;
      case 'initiative-pulse':
        return `${base}/api/live/initiatives?id=${encodeURIComponent(feedId)}`;
      default:
        return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Fan out to all connected clients
  // ────────────────────────────────────────────────────────────────────────────
  private async fanOut(event: LiveFeedEvent): Promise<void> {
    const chunk = this.sseChunk(event);
    const toRemove: string[] = [];
    for (const [id, client] of this.clients) {
      try {
        await client.writer.write(chunk);
      } catch {
        clearInterval(client.heartbeatTimer);
        toRemove.push(id);
      }
    }
    for (const id of toRemove) this.clients.delete(id);
  }

  private sseChunk(event: LiveFeedEvent): Uint8Array {
    return this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Transfer-Encoding': 'chunked',
    ...corsHeaders(),
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
