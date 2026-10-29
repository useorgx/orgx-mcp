import {
  type ApprovalEvent, type EventPrincipal, type Subscription, type SubscribeParams,
  EVENT_NAME, EventError, constantTimeEqual, decodeCursor, encodeCursor, subscriptionId,
} from './contracts';
import { callbackUrl, signingKey, webhookSignature, type WebhookPost } from './webhook';

export interface EventStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
}
export interface LedgerReference {
  id: string;
  globalSequence: number;
  workspaceId: string;
  ownerId: string;
  aggregateType: 'decision';
  aggregateId: string;
  eventType: typeof EVENT_NAME;
  occurredAtCanonical: string;
}
export interface EventDependencies {
  storage: EventStorage;
  post: WebhookPost;
  // Must check the exact OAuth grant AND current upstream workspace/owner access.
  authorized: (principal: EventPrincipal, workspaceId: string) => Promise<boolean>;
  read: (principal: EventPrincipal, workspaceId: string, after?: number) => Promise<LedgerReference[]>;
  cursorKey: string;
  now: () => number;
}

const STATE = 'subscription:v1';
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const ROTATION_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 6;

/** Serialized by its owning Durable Object; durable state holds only delivery progress. */
export class ApprovalSubscription {
  constructor(private readonly deps: EventDependencies) {}

  async subscribe(principal: EventPrincipal, params: SubscribeParams): Promise<Record<string, unknown>> {
    const workspaceId = params.arguments.workspace_id;
    const url = callbackUrl(params.delivery.url).href;
    signingKey(params.delivery.secret);
    const id = await subscriptionId(principal, workspaceId, url);
    const now = this.deps.now();
    if (!await this.deps.authorized(principal, workspaceId)) throw new EventError(-32001, 'access_denied');
    const prior = await this.deps.storage.get<Subscription>(STATE);
    if (prior && prior.id !== id) throw new EventError(-32001, 'access_denied');
    const requested = params.cursor ? await decodeCursor(params.cursor, id, this.deps.cursorKey, now) : null;
    // The client cannot advance past unacknowledged delivery, including across refresh.
    if (prior && requested !== null && requested > prior.afterSequence) throw new EventError(-32602, 'cursor_ahead_of_delivery');
    let afterSequence: number;
    if (prior) afterSequence = requested === null ? prior.afterSequence : Math.min(requested, prior.afterSequence);
    else if (requested !== null) afterSequence = requested;
    else {
      const latest = await this.deps.read(principal, workspaceId);
      afterSequence = latest[0]?.globalSequence ?? 0;
    }
    // Bounded cache only inside this grant-bound subscription. Secret replacement is verified anew.
    if (!prior || prior.expiresAt <= now || prior.secret !== params.delivery.secret) {
      await this.verify(url, id, params.delivery.secret);
    }
    const lifetime = Math.min(params.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const state: Subscription = {
      id, principal, workspaceId, url, secret: params.delivery.secret,
      expiresAt: now + lifetime, afterSequence, attempts: prior?.attempts ?? 0,
      retryAt: prior?.retryAt ?? now, status: prior?.status ?? 'active',
      ...(prior?.pending ? { pending: prior.pending } : {}),
      ...(prior && prior.secret !== params.delivery.secret ? { previousSecret: prior.secret, rotationUntil: now + ROTATION_MS } :
        prior?.previousSecret && (prior.rotationUntil ?? 0) > now ? { previousSecret: prior.previousSecret, rotationUntil: prior.rotationUntil } : {}),
    };
    await this.deps.storage.put(STATE, state);
    return { id, refreshBefore: new Date(state.expiresAt).toISOString(), cursor: await encodeCursor(id, afterSequence, this.deps.cursorKey, now), truncated: false };
  }

  async unsubscribe(id: string): Promise<void> {
    const state = await this.deps.storage.get<Subscription>(STATE);
    if (state && state.id !== id) throw new EventError(-32001, 'access_denied');
    await this.deps.storage.delete(STATE);
  }

  /** One delivery per alarm. Never advance the cursor past a failed earlier event. */
  async tick(): Promise<number | null> {
    const state = await this.deps.storage.get<Subscription>(STATE);
    if (!state) return null;
    const now = this.deps.now();
    if (state.expiresAt <= now || !await this.deps.authorized(state.principal, state.workspaceId)) {
      await this.deps.storage.delete(STATE);
      return null;
    }
    if (state.status === 'blocked') return null;
    if (state.retryAt > now) return Math.min(state.retryAt, state.expiresAt);
    if (!state.pending) {
      const rows = await this.deps.read(state.principal, state.workspaceId, state.afterSequence);
      const event = rows[0];
      if (!event) return Math.min(now + 30_000, state.expiresAt);
      assertReference(event, state, state.afterSequence);
      if (now - Date.parse(event.occurredAtCanonical) > MAX_TTL_MS) {
        // Do not silently skip old history. No contract for upstream retention/truncation exists.
        state.status = 'blocked';
        await this.deps.storage.put(STATE, state);
        return null;
      }
      state.pending = {
        eventId: event.id, name: EVENT_NAME, timestamp: event.occurredAtCanonical,
        data: { workspace_id: state.workspaceId, approval_id: event.aggregateId, ledger_event_id: event.id },
        cursor: await encodeCursor(state.id, event.globalSequence, this.deps.cursorKey, now),
      };
      await this.deps.storage.put(STATE, state);
    }
    const body = JSON.stringify(state.pending);
    try {
      const response = await this.send(state, state.pending.eventId, body);
      if (response.ok) {
        const sequence = await decodeCursor(state.pending.cursor, state.id, this.deps.cursorKey, now);
        state.afterSequence = sequence;
        delete state.pending;
        state.attempts = 0;
        state.retryAt = now;
      } else {
        state.attempts++;
        // Permanent failure blocks progress; subsequent events cannot overtake it.
        if (response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) state.status = 'blocked';
      }
      await response.body?.cancel();
    } catch { state.attempts++; }
    if (state.attempts >= MAX_ATTEMPTS) state.status = 'blocked';
    state.retryAt = now + (state.attempts ? Math.min(30_000 * 2 ** (state.attempts - 1), 15 * 60 * 1000) : 1000);
    if ((state.rotationUntil ?? 0) <= now) { delete state.previousSecret; delete state.rotationUntil; }
    await this.deps.storage.put(STATE, state);
    return state.status === 'blocked' ? null : Math.min(state.retryAt, state.expiresAt);
  }

  private async verify(url: string, id: string, secret: string): Promise<void> {
    // Fresh challenge, never persisted or reused; no application data before this succeeds.
    const challenge = crypto.randomUUID();
    const created = this.deps.now();
    const verificationId = `msg_verification_${crypto.randomUUID()}`;
    const body = JSON.stringify({ type: 'verification', challenge });
    try {
      const response = await this.send({ url, id, secret }, verificationId, body);
      if (!response.ok) throw new EventError(-32015, 'challenge_failed');
      const text = await response.text();
      if (text.length > 4096) throw new EventError(-32015, 'challenge_failed');
      const value = JSON.parse(text) as { challenge?: unknown };
      if (typeof value.challenge !== 'string' || !constantTimeEqual(challenge, value.challenge) || this.deps.now() - created > 10_000) throw new EventError(-32015, 'challenge_failed');
    } catch (error) {
      if (error instanceof EventError) throw error;
      throw new EventError(-32015, 'challenge_failed');
    }
  }

  private async send(state: Pick<Subscription, 'url' | 'id' | 'secret' | 'previousSecret' | 'rotationUntil'>, id: string, body: string): Promise<Response> {
    const timestamp = Math.floor(this.deps.now() / 1000);
    let signature = await webhookSignature(state.secret, id, timestamp, body);
    if (state.previousSecret && (state.rotationUntil ?? 0) > this.deps.now()) signature += ` ${await webhookSignature(state.previousSecret, id, timestamp, body)}`;
    return this.deps.post(state.url, body, {
      'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp),
      'webhook-signature': signature, 'X-MCP-Subscription-Id': state.id,
    });
  }
}

export function assertReference(event: LedgerReference, state: Pick<Subscription, 'workspaceId' | 'principal'>, after?: number): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (event.workspaceId !== state.workspaceId || event.ownerId !== state.principal.orgxUserId ||
      event.eventType !== EVENT_NAME || event.aggregateType !== 'decision' || !uuid.test(event.id) || !uuid.test(event.aggregateId) ||
      !Number.isSafeInteger(event.globalSequence) || event.globalSequence <= (after ?? -1) ||
      !Number.isFinite(Date.parse(event.occurredAtCanonical)) || !/(Z|[+-]\d{2}:\d{2})$/.test(event.occurredAtCanonical)) {
    throw new EventError(-32603, 'invalid_ledger_reference');
  }
}
