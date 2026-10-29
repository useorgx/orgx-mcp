import { z } from 'zod';

export const EVENT_NAME = 'approval.requested';
export const eventArguments = z.object({ workspace_id: z.string().uuid() }).strict();
const deliveryIdentity = z.object({ mode: z.literal('webhook'), url: z.string().max(2048) }).strict();
export const subscribeParams = z.object({
  name: z.literal(EVENT_NAME),
  arguments: eventArguments,
  delivery: deliveryIdentity.extend({ secret: z.string().max(100) }),
  cursor: z.string().max(512).nullable().optional(),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  _meta: z.record(z.unknown()).optional(),
}).strict();
export const unsubscribeParams = z.object({
  name: z.literal(EVENT_NAME), arguments: eventArguments, delivery: deliveryIdentity,
  _meta: z.record(z.unknown()).optional(),
}).strict();
export type SubscribeParams = z.infer<typeof subscribeParams>;
export type UnsubscribeParams = z.infer<typeof unsubscribeParams>;

export const approvalEventDefinition = {
  name: EVENT_NAME,
  description: 'An approval was requested in an owned workspace. Contains stable ledger and approval references; fetch authorized state before acting.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object', properties: { workspace_id: { type: 'string', format: 'uuid' } },
    required: ['workspace_id'], additionalProperties: false,
  },
  payloadSchema: {
    type: 'object', properties: {
      workspace_id: { type: 'string', format: 'uuid' },
      approval_id: { type: 'string', format: 'uuid' },
      ledger_event_id: { type: 'string', format: 'uuid' },
    },
    required: ['workspace_id', 'approval_id', 'ledger_event_id'], additionalProperties: false,
  },
};

export interface EventPrincipal {
  userId: string;
  orgxUserId: string;
  grantId: string;
  clientId: string;
}
export interface ApprovalEvent {
  eventId: string;
  name: typeof EVENT_NAME;
  timestamp: string;
  data: { workspace_id: string; approval_id: string; ledger_event_id: string };
  cursor: string;
}
export interface Subscription {
  id: string;
  principal: EventPrincipal;
  workspaceId: string;
  url: string;
  secret: string;
  previousSecret?: string;
  rotationUntil?: number;
  expiresAt: number;
  afterSequence: number;
  attempts: number;
  retryAt: number;
  status: 'active' | 'blocked';
  // Only one minimal pending notification, never an entity mirror or private body.
  pending?: ApprovalEvent;
}

export class EventError extends Error {
  constructor(public code: number, public reason: string) { super(reason); }
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function subscriptionId(principal: EventPrincipal, workspaceId: string, url: string): Promise<string> {
  // Grant isolation makes disconnecting one installation independent of another.
  return `sub_${await digest(JSON.stringify([principal.userId, principal.orgxUserId, principal.grantId, principal.clientId, EVENT_NAME, { workspace_id: workspaceId }, url]))}`;
}

const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export async function encodeCursor(subId: string, sequence: number, key: string, now: number): Promise<string> {
  const payload = btoa(JSON.stringify({ v: 1, s: subId, q: sequence, t: now }));
  return `${payload}.${await cursorMac(payload, key)}`;
}
export async function decodeCursor(cursor: string, subId: string, key: string, now: number): Promise<number> {
  try {
    const [payload, signature, extra] = cursor.split('.');
    if (extra || !signature || !constantTimeEqual(signature, await cursorMac(payload, key))) throw new Error();
    const value = JSON.parse(atob(payload));
    if (value.v !== 1 || value.s !== subId || !Number.isSafeInteger(value.q) || value.q < 0 ||
        !Number.isSafeInteger(value.t) || value.t > now || now - value.t > REPLAY_WINDOW_MS) throw new Error();
    return value.q;
  } catch { throw new EventError(-32602, 'invalid_or_expired_cursor'); }
}
async function cursorMac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))));
}
export function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}
