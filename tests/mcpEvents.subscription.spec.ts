import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';

import {
  EventError,
  decodeCursor,
  encodeCursor,
  subscriptionId,
  type ApprovalEvent,
  type EventPrincipal,
  type Subscription,
} from '../src/events/contracts';
import {
  ApprovalSubscription,
  assertReference,
  type EventDependencies,
  type EventStorage,
  type LedgerReference,
} from '../src/events/subscription';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const WORKSPACE_A = '00000000-0000-4000-8000-000000000001';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000002';
const OWNER_A = '00000000-0000-4000-8000-000000000011';
const OWNER_B = '00000000-0000-4000-8000-000000000012';
const EVENT_ONE = '00000000-0000-4000-8000-000000000101';
const EVENT_TWO = '00000000-0000-4000-8000-000000000102';
const APPROVAL_ONE = '00000000-0000-4000-8000-000000000201';
const APPROVAL_TWO = '00000000-0000-4000-8000-000000000202';
const URL = 'https://callbacks.example.test/events';
const SECRET_A = `whsec_${btoa('a'.repeat(32))}`;
const SECRET_B = `whsec_${btoa('b'.repeat(32))}`;
const CURSOR_KEY = 'test cursor signing key';
const STATE_KEY = 'subscription:v1';

const principalA: EventPrincipal = {
  userId: 'oauth-user-a',
  orgxUserId: OWNER_A,
  grantId: 'grant-a',
  clientId: 'client-a',
};
const principalB: EventPrincipal = {
  userId: 'oauth-user-b',
  orgxUserId: OWNER_B,
  grantId: 'grant-b',
  clientId: 'client-b',
};

class DurableMemoryStorage implements EventStorage {
  private values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function reference(overrides: Partial<LedgerReference> = {}): LedgerReference {
  return {
    id: EVENT_ONE,
    globalSequence: 10,
    workspaceId: WORKSPACE_A,
    ownerId: OWNER_A,
    aggregateType: 'decision',
    aggregateId: APPROVAL_ONE,
    eventType: 'approval.requested',
    occurredAtCanonical: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function createHarness(options: {
  storage?: EventStorage;
  authorized?: EventDependencies['authorized'];
  read?: EventDependencies['read'];
  post?: EventDependencies['post'];
  now?: () => number;
} = {}) {
  const storage = options.storage ?? new DurableMemoryStorage();
  const clock = { value: NOW };
  const post = options.post ?? vi.fn(async (_url, body) => {
    const payload = JSON.parse(body) as { type?: string; challenge?: string };
    return payload.type === 'verification'
      ? Response.json({ challenge: payload.challenge })
      : new Response(null, { status: 204 });
  });
  const authorized = options.authorized ?? vi.fn(async () => true);
  const read = options.read ?? vi.fn(async () => []);
  const now = options.now ?? (() => clock.value);
  const deps: EventDependencies = {
    storage,
    post,
    authorized,
    read,
    cursorKey: CURSOR_KEY,
    now,
  };
  return {
    storage,
    post,
    authorized,
    read,
    clock,
    engine: new ApprovalSubscription(deps),
    freshEngine: () => new ApprovalSubscription(deps),
  };
}

function subscribeParams(overrides: {
  workspaceId?: string;
  url?: string;
  secret?: string;
  cursor?: string;
  ttlMs?: number;
} = {}) {
  return {
    name: 'approval.requested' as const,
    arguments: { workspace_id: overrides.workspaceId ?? WORKSPACE_A },
    delivery: { mode: 'webhook' as const, url: overrides.url ?? URL, secret: overrides.secret ?? SECRET_A },
    ...(overrides.cursor ? { cursor: overrides.cursor } : {}),
    ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }),
  };
}

function stored(storage: EventStorage): Promise<Subscription | undefined> {
  return storage.get<Subscription>(STATE_KEY);
}

describe('approval event subscription state and delivery', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('challenges once per unchanged subscription and persists across engine restart', async () => {
    const harness = createHarness();
    const first = await harness.engine.subscribe(principalA, subscribeParams({ ttlMs: 60_000 }));
    const firstState = await stored(harness.storage);
    const refreshed = await harness.freshEngine().subscribe(principalA, subscribeParams({ ttlMs: 120_000 }));

    expect(refreshed.id).toBe(first.id);
    expect((harness.post as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((await stored(harness.storage))?.expiresAt).toBe(NOW + 120_000);
    expect((await harness.freshEngine().tick())).toBe(NOW + 30_000);
    expect((await stored(harness.storage))?.afterSequence).toBe(firstState?.afterSequence);
  });

  it('keeps the approval notification to stable references and excludes private details', async () => {
    const secretBody = 'private approval rationale and artifact contents';
    const read = vi.fn(async () => [
      reference({ ...( { privateBody: secretBody } as Partial<LedgerReference> & Record<string, unknown> ) }),
    ]);
    const post = vi.fn(async (_url: string, body: string) => {
      const payload = JSON.parse(body) as { type?: string; challenge?: string };
      return payload.type === 'verification'
        ? Response.json({ challenge: payload.challenge })
        : new Response(null, { status: 204 });
    });
    const harness = createHarness({ read, post });
    await harness.engine.subscribe(principalA, subscribeParams());
    await harness.engine.tick();

    const deliveryCall = post.mock.calls.find(([, body]) => JSON.parse(body).type !== 'verification');
    expect(deliveryCall).toBeDefined();
    const body = deliveryCall?.[1] as string;
    expect(JSON.parse(body)).toEqual({
      eventId: EVENT_ONE,
      name: 'approval.requested',
      timestamp: new Date(NOW).toISOString(),
      data: { workspace_id: WORKSPACE_A, approval_id: APPROVAL_ONE, ledger_event_id: EVENT_ONE },
      cursor: expect.any(String),
    });
    expect(body).not.toContain(secretBody);
    const persisted = await stored(harness.storage);
    expect(persisted).toMatchObject({ afterSequence: 10 });
    expect(persisted?.pending).toBeUndefined();
  });

  it('rejects a second tenant/workspace from reusing a grant-bound object', async () => {
    const harness = createHarness();
    await harness.engine.subscribe(principalA, subscribeParams());

    await expect(
      harness.freshEngine().subscribe(principalB, subscribeParams({ workspaceId: WORKSPACE_B }))
    ).rejects.toMatchObject({ code: -32001, reason: 'access_denied' });
    expect(harness.authorized).toHaveBeenLastCalledWith(principalB, WORKSPACE_B);
  });

  it('rechecks current authorization before every alarm and deletes revoked state', async () => {
    let allowed = true;
    const authorized = vi.fn(async () => allowed);
    const harness = createHarness({ authorized });
    await harness.engine.subscribe(principalA, subscribeParams());
    allowed = false;

    await expect(harness.freshEngine().tick()).resolves.toBeNull();
    expect(await stored(harness.storage)).toBeUndefined();
  });

  it('expires bounded TTL state even after a worker restart', async () => {
    const harness = createHarness();
    await harness.engine.subscribe(principalA, subscribeParams({ ttlMs: 1_000_000_000 }));
    expect((await stored(harness.storage))?.expiresAt).toBe(NOW + 24 * 60 * 60 * 1000);
    harness.clock.value = NOW + 24 * 60 * 60 * 1000;

    await expect(harness.freshEngine().tick()).resolves.toBeNull();
    expect(await stored(harness.storage)).toBeUndefined();
  });

  it('rotates secrets only after a fresh challenge and accepts old signatures for five minutes', async () => {
    const post = vi.fn(async (_url: string, body: string, headers: Record<string, string>) => {
      const payload = JSON.parse(body) as { type?: string; challenge?: string };
      if (payload.type === 'verification') return Response.json({ challenge: payload.challenge });
      const parts = headers['webhook-signature'].split(' ');
      expect(parts).toHaveLength(2);
      new Webhook(SECRET_A).verify(body, headers);
      new Webhook(SECRET_B).verify(body, headers);
      return new Response(null, { status: 204 });
    });
    const harness = createHarness({ post, read: vi.fn(async () => [reference()]) });
    await harness.engine.subscribe(principalA, subscribeParams());
    await harness.freshEngine().subscribe(principalA, subscribeParams({ secret: SECRET_B }));
    expect((await stored(harness.storage))?.previousSecret).toBe(SECRET_A);
    await harness.freshEngine().tick();

    const calls = post.mock.calls;
    expect(calls.filter(([, body]) => JSON.parse(body).type === 'verification')).toHaveLength(2);
    expect(calls.some(([, body]) => JSON.parse(body).type !== 'verification')).toBe(true);
  });

  it('retries the same event ID and byte-identical body with a fresh signed timestamp', async () => {
    const deliveryAttempts: Array<{ body: string; headers: Record<string, string> }> = [];
    const post = vi.fn(async (_url: string, body: string, headers: Record<string, string>) => {
      const payload = JSON.parse(body) as { type?: string; challenge?: string };
      if (payload.type === 'verification') return Response.json({ challenge: payload.challenge });
      deliveryAttempts.push({ body, headers });
      return new Response(null, { status: deliveryAttempts.length === 1 ? 503 : 204 });
    });
    const harness = createHarness({ post, read: vi.fn(async () => [reference()]) });
    await harness.engine.subscribe(principalA, subscribeParams());
    await harness.engine.tick();
    harness.clock.value += 30_001;
    await harness.freshEngine().tick();

    expect(deliveryAttempts).toHaveLength(2);
    expect(deliveryAttempts[1]?.body).toBe(deliveryAttempts[0]?.body);
    expect(deliveryAttempts[1]?.headers['webhook-id']).toBe(EVENT_ONE);
    expect(deliveryAttempts[1]?.headers['webhook-timestamp']).not.toBe(deliveryAttempts[0]?.headers['webhook-timestamp']);
    expect(new Webhook(SECRET_A).verify(deliveryAttempts[0]!.body, deliveryAttempts[0]!.headers)).toBeDefined();
    expect(new Webhook(SECRET_A).verify(deliveryAttempts[1]!.body, deliveryAttempts[1]!.headers)).toBeDefined();
  });

  it('does not skip an earlier failure across refresh; the next event waits for its acknowledgement', async () => {
    const rows = [reference(), reference({ id: EVENT_TWO, aggregateId: APPROVAL_TWO, globalSequence: 12 })];
    const delivered: Array<{ id: string; timestamp: string; body: string }> = [];
    let failFirst = true;
    const post = vi.fn(async (_url: string, body: string, headers: Record<string, string>) => {
      const payload = JSON.parse(body) as ApprovalEvent & { type?: string; challenge?: string };
      if ((payload as { type?: string }).type === 'verification') return Response.json({ challenge: (payload as { challenge?: string }).challenge });
      delivered.push({ id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], body });
      if (failFirst) { failFirst = false; return new Response(null, { status: 503 }); }
      return new Response(null, { status: 204 });
    });
    const read = vi.fn(async (_principal: EventPrincipal, _workspace: string, after?: number) => rows.filter((row) => row.globalSequence > (after ?? 0)));
    const harness = createHarness({ post, read });
    const initial = await harness.engine.subscribe(principalA, subscribeParams());
    await harness.engine.tick();
    const refreshed = await harness.freshEngine().subscribe(principalA, subscribeParams({ cursor: initial.cursor }));
    expect(refreshed.id).toBe(initial.id);
    harness.clock.value += 30_001;
    await harness.freshEngine().tick();
    await harness.freshEngine().tick();

    expect(delivered.map((attempt) => attempt.id)).toEqual([EVENT_ONE, EVENT_ONE, EVENT_TWO]);
    expect(delivered[0]?.body).toBe(delivered[1]?.body);
    expect(read.mock.calls.map((call) => call[2] ?? 0)).toEqual([0, 10]);
  });

  it.each([410, 413])('blocks permanently on HTTP %s without reading later events', async (status) => {
    const read = vi.fn(async () => [reference(), reference({ id: EVENT_TWO, globalSequence: 12 })]);
    const post = vi.fn(async (_url: string, body: string) => {
      const payload = JSON.parse(body) as { type?: string; challenge?: string };
      return payload.type === 'verification'
        ? Response.json({ challenge: payload.challenge })
        : new Response(null, { status });
    });
    const harness = createHarness({ post, read });
    await harness.engine.subscribe(principalA, subscribeParams());

    await expect(harness.engine.tick()).resolves.toBeNull();
    expect((await stored(harness.storage))?.status).toBe('blocked');
    await expect(harness.freshEngine().tick()).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('blocks after six bounded transient failures and uses capped exponential retry', async () => {
    const post = vi.fn(async (_url: string, body: string) => {
      const payload = JSON.parse(body) as { type?: string; challenge?: string };
      return payload.type === 'verification'
        ? Response.json({ challenge: payload.challenge })
        : new Response(null, { status: 503 });
    });
    const harness = createHarness({ post, read: vi.fn(async () => [reference()]) });
    await harness.engine.subscribe(principalA, subscribeParams());
    const scheduled: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const at = await harness.freshEngine().tick();
      if (at !== null) {
        scheduled.push(at);
        harness.clock.value = at;
      }
    }

    const state = await stored(harness.storage);
    expect(state?.status).toBe('blocked');
    expect(state?.attempts).toBe(6);
    expect(scheduled.at(-1)! - NOW).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('rejects malformed, expired, cross-subscription, and ahead-of-delivery cursors', async () => {
    const harness = createHarness();
    const result = await harness.engine.subscribe(principalA, subscribeParams());
    const state = await stored(harness.storage);
    const otherId = await subscriptionId(principalB, WORKSPACE_A, URL);
    const foreignCursor = await encodeCursor(otherId, 0, CURSOR_KEY, NOW);
    const expired = await encodeCursor(result.id as string, 0, CURSOR_KEY, NOW - 24 * 60 * 60 * 1000 - 1);
    const ahead = await encodeCursor(result.id as string, (state?.afterSequence ?? 0) + 1, CURSOR_KEY, NOW);
    const tampered = `${result.cursor as string}x`;

    for (const cursor of [foreignCursor, expired, tampered]) {
      await expect(harness.freshEngine().subscribe(principalA, subscribeParams({ cursor })))
        .rejects.toMatchObject({ code: -32602, reason: 'invalid_or_expired_cursor' });
    }
    await expect(harness.freshEngine().subscribe(principalA, subscribeParams({ cursor: ahead })))
      .rejects.toMatchObject({ code: -32602, reason: 'cursor_ahead_of_delivery' });
  });

  it('rejects unsubscribe from a different deterministic subscription identity', async () => {
    const harness = createHarness();
    await harness.engine.subscribe(principalA, subscribeParams());
    await expect(harness.freshEngine().unsubscribe('sub_wrong'))
      .rejects.toMatchObject({ code: -32001, reason: 'access_denied' });
    expect(await stored(harness.storage)).toBeDefined();
  });
});

describe('event cursor and ledger reference boundaries', () => {
  it('binds signed cursors to one subscription, bounds sequence values, and rejects expired cursors', async () => {
    const id = await subscriptionId(principalA, WORKSPACE_A, URL);
    const cursor = await encodeCursor(id, 42, CURSOR_KEY, NOW);
    await expect(decodeCursor(cursor, id, CURSOR_KEY, NOW)).resolves.toBe(42);
    await expect(decodeCursor(cursor, 'another-subscription', CURSOR_KEY, NOW))
      .rejects.toMatchObject({ code: -32602, reason: 'invalid_or_expired_cursor' });
    await expect(decodeCursor(cursor, id, CURSOR_KEY, NOW + 24 * 60 * 60 * 1000 + 1))
      .rejects.toMatchObject({ code: -32602, reason: 'invalid_or_expired_cursor' });
  });

  it.each([
    ['foreign workspace', { workspaceId: WORKSPACE_B }],
    ['foreign owner', { ownerId: OWNER_B }],
    ['wrong event name', { eventType: 'approval.resolved' }],
    ['wrong aggregate type', { aggregateType: 'artifact' }],
    ['duplicate or old sequence', { globalSequence: 10 }],
    ['invalid event reference UUID', { id: 'not-a-uuid' }],
    ['invalid timestamp', { occurredAtCanonical: 'yesterday' }],
  ])('rejects an invalid ledger reference (%s)', (_label, overrides) => {
    expect(() => assertReference(reference(overrides as Partial<LedgerReference>), {
      workspaceId: WORKSPACE_A,
      principal: principalA,
    }, 10)).toThrowError(EventError);
  });
});
