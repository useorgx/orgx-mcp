import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { INLINE_TOOL_CONTRACTS } from '../src/contractTools';
import { _clearOrgxApiCachesForTests, callOrgxApiRaw } from '../src/orgxApi';
import {
  resolveSessionUserEmail,
  resolveSessionUserId,
} from '../src/sessionIdentity';

/**
 * Regression suite for the caller-supplied `user_id` impersonation hole.
 *
 * Before this fix, six tools took a `user_id` argument and `resolveUserId()`
 * preferred it over the authenticated session. That value was forwarded to the
 * OrgX API as `X-Orgx-User-Id` and signed into `X-Orgx-Actor-Token` behind the
 * service key, so any authenticated MCP session could read another user's
 * plan/usage, start a checkout in their name, read/write their entity comments,
 * and save artifacts as them — with the signature attesting to the lie.
 *
 * These tests lock every link of that chain shut:
 *   1. the argument no longer exists in the tool schemas (and is stripped by
 *      zod even when a caller sends it anyway),
 *   2. identity resolution has no override parameter to pass it to, and
 *   3. the outgoing headers/actor token carry the session id, not the argument.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
const catalog = JSON.parse(
  readFileSync(resolve(root, 'docs/generated/tool-catalog.json'), 'utf8')
) as {
  tools: Array<{ id: string; inputSchema: { properties?: Record<string, unknown> } }>;
};

const SESSION_USER = 'user_session_owner';
const SESSION_EMAIL = 'owner@example.com';
const SESSION_ORGX_UUID = '5c52c8ca-c1d0-48cc-a177-9cf1ac2c5b06';
const VICTIM_USER = 'user_someone_else';

/** The six tools that used to accept a caller-supplied identity override. */
const FORMERLY_OVERRIDABLE_TOOLS = [
  'account_status',
  'account_upgrade',
  'account_usage_report',
  'comment_on_entity',
  'list_entity_comments',
  'save_artifact',
] as const;

function registrationBlock(toolId: string): string {
  const pattern = new RegExp(
    `registerTool\\(\\s*'${toolId}'([\\s\\S]*?)(?=registerTool\\(|registerAppTool\\(|private registerResources\\()`,
    'm'
  );
  const match = pattern.exec(indexSource);
  expect(match, `Missing registration block for ${toolId}`).not.toBeNull();
  return match![1];
}

function decodeActorToken(token: string) {
  const [payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    sub: string;
    email?: string;
    orgx_user_id?: string;
  };
}

describe('caller-supplied identity cannot override the session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _clearOrgxApiCachesForTests();
  });

  it('removes user_id from every affected tool schema in the source of truth', () => {
    for (const toolId of FORMERLY_OVERRIDABLE_TOOLS) {
      const block = registrationBlock(toolId);
      expect(block, `${toolId} still declares a user_id parameter`).not.toMatch(
        /^\s*user_id:\s*z\./m
      );
      expect(block, `${toolId} still reads args.user_id`).not.toContain(
        'args.user_id'
      );
    }
  });

  it('never passes an argument into identity resolution', () => {
    // The helpers take no override parameter at all...
    expect(indexSource).toContain('private resolveUserId() {');
    expect(indexSource).toContain('private assertUserId() {');
    expect(resolveSessionUserId.length).toBe(1); // (source) — no explicit id arg
    expect(resolveSessionUserEmail.length).toBe(1);

    // ...and no call site anywhere tries to supply one.
    const callsWithArguments = indexSource.match(
      /this\.(resolveUserId|assertUserId)\(\s*[^)\s]/g
    );
    expect(callsWithArguments, 'identity resolution called with an argument').toBeNull();
  });

  it('stops advertising the parameter in the generated tool catalog', () => {
    for (const toolId of FORMERLY_OVERRIDABLE_TOOLS) {
      const entry = catalog.tools.find((tool) => tool.id === toolId);
      if (!entry) continue;
      expect(
        Object.keys(entry.inputSchema?.properties ?? {}),
        `${toolId} still advertises user_id in the catalog`
      ).not.toContain('user_id');
    }
  });

  it('strips a user_id a caller sends anyway before the handler sees it (account_status)', () => {
    const schema = z.object(INLINE_TOOL_CONTRACTS.account_status.inputSchema);
    const parsed = schema.parse({ user_id: VICTIM_USER });
    expect(parsed).not.toHaveProperty('user_id');
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('strips a user_id a caller sends anyway before the handler sees it (comment_on_entity)', () => {
    const schema = z.object(INLINE_TOOL_CONTRACTS.comment_on_entity.inputSchema);
    const parsed = schema.parse({
      entity_type: 'task',
      entity_id: '21dcfaa6-12c8-4d02-8ca3-8de4c5b57ee5',
      body: 'ship it',
      user_id: VICTIM_USER,
    });
    expect(parsed).not.toHaveProperty('user_id');
    expect(parsed.entity_id).toBe('21dcfaa6-12c8-4d02-8ca3-8de4c5b57ee5');
  });

  it('resolves the session user even when the arguments name someone else', () => {
    const session = {
      props: {
        userId: SESSION_USER,
        email: SESSION_EMAIL,
        orgxUserId: SESSION_ORGX_UUID,
      },
      sessionAuth: { userId: 'user_stale_session' },
      // A hostile argument bag hanging off the same object must be ignored.
      user_id: VICTIM_USER,
    };

    expect(resolveSessionUserId(session)).toBe(SESSION_USER);
    expect(resolveSessionUserEmail(session)).toBe(SESSION_EMAIL);
    expect(
      resolveSessionUserId({ props: null, sessionAuth: { userId: 'user_persisted' } })
    ).toBe('user_persisted');
    expect(resolveSessionUserId({ props: null, sessionAuth: null })).toBeNull();
  });

  for (const toolId of ['account_status', 'comment_on_entity'] as const) {
    it(`sends the session identity, not the caller's, on the wire (${toolId})`, async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ ok: true }))
      );
      vi.stubGlobal('fetch', fetchMock);

      // Exactly what the hardened handler does: parse the caller's arguments
      // through the registered schema, then resolve identity from the session.
      const schema = z.object(INLINE_TOOL_CONTRACTS[toolId].inputSchema);
      const callerArgs =
        toolId === 'account_status'
          ? { user_id: VICTIM_USER }
          : {
              entity_type: 'task' as const,
              entity_id: '21dcfaa6-12c8-4d02-8ca3-8de4c5b57ee5',
              body: 'ship it',
              user_id: VICTIM_USER,
            };
      const parsedArgs = schema.parse(callerArgs) as Record<string, unknown>;
      expect(parsedArgs.user_id).toBeUndefined();

      const session = {
        props: {
          userId: SESSION_USER,
          email: SESSION_EMAIL,
          orgxUserId: SESSION_ORGX_UUID,
        },
        sessionAuth: {},
      };

      await callOrgxApiRaw(
        {
          ORGX_API_URL: 'https://api.useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-test',
          ORGX_INTERNAL_SECRET: 'test-internal-secret',
        },
        '/api/billing/usage',
        undefined,
        {
          userId: resolveSessionUserId(session),
          userEmail: resolveSessionUserEmail(session),
          orgxUserId: session.props.orgxUserId,
        }
      );

      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get('x-orgx-user-id')).toBe(SESSION_USER);

      const actor = decodeActorToken(headers.get('x-orgx-actor-token')!);
      expect(actor.sub).toBe(SESSION_USER);
      expect(actor.email).toBe(SESSION_EMAIL);

      // The victim's id must appear nowhere in the outgoing request.
      const serializedHeaders = JSON.stringify([...headers.entries()]);
      expect(serializedHeaders).not.toContain(VICTIM_USER);
      expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain(VICTIM_USER);
    });
  }

  it('keeps owner_id out of the identity headers on entity creation paths', () => {
    // owner_id/user_id may still name the OWNER of a created entity, but the
    // acting identity forwarded to the API must always be the session user.
    for (const marker of [
      'const ownerId = args.owner_id ?? args.user_id ?? resolvedUserId ?? null;',
      'const ownerId = explicitOwnerId ?? resolvedUserId;',
      'const ownerId = explicitOwnerId ?? resolvedUserId ?? null;',
      'const scaffoldActorUserId =',
    ]) {
      expect(indexSource, `missing hardening marker: ${marker}`).toContain(marker);
    }
    expect(indexSource).not.toMatch(/userId:\s*ownerId\b/);
    expect(indexSource).not.toMatch(/userId:\s*ownerId\s*\?\?/);
    expect(indexSource).not.toMatch(/userId:\s*scaffoldOwnerId\b/);
  });
});
