/**
 * ScaffoldSessionDO — Durable Object for real-time scaffold streaming.
 *
 * One instance per scaffold session (keyed by sessionId). Receives entity-
 * creation events from the scaffold_initiative async pipeline and fans them
 * out to all connected SSE clients in real time.
 *
 * Routes (handled internally by this DO):
 *   GET  /scaffold/:sessionId/stream     — EventSource endpoint (stream token required)
 *   POST /scaffold/:sessionId/event      — Push event (internal, ORGX_INTERNAL_SECRET)
 *   GET  /scaffold/:sessionId/status     — Health check (stream token required)
 */

export type ScaffoldEvent =
  | { type: 'session.start'; sessionId: string; title?: string; ts: number }
  | { type: 'entity.created'; entityType: string; entity: Record<string, unknown>; index: number; total: number; ts: number }
  | { type: 'entity.failed'; entityType: string; error: string; index: number; ts: number }
  | { type: 'scaffold.complete'; initiativeId: string | null; liveUrl: string | null; totalEntities: number; ts: number }
  | { type: 'scaffold.error'; error: string; ts: number };

interface DOEnv {
  ORGX_INTERNAL_SECRET?: string;
}

interface SSEClient {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  connectedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

export class ScaffoldSessionDO {
  private clients = new Map<string, SSEClient>();
  private events: ScaffoldEvent[] = [];
  private done = false;
  private encoder = new TextEncoder();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: DOEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    // Path shape: /scaffold/:sessionId/stream | /event | /status
    const action = segments[segments.length - 1];

    if (action === 'stream' && request.method === 'GET') {
      return this.handleStream(request);
    }
    if (action === 'event' && request.method === 'POST') {
      return this.handleEvent(request);
    }
    if (action === 'status' && request.method === 'GET') {
      return this.handleStatus();
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /scaffold/:sessionId/stream
  // Returns an EventSource-compatible text/event-stream response.
  // Replays missed events if ?since=<timestamp> is provided.
  // ──────────────────────────────────────────────────────────────────────────
  private async handleStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
    const clientId = crypto.randomUUID();

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    // Replay events the client missed (reconnect support)
    const replay = since > 0 ? this.events.filter((e) => e.ts > since) : this.events;
    for (const event of replay) {
      try {
        await writer.write(this.sseChunk(event));
      } catch {
        // Client may have disconnected during replay
        writer.close().catch(() => {});
        return new Response(readable, { headers: sseHeaders() });
      }
    }

    // If already complete, close immediately after replay
    if (this.done) {
      writer.close().catch(() => {});
      return new Response(readable, { headers: sseHeaders() });
    }

    // Heartbeat every 15s to keep the connection alive through proxies
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
    }, 15_000);

    this.clients.set(clientId, { writer, connectedAt: Date.now(), heartbeatTimer });

    // Clean up when the client disconnects
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

  // ──────────────────────────────────────────────────────────────────────────
  // POST /scaffold/:sessionId/event
  // Internal endpoint: scaffold_initiative async pipeline pushes events here.
  // Requires Authorization: Bearer <ORGX_INTERNAL_SECRET>
  // ──────────────────────────────────────────────────────────────────────────
  private async handleEvent(request: Request): Promise<Response> {
    const secret = this.env.ORGX_INTERNAL_SECRET;
    if (!secret) {
      // Fail closed — refuse events when the internal secret is not configured.
      return new Response(
        JSON.stringify({ error: 'ORGX_INTERNAL_SECRET not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const auth = request.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${secret}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let event: ScaffoldEvent;
    try {
      event = (await request.json()) as ScaffoldEvent;
      if (!event.type) throw new Error('missing type');
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stamp with server time if not already set
    if (!event.ts) (event as Record<string, unknown>).ts = Date.now();

    this.events.push(event);

    if (event.type === 'scaffold.complete' || event.type === 'scaffold.error') {
      this.done = true;
    }

    // Fan out to all connected SSE clients
    const toRemove: string[] = [];
    for (const [id, client] of this.clients) {
      try {
        await client.writer.write(this.sseChunk(event));
        if (this.done) {
          await client.writer.close();
          clearInterval(client.heartbeatTimer);
          toRemove.push(id);
        }
      } catch {
        clearInterval(client.heartbeatTimer);
        toRemove.push(id);
      }
    }
    for (const id of toRemove) this.clients.delete(id);

    return new Response(
      JSON.stringify({ ok: true, clients: this.clients.size, events: this.events.length }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /scaffold/:sessionId/status
  // ──────────────────────────────────────────────────────────────────────────
  private handleStatus(): Response {
    return new Response(
      JSON.stringify({
        ok: true,
        clients: this.clients.size,
        events: this.events.length,
        done: this.done,
        lastEventTs: this.events.length > 0 ? this.events[this.events.length - 1]!.ts : null,
      }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────
  private sseChunk(event: ScaffoldEvent): Uint8Array {
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
