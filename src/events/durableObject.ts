import { getOAuthApi, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { callOrgxApiJson, type OrgxApiEnv } from '../orgxApi';
import { ApprovalSubscription, assertReference, type LedgerReference } from './subscription';
import { EVENT_NAME, EventError, type EventPrincipal, type Subscription, subscribeParams, subscriptionId, unsubscribeParams } from './contracts';
import { callbackUrl, pinnedWebhookPost } from './webhook';

export interface EventsEnv extends OrgxApiEnv {
  MCP_EVENTS_ENABLED?: string;
  MCP_EVENTS?: DurableObjectNamespace;
  MCP_JWT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

async function ledgerRead(env: EventsEnv, principal: EventPrincipal, workspaceId: string, after?: number): Promise<LedgerReference[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId, event_type: EVENT_NAME, aggregate_type: 'decision', limit: '1' });
  if (after !== undefined) query.set('after_sequence', String(after));
  const response = await callOrgxApiJson(env, `/api/v1/events/stream?${query}`, undefined,
    { userId: principal.userId, orgxUserId: principal.orgxUserId });
  const value = await response.json() as { data?: unknown; meta?: { workspaceId?: string; ordering?: string; delivery?: string } };
  if (!Array.isArray(value.data) || value.meta?.workspaceId !== workspaceId || value.meta.ordering !== (after === undefined ? 'global_sequence_desc' : 'global_sequence_asc')) {
    throw new EventError(-32603, 'invalid_ledger_page');
  }
  if (value.data.length > 1) throw new EventError(-32603, 'invalid_ledger_page');
  return value.data.map((row) => {
    // Discard the private ledger payload at this boundary. Only whitelisted references persist.
    const event = row as LedgerReference;
    assertReference(event, { workspaceId, principal }, after);
    return {
      id: event.id, globalSequence: event.globalSequence, workspaceId: event.workspaceId,
      ownerId: event.ownerId, aggregateType: event.aggregateType, aggregateId: event.aggregateId,
      eventType: event.eventType, occurredAtCanonical: event.occurredAtCanonical,
    };
  });
}

function oauthApi(env: EventsEnv): OAuthHelpers {
  // The supported provider helper works in DO alarms without retaining a bearer.
  return getOAuthApi({ defaultHandler: {}, authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register' }, env);
}

export async function eventAccess(env: EventsEnv, principal: EventPrincipal, workspaceId: string): Promise<boolean> {
  const api = oauthApi(env);
  let cursor: string | undefined;
  let found = false;
  for (let page = 0; page < 2; page++) {
    const grants = await api.listUserGrants(principal.userId, { limit: 1000, ...(cursor ? { cursor } : {}) });
    const grant = grants.items.find((entry) => entry.id === principal.grantId);
    if (grant) {
      found = grant.userId === principal.userId && grant.clientId === principal.clientId && grant.scope.includes('decisions:read') &&
        (grant.expiresAt === undefined || grant.expiresAt * 1000 > Date.now());
      break;
    }
    cursor = grants.cursor;
    if (!cursor) break;
  }
  if (!found) return false;
  try { await ledgerRead(env, principal, workspaceId); return true; }
  catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return false;
    throw error;
  }
}

/** One object per deterministic subscription. Existing SSE DOs have connection-bound
 * state and independent alarms; OAuth KV cannot serialize acknowledgements. No new
 * event database: org_events/outbox remain the canonical producers. */
export class McpEventsDO {
  private queue: Promise<unknown> = Promise.resolve();
  private engine: ApprovalSubscription;
  constructor(private ctx: DurableObjectState, private env: EventsEnv) {
    this.engine = new ApprovalSubscription({
      storage: ctx.storage, post: pinnedWebhookPost, cursorKey: env.MCP_JWT_SECRET,
      now: () => Date.now(), authorized: (principal, workspaceId) => eventAccess(env, principal, workspaceId),
      read: (principal, workspaceId, after) => ledgerRead(env, principal, workspaceId, after),
    });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        if (this.env.MCP_EVENTS_ENABLED !== 'true' || !this.env.MCP_JWT_SECRET) throw new EventError(-32001, 'events_disabled');
        const body = await request.json() as { principal: EventPrincipal; params: unknown };
        let result: Record<string, unknown>;
        if (new URL(request.url).pathname === '/subscribe') {
          result = await this.engine.subscribe(body.principal, subscribeParams.parse(body.params));
          // Arm before returning an accepted subscription; a failed schedule cannot be success.
          await this.ctx.storage.setAlarm(Date.now() + 1000);
        } else if (new URL(request.url).pathname === '/unsubscribe') {
          const params = unsubscribeParams.parse(body.params);
          const id = await subscriptionId(body.principal, params.arguments.workspace_id, callbackUrl(params.delivery.url).href);
          await this.engine.unsubscribe(id);
          await this.ctx.storage.deleteAlarm();
          result = {};
        } else return new Response(null, { status: 404 });
        return Response.json({ result });
      } catch (error) {
        return Response.json({ error: { code: error instanceof EventError ? error.code : -32603, message: 'Event operation failed', data: { reason: error instanceof EventError ? error.reason : 'event_operation_failed' } } });
      }
    });
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      if (this.env.MCP_EVENTS_ENABLED !== 'true') {
        await this.ctx.storage.delete('subscription:v1');
        return;
      }
      try {
        const next = await this.engine.tick();
        if (next !== null) await this.ctx.storage.setAlarm(next);
      } catch {
        // Authority/database outages pause progress; they never advance a cursor.
        const state = await this.ctx.storage.get<Subscription>('subscription:v1');
        if (state && state.expiresAt > Date.now()) await this.ctx.storage.setAlarm(Math.min(Date.now() + 60_000, state.expiresAt));
      }
    });
  }
}
