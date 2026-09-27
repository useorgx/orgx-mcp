/**
 * LiveFeedDO — Durable Object fanning one polled OrgX feed out to many widgets.
 *
 * One instance per `${feedType}:${feedId}`. The feed catalogue lives in
 * src/live/feedRegistry.ts, so this class contains transport and lifecycle only
 * — no per-feed knowledge. Adding a feed is a registry entry.
 *
 * What it does differently from the first version:
 *  - Adaptive cadence. Executing or blocked work polls at the feed's active
 *    rate; a resting graph drops to its idle rate. The old fixed 10s tick cost
 *    the same for a finished initiative as a live one.
 *  - Row-level deltas. Only changed nodes are pushed, instead of the whole
 *    payload on any difference.
 *  - Canonical payloads. Every feed emits the same WorkGraph shape, so widgets
 *    share one reader.
 *  - Structured logging with the same field vocabulary as the widget-side
 *    logger, so a session can be followed across the boundary.
 *
 * Routes (verified by authHandler.ts, then proxied here):
 *   GET /live-feed/:feedType/:feedId/stream
 */

import {
  cadenceFor,
  getFeed,
  FEED_ROUTE_PATTERN,
  FEED_VIEWER_HEADER,
} from './live/feedRegistry';
import { callOrgxApiRaw, type OrgxApiEnv } from './orgxApi';
import { diffGraphs, type WorkGraphDelta } from './live/delta';
import type { WorkGraph } from './live/workGraph';

const MAX_STORED_EVENTS = 200;
const HEARTBEAT_MS = 15_000;
/** Upstream calls are bounded so a hung API cannot wedge the alarm loop. */
const UPSTREAM_TIMEOUT_MS = 8_000;
/** Consecutive upstream failures before the feed reports itself unhealthy. */
const ERROR_STREAK_LIMIT = 3;

export type LiveFeedEvent =
  | { type: 'snapshot'; feedType: string; feedId: string; data: WorkGraph; ts: number }
  | { type: 'delta'; feedType: string; feedId: string; data: WorkGraphDelta; ts: number }
  | { type: 'error'; message: string; retryable: boolean; ts: number };

type LiveFeedEnv = OrgxApiEnv;

interface SSEClient {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  connectedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

interface LogFields {
  [key: string]: string | number | boolean | undefined;
}

export class LiveFeedDO {
  private clients = new Map<string, SSEClient>();
  private events: LiveFeedEvent[] = [];
  private lastGraph: WorkGraph | null = null;
  private feedType = '';
  private feedId = '';
  private encoder = new TextEncoder();
  private initialized = false;
  private errorStreak = 0;
  private pollCount = 0;
  private lastPollMs = 0;
  private seq = 0;
  /** Viewer id for user-scoped feeds, from the edge's verified header. */
  private viewerId: string | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveFeedEnv
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Structured logging. Flat, serializable, same field names as the widget
  // logger so `feedType`+`feedId` joins a browser session to a worker log.
  // ──────────────────────────────────────────────────────────────────────────
  private log(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
    this.seq += 1;
    const record = {
      ts: Date.now(),
      seq: this.seq,
      level,
      component: 'live-feed-do',
      event,
      feedType: this.feedType,
      feedId: this.feedId,
      clients: this.clients.size,
      ...fields,
    };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const match = url.pathname.match(FEED_ROUTE_PATTERN);
    if (!match || request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const feedType = match[1]!;
    const feedId = match[2]!;

    if (!this.initialized) {
      this.feedType = feedType;
      this.feedId = feedId;
      this.initialized = true;
    }
    // Set by authHandler from the verified stream token. The edge strips any
    // inbound copy first, so this is not caller-controlled.
    const viewer = request.headers.get(FEED_VIEWER_HEADER);
    if (viewer) this.viewerId = viewer;

    return this.handleStream(request, feedType, feedId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SSE stream
  // ──────────────────────────────────────────────────────────────────────────
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

    this.log('info', 'client_connected', { clientId, since });

    // A reconnecting client gets the events it missed. A fresh client gets a
    // full snapshot rather than a replay of deltas it has no base for.
    if (since > 0 && this.events.length > 0) {
      for (const event of this.events.filter((candidate) => candidate.ts > since)) {
        if (!(await this.writeTo(writer, event))) {
          return new Response(readable, { headers: sseHeaders() });
        }
      }
    } else if (this.lastGraph) {
      await this.writeTo(writer, {
        type: 'snapshot',
        feedType,
        feedId,
        data: this.lastGraph,
        ts: Date.now(),
      });
    }

    // Nothing cached yet — poll once so the first paint is real data rather
    // than a spinner waiting out a full alarm interval.
    if (!this.lastGraph) {
      try {
        const event = await this.poll(feedType, feedId);
        if (event) await this.writeTo(writer, event);
      } catch (error) {
        await this.writeTo(writer, this.errorEvent(error));
      }
    }

    const heartbeatTimer = setInterval(() => {
      if (!this.clients.has(clientId)) {
        clearInterval(heartbeatTimer);
        return;
      }
      // A comment frame keeps intermediaries from closing an idle stream and
      // feeds the client's heartbeat watchdog.
      writer.write(this.encoder.encode(': heartbeat\n\n')).catch(() => {
        clearInterval(heartbeatTimer);
        this.dropClient(clientId, 'heartbeat_write_failed');
      });
    }, HEARTBEAT_MS);

    this.clients.set(clientId, { writer, connectedAt: Date.now(), heartbeatTimer });

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.scheduleNextPoll();
    }

    request.signal.addEventListener('abort', () => {
      this.dropClient(clientId, 'client_aborted');
    });

    return new Response(readable, { headers: sseHeaders() });
  }

  private dropClient(clientId: string, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    clearInterval(client.heartbeatTimer);
    client.writer.close().catch(() => {});
    this.clients.delete(clientId);
    this.log('info', 'client_disconnected', {
      clientId,
      reason,
      sessionMs: Date.now() - client.connectedAt,
    });
  }

  private async writeTo(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    event: LiveFeedEvent
  ): Promise<boolean> {
    try {
      await writer.write(this.sseChunk(event));
      return true;
    } catch {
      writer.close().catch(() => {});
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Alarm loop
  // ──────────────────────────────────────────────────────────────────────────
  async alarm(): Promise<void> {
    if (this.clients.size === 0) {
      // Let the alarm lapse; the next connection restarts it. Polling a feed
      // nobody is watching is the single largest avoidable cost here.
      this.log('info', 'alarm_idle_stop', {});
      return;
    }

    try {
      const event = await this.poll(this.feedType, this.feedId);
      if (event) await this.fanOut(event);
    } catch (error) {
      this.errorStreak += 1;
      const event = this.errorEvent(error);
      this.log(this.errorStreak >= ERROR_STREAK_LIMIT ? 'error' : 'warn', 'poll_failed', {
        streak: this.errorStreak,
        message: event.type === 'error' ? event.message : undefined,
      });
      await this.fanOut(event).catch(() => {});
    }

    if (this.clients.size > 0) await this.scheduleNextPoll();
  }

  private async scheduleNextPoll(): Promise<void> {
    const feed = getFeed(this.feedType);
    let delay = feed ? cadenceFor(feed, this.lastGraph) : 10_000;
    // Back off the poll rate while upstream is failing, so a degraded OrgX API
    // is not also absorbing a fan-out's worth of retries.
    if (this.errorStreak > 0) {
      delay = Math.min(delay * Math.pow(2, Math.min(this.errorStreak, 4)), 120_000);
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Upstream poll → normalize → diff
  // ──────────────────────────────────────────────────────────────────────────
  private async poll(feedType: string, feedId: string): Promise<LiveFeedEvent | null> {
    const feed = getFeed(feedType);
    if (!feed) {
      this.log('error', 'unknown_feed_type', {});
      return null;
    }

    // Path only — callOrgxApiRaw owns the origin, so a feed cannot pin itself to
    // the primary and miss the configured fallback.
    const apiPath = feed.buildUrl(feedId, '');

    const startedAt = Date.now();
    // Routing through callOrgxApiRaw rather than a bare fetch buys the signed
    // actor token (required for user-scoped upstreams), the fallback origin,
    // and the shared timeout policy. The first version hand-rolled the service
    // key here and got none of that.
    const response = await callOrgxApiRaw(
      this.env,
      apiPath,
      { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
      {
        accept: 'application/json',
        ...(feed.scope === 'user' && this.viewerId ? { userId: this.viewerId } : {}),
      }
    );
    const latencyMs = Date.now() - startedAt;
    this.pollCount += 1;
    this.lastPollMs = latencyMs;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw Object.assign(new Error(`API ${response.status}: ${body.slice(0, 200)}`), {
        // 4xx other than 429 will not fix themselves on retry.
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const raw = await response.json();
    const graph = feed.normalize(raw, feedId);
    const ts = Date.now();
    this.errorStreak = 0;

    const isFirst = this.lastGraph === null;
    const delta = diffGraphs(this.lastGraph, graph);
    this.lastGraph = graph;

    if (isFirst) {
      const event: LiveFeedEvent = { type: 'snapshot', feedType, feedId, data: graph, ts };
      this.remember(event);
      this.log('info', 'snapshot', {
        latencyMs,
        nodes: graph.nodes.length,
        running: graph.summary.running,
        blocked: graph.summary.blocked,
      });
      return event;
    }

    if (!delta) {
      this.log('info', 'poll_unchanged', { latencyMs, polls: this.pollCount });
      return null;
    }

    const event: LiveFeedEvent = { type: 'delta', feedType, feedId, data: delta, ts };
    this.remember(event);
    this.log('info', 'delta', {
      latencyMs,
      changed: delta.changed.length,
      removed: delta.removed.length,
      running: delta.summary.running,
      blocked: delta.summary.blocked,
    });
    return event;
  }

  private remember(event: LiveFeedEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_STORED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_STORED_EVENTS);
    }
  }

  private errorEvent(error: unknown): LiveFeedEvent {
    const retryable =
      error && typeof error === 'object' && 'retryable' in error
        ? Boolean((error as { retryable: unknown }).retryable)
        : true;
    return {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      retryable,
      ts: Date.now(),
    };
  }

  private async fanOut(event: LiveFeedEvent): Promise<void> {
    const chunk = this.sseChunk(event);
    const dead: string[] = [];
    // Writes go out concurrently: a single slow consumer should not delay the
    // rest of the fan-out behind it.
    await Promise.all(
      Array.from(this.clients.entries()).map(async ([id, client]) => {
        try {
          await client.writer.write(chunk);
        } catch {
          clearInterval(client.heartbeatTimer);
          dead.push(id);
        }
      })
    );
    for (const id of dead) {
      this.clients.delete(id);
      this.log('warn', 'client_write_failed', { clientId: id });
    }
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
