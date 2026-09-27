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
/** Upper bound on concurrent widgets attached to one feed instance. */
const MAX_CLIENTS = 64;
/** A single stuck consumer must not stall the fan-out for everyone else. */
const CLIENT_WRITE_TIMEOUT_MS = 5_000;

export type LiveFeedEvent =
  | { type: 'snapshot'; feedType: string; feedId: string; data: WorkGraph; ts: number }
  | { type: 'delta'; feedType: string; feedId: string; data: WorkGraphDelta; ts: number }
  | { type: 'error'; message: string; retryable: boolean; ts: number };

type LiveFeedEnv = OrgxApiEnv;

interface SSEClient {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  connectedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval>;
  /**
   * True until backfill has finished. A client joins the broadcast map before
   * its history has been written, so a poll landing mid-replay would interleave
   * a live event between two historical ones — the client would then apply an
   * older event last and silently revert fields, and move its cursor backwards.
   * Live events are queued here instead and flushed once history is complete.
   */
  backfilling: boolean;
  queued: LiveFeedEvent[];
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
  /**
   * The in-flight poll, whatever started it. Guarding only cold starts left the
   * reverse overlap open: an alarm poll issued first could return *after* a
   * newer cold poll and overwrite the graph with older data.
   */
  private firstPoll: Promise<void> | null = null;

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

    // One Durable Object fans out to every widget watching a feed, so an
    // unbounded client set is a denial-of-service surface: a single valid grant
    // can be replayed to open as many streams as the caller likes, each costing
    // a writer and a heartbeat timer.
    if (this.clients.size >= MAX_CLIENTS) {
      this.log('warn', 'client_rejected_at_capacity', { clientId });
      return new Response(
        JSON.stringify({ error: 'feed_at_capacity' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '30',
            ...corsHeaders(),
          },
        }
      );
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    this.log('info', 'client_connected', { clientId, since });

    const heartbeatTimer = setInterval(() => {
      if (!this.clients.has(clientId)) {
        clearInterval(heartbeatTimer);
        return;
      }
      // A named event, not a bare `: comment`. EventSource silently discards
      // comment lines, so a comment heartbeat never reaches the client and its
      // staleness watchdog trips on a perfectly healthy but quiet stream.
      this.writeRaw(writer, `event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`).catch(
        () => {
          clearInterval(heartbeatTimer);
          this.dropClient(clientId, 'heartbeat_write_failed');
        }
      );
    }, HEARTBEAT_MS);

    this.clients.set(clientId, {
      writer,
      connectedAt: Date.now(),
      heartbeatTimer,
      backfilling: true,
      queued: [],
    });

    request.signal.addEventListener('abort', () => {
      this.dropClient(clientId, 'client_aborted');
    });

    // Everything above is synchronous. The backfill below is deliberately NOT
    // awaited: a TransformStream write does not resolve until something reads
    // the readable end, and the readable is only handed to the runtime by the
    // `return` at the bottom. Awaiting a write first deadlocks the request
    // before the response ever exists, so a cold connection never completes.
    this.ctx.waitUntil(this.backfill(clientId, feedType, feedId, since));

    return new Response(readable, { headers: sseHeaders() });
  }

  /**
   * Bring a freshly attached client up to date.
   *
   * Runs after the response is returned, so its writes have a reader. Every
   * client leaves this with a usable base: either a full snapshot, or a replay
   * it can actually apply on top of one it already holds.
   */
  private async backfill(
    clientId: string,
    feedType: string,
    feedId: string,
    since: number
  ): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      // A reconnecting client can only apply a replay if the buffer still
      // reaches back to its cursor. Once events have been evicted there is a
      // hole, and sending the surviving suffix would silently leave removed
      // nodes on screen forever — so fall back to a snapshot.
      const oldest = this.events[0];
      const replayable =
        since > 0 && oldest !== undefined && oldest.ts <= since && this.lastGraph !== null;

      if (replayable) {
        const missed = this.events.filter((candidate) => candidate.ts > since);
        this.log('info', 'replay', { clientId, since, events: missed.length });
        for (const event of missed) {
          if (!(await this.writeTo(client.writer, event))) return;
        }
        return;
      }


      if (since > 0) {
        this.log('info', 'replay_gap_snapshot', {
          clientId,
          since,
          oldest: oldest?.ts,
          buffered: this.events.length,
        });
      }

      // Cold start. Poll only when nothing is cached, and guard the poll so two
      // simultaneous cold connections do not both call upstream — the second
      // poll would return null (nothing changed) and that client would attach
      // with no base at all, then discard every delta that followed.
      if (!this.lastGraph) {
        try {
          await this.ensureFirstGraph(feedType, feedId);
        } catch (error) {
          await this.writeTo(client.writer, this.errorEvent(error));
          return;
        }
      }

      if (this.lastGraph) {
        const snapshotTs = Date.now();
        // Everything queued so far is older than, and contained in, this
        // snapshot. Draining it afterwards would hand the client a newer frame
        // followed by older ones and regress its cursor.
        const superseded = client.queued.length;
        client.queued = client.queued.filter((event) => event.ts > snapshotTs);
        if (superseded > client.queued.length) {
          this.log('info', 'queue_superseded_by_snapshot', {
            clientId,
            dropped: superseded - client.queued.length,
          });
        }
        await this.writeTo(client.writer, {
          type: 'snapshot',
          feedType,
          feedId,
          data: this.lastGraph,
          ts: snapshotTs,
        });
      }
    } catch (error) {
      this.log('warn', 'backfill_failed', {
        clientId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.finishBackfill(clientId);
      // Scheduled only now. Arming the alarm before the cold-start poll settled
      // let the alarm run its own poll first: a client attaching in between got
      // the alarm's graph, then the cold poll replaced lastGraph with a newer
      // one and reported nothing, leaving that client a version behind with no
      // later frame to repair it.
      try {
        if ((await this.ctx.storage.getAlarm()) === null) await this.scheduleNextPoll();
      } catch (error) {
        this.log('warn', 'alarm_schedule_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Mark a client live and drain anything that arrived while it was catching
   * up, preserving order.
   */
  private async finishBackfill(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Drain to empty *before* clearing the flag. Clearing first let a fan-out
    // landing mid-drain write straight to the socket and overtake events still
    // queued behind it — 2, 4, 3 again, which is the whole reason the queue
    // exists. Each awaited write can admit another event, so this loops until
    // the queue is genuinely empty and only then opens the direct path.
    let flushed = 0;
    while (client.queued.length > 0) {
      const event = client.queued.shift()!;
      flushed += 1;
      if (!(await this.writeTo(client.writer, event))) {
        this.dropClient(clientId, 'flush_write_failed');
        return;
      }
    }
    client.backfilling = false;
    if (flushed > 0) this.log('info', 'backfill_flush', { clientId, flushed });
  }

  /**
   * Populate `lastGraph` exactly once, even if several cold clients race.
   * Callers that lose the race await the winner's poll rather than issuing
   * their own, which would come back "unchanged" and leave them baseless.
   */
  private ensureFirstGraph(feedType: string, feedId: string): Promise<void> {
    if (!this.firstPoll) {
      this.firstPoll = this.poll(feedType, feedId)
        .then((event) => {
          // Anyone already live when the cold poll lands must be told, or they
          // sit on whatever the alarm happened to fetch first.
          if (event) return this.fanOut(event);
          return undefined;
        })
        .finally(() => {
          this.firstPoll = null;
        });
    }
    return this.firstPoll;
  }

  private dropClient(clientId: string, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    clearInterval(client.heartbeatTimer);
    // abort, not close: close() waits for writes already queued, so a consumer
    // that stopped reading keeps its writer unsettled and its stream open long
    // after we have forgotten it.
    client.writer.abort(reason).catch(() => {});
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
      await this.writeRaw(writer, `data: ${JSON.stringify(event)}\n\n`);
      return true;
    } catch {
      writer.abort('write_failed').catch(() => {});
      return false;
    }
  }

  /**
   * Write with a deadline. A consumer that has stopped reading leaves its write
   * pending forever; without a timeout one such client stalls the shared
   * fan-out and, with it, the alarm that schedules the next poll for everyone.
   */
  private writeRaw(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    text: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('client_write_timeout'));
      }, CLIENT_WRITE_TIMEOUT_MS);
      writer.write(this.encoder.encode(text)).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      );
    });
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
      // Never poll on top of an in-flight cold start; the second call reports
      // "unchanged" against the first one's result and loses the difference.
      if (this.firstPoll) {
        await this.firstPoll;
        if (this.clients.size > 0) await this.scheduleNextPoll();
        return;
      }
      const inFlight = this.poll(this.feedType, this.feedId);
      this.firstPoll = inFlight.then(() => undefined).finally(() => {
        this.firstPoll = null;
      });
      const event = await inFlight;
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
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    const dead: string[] = [];
    // Concurrent, and each write is deadline-bounded. A consumer that stopped
    // reading — an expired stream whose wrapper closed its output but never
    // cancelled this side — would otherwise leave its write pending forever and
    // hold up the alarm that schedules the next poll for every other watcher.
    await Promise.all(
      Array.from(this.clients.entries()).map(async ([id, client]) => {
        if (client.backfilling) {
          // Still catching up. Queue rather than interleave; finishBackfill
          // drains this in order once history has been written.
          client.queued.push(event);
          return;
        }
        try {
          await this.writeRaw(client.writer, chunk);
        } catch {
          clearInterval(client.heartbeatTimer);
          // Abort, do not just forget. Dropping the map entry alone left the
          // response stream open and unfed: the viewer saw no updates, no
          // heartbeats and no EOF, and the client cap stopped bounding the
          // number of outstanding streams.
          client.writer.abort('client_write_timeout').catch(() => {});
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
