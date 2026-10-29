import 'server-only';

import { NextResponse } from 'next/server';

import { logger } from '@/lib/logger';
import {
  getSupabaseAdmin,
  resolveSupabaseUserIdForExternal,
} from '@/lib/supabase';
import type { ApiContext, ApiHandler } from './apiRoute';
import { jsonError } from '@/lib/server/apiResponse';
import { chunkIds } from '@/lib/server/db/chunkedIn';
import { tryPageAll } from '@/lib/server/db/pageRows';
import { ApiErrorCode } from '@/lib/server/apiErrors';

// Composable authorization wrappers that plug into the existing
// compose(withAuth(), withWorkspaceAccess(), ...)(handler) chain.
//
// Why these exist: the IDOR-class fix in PR #926 was repeated in five
// places, then again in three goal routes. Anywhere the pattern is
// "service-role read by id, then assert workspace_id ∈ caller's set,"
// the answer is the same code. This module ships that code once and
// makes it composable.
//
// Design rules:
//   1. Each wrapper attaches its result to a typed slot on ApiContext
//      (`workspace`, `resource`, `project`). The handler reads the slot
//      it asked for.
//   2. Failure → 404 (not 403) for resource access — leaks zero
//      existence info. 401 only when no caller identity is present.
//   3. Wrappers are independent — `withResourceAccess` does NOT call
//      `withWorkspaceAccess` internally. Compose to fail loud if the
//      caller didn't include both when both are needed.

// The optional `workspace` / `resource` / `project` slots are declared on
// ApiContext directly in lib/server/apiRoute.ts so this module can be a
// pure consumer.

// =============================================================================
// Common helpers
// =============================================================================

export type AuthFailure = { status: 401 | 403 | 404; reason: string };

class WorkspaceAccessLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceAccessLookupError';
  }
}

export async function listAccessibleWorkspaceIds(
  externalUserId: string
): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new WorkspaceAccessLookupError(
      'Workspace authorization database is unavailable'
    );
  }
  // Resolver consults users.external_id AND the user_external_ids mapping —
  // a raw column lookup misses identities from other environments (MCP
  // gateway, second Clerk instance). See 2026-07-03 incident.
  const supabaseUserId =
    (await resolveSupabaseUserIdForExternal(externalUserId, {
      createIfMissing: false,
    })) ?? externalUserId;
  const { data: rows, error } = await admin
    .from('workspaces')
    .select('id')
    .eq('owner_id', supabaseUserId);
  if (error) {
    logger.warn('[routeAuthz] workspace lookup failed', {
      error: error.message,
    });
    throw new WorkspaceAccessLookupError(
      'Workspace authorization lookup failed'
    );
  }
  return new Set((rows ?? []).map((r: { id: string }) => r.id));
}

function readKey(
  source: 'param' | 'query' | 'body',
  key: string,
  ctx: ApiContext,
  body?: unknown,
  req?: Request
): string | null {
  if (source === 'param') {
    const v = ctx.params?.[key];
    return Array.isArray(v) ? v[0] : (v as string | undefined) ?? null;
  }
  if (source === 'query') {
    // Prefer parsed ctx.query (set by withValidation); fall back to parsing
    // the request URL directly so callers don't need withValidation just to
    // read a single param.
    const fromCtx = (ctx.query as Record<string, unknown> | undefined)?.[key];
    if (typeof fromCtx === 'string') return fromCtx;
    if (req) {
      try {
        const v = new URL(req.url).searchParams.get(key);
        if (v != null && v.length > 0) return v;
      } catch {
        // ignore — malformed URL
      }
    }
    return null;
  }
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

// =============================================================================
// withWorkspaceAccess
// =============================================================================

export interface WorkspaceAccessOptions {
  /** Where to read the workspace id from. */
  source?: 'param' | 'query' | 'body';
  /** Key name within the source. Default: `workspace_id`. */
  key?: string;
  /**
   * If true and the source key is missing, fall back to the caller's default
   * workspace (first owned). Default: false — explicit is better than guessed.
   */
  fallbackToDefault?: boolean;
}

/**
 * Asserts the caller owns a workspace and attaches it to ctx.workspace.
 * Compose AFTER withAuth() — needs ctx.userId/externalUserId resolved.
 */
export function withWorkspaceAccess(opts: WorkspaceAccessOptions = {}) {
  const source = opts.source ?? 'body';
  const key = opts.key ?? 'workspace_id';

  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      const externalUserId = ctx.externalUserId ?? ctx.userId;
      if (!externalUserId) {
        return jsonError(
          ApiErrorCode.AUTHENTICATION_ERROR,
          'Authentication required'
        );
      }
      // Read body once if needed — handler may also need it, so attach it.
      let body: unknown = ctx.body;
      if (source === 'body' && body === undefined) {
        try {
          body = await req.clone().json();
          ctx.body = body;
        } catch {
          body = null;
        }
      }
      // A credential bound to one workspace is bound, not merely labelled.
      //
      // This line used to read `readKey(...) ?? ctx.workspace?.id`, so a
      // caller-supplied `workspace_id` *beat* the workspace the API key is
      // pinned to (`api_keys.metadata.workspaceId`). The membership check
      // below bounds the damage to workspaces the key's own owner can already
      // reach — so this was never cross-tenant — but a key handed to an
      // installer as "scoped to workspace A" could operate on that user's
      // workspace B. Scoping that a request can opt out of is a label.
      //
      // A mismatch is refused with the same 404 an inaccessible workspace
      // gets: naming an id the credential is not bound to must not reveal
      // whether that id exists.
      const requestedWorkspaceId = readKey(source, key, ctx, body, req);
      const boundWorkspaceId = ctx.credentialWorkspaceId ?? null;
      if (
        boundWorkspaceId &&
        requestedWorkspaceId &&
        requestedWorkspaceId !== boundWorkspaceId
      ) {
        logger.warn('[routeAuthz] refused workspace outside credential scope', {
          externalUserId,
        });
        return jsonError(ApiErrorCode.NOT_FOUND, 'Workspace not found');
      }
      let workspaceId =
        requestedWorkspaceId ?? ctx.workspace?.id ?? null;
      if (!workspaceId && !opts.fallbackToDefault) {
        return jsonError(ApiErrorCode.VALIDATION_ERROR, `Missing ${key}`);
      }
      let accessible: Set<string>;
      try {
        accessible = await listAccessibleWorkspaceIds(externalUserId);
      } catch (error) {
        if (error instanceof WorkspaceAccessLookupError) {
          return NextResponse.json(
            {
              error: {
                code: 'workspace_access_unavailable',
                message: 'Workspace access is temporarily unavailable',
              },
            },
            { status: 503 }
          );
        }
        throw error;
      }
      if (!workspaceId && opts.fallbackToDefault) {
        workspaceId = accessible.values().next().value ?? null;
      }
      if (!workspaceId) {
        return jsonError(
          ApiErrorCode.VALIDATION_ERROR,
          'No workspace is available for this account'
        );
      }
      if (!accessible.has(workspaceId)) {
        return jsonError(ApiErrorCode.NOT_FOUND, 'Workspace not found');
      }
      ctx.workspace = { id: workspaceId };
      return handler(req, ctx);
    };
  };
}

// =============================================================================
// withResourceAccess
// =============================================================================

export interface ResourceAccessOptions {
  /** Postgres table name. Must have a `workspace_id` column. */
  table: string;
  /** Where to read the resource id from. Default: `param`. */
  idFrom?: 'param' | 'query' | 'body';
  /** Key name within the source. Default: `id`. */
  idKey?: string;
  /** Extra columns to select alongside `id, workspace_id`. */
  select?: string[];
}

/**
 * Reads a row by id from `table`, asserts its `workspace_id` is one the
 * caller owns, and attaches `{ id, workspace_id, row }` to `ctx.resource`.
 * 404s on missing row, foreign workspace, OR a workspace the admitting
 * credential is not bound to — never 403.
 *
 * Compose AFTER withAuth(). For tables without a `workspace_id` column,
 * use a custom helper instead — this is intentionally narrow.
 */
export function withResourceAccess(opts: ResourceAccessOptions) {
  const idFrom = opts.idFrom ?? 'param';
  const idKey = opts.idKey ?? 'id';
  const baseSelect = ['id', 'workspace_id', ...(opts.select ?? [])].join(', ');

  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      const externalUserId = ctx.externalUserId ?? ctx.userId;
      if (!externalUserId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      let body: unknown = ctx.body;
      if (idFrom === 'body' && body === undefined) {
        try {
          body = await req.clone().json();
          ctx.body = body;
        } catch {
          body = null;
        }
      }
      const resourceId = readKey(idFrom, idKey, ctx, body, req);
      if (!resourceId) {
        return NextResponse.json(
          { error: `Missing ${idKey}` },
          { status: 400 }
        );
      }

      const admin = getSupabaseAdmin();
      if (!admin) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      const { data, error } = await admin
        .from(opts.table)
        .select(baseSelect)
        .eq('id', resourceId)
        .maybeSingle();
      if (error) {
        logger.warn('[routeAuthz] resource fetch failed', {
          table: opts.table,
          error: error.message,
        });
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      if (!data) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      const workspaceId = (data as Record<string, unknown>)
        .workspace_id as string;

      // Same binding rule as `withWorkspaceAccess`, different door.
      //
      // There the workspace arrives from the caller, so refusing a mismatch
      // is obvious. Here it is *derived from the row*, so a credential pinned
      // to workspace A (`api_keys.metadata.workspaceId`) still reached its
      // owner's workspace B by naming a resource id that lives in B — no
      // `workspace_id` in the request at all. The membership check below
      // keeps this inside the key owner's own account, so it was never
      // cross-tenant; it is the same "scoping a request can opt out of is a
      // label" defect that G2 closed on the other path.
      //
      // Refused with the byte-identical 404 an inaccessible resource gets:
      // naming an id outside the binding must not reveal whether it exists.
      // Checked before the workspace-membership lookup so a bound credential
      // gets 404 rather than that lookup's 503 when the database is down.
      const boundWorkspaceId = ctx.credentialWorkspaceId ?? null;
      if (boundWorkspaceId && workspaceId !== boundWorkspaceId) {
        logger.warn('[routeAuthz] refused resource outside credential scope', {
          externalUserId,
          table: opts.table,
        });
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      let accessible: Set<string>;
      try {
        accessible = await listAccessibleWorkspaceIds(externalUserId);
      } catch (error) {
        if (error instanceof WorkspaceAccessLookupError) {
          return NextResponse.json(
            { error: 'workspace_access_unavailable' },
            { status: 503 }
          );
        }
        throw error;
      }
      if (!accessible.has(workspaceId)) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }

      ctx.resource = {
        id: resourceId,
        workspace_id: workspaceId,
        row: data as Record<string, unknown>,
      };
      ctx.workspace = { id: workspaceId };
      return handler(req, ctx);
    };
  };
}

// =============================================================================
// withProjectMembership
// =============================================================================

export interface ProjectAccessOptions {
  /** Where to read the project id from. Default: `param`. */
  idFrom?: 'param' | 'query' | 'body';
  /** Key name within the source. Default: `id`. */
  idKey?: string;
}

/**
 * Wraps the existing `requireProjectAccess` helper from `lib/server/identity`
 * so project-scoped routes get the same composable shape as workspace-scoped
 * ones. Attaches `{ id }` to `ctx.project`.
 */
export function withProjectMembership(opts: ProjectAccessOptions = {}) {
  const idFrom = opts.idFrom ?? 'param';
  const idKey = opts.idKey ?? 'id';

  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      let body: unknown = ctx.body;
      if (idFrom === 'body' && body === undefined) {
        try {
          body = await req.clone().json();
          ctx.body = body;
        } catch {
          body = null;
        }
      }
      const projectId = readKey(idFrom, idKey, ctx, body, req);
      if (!projectId) {
        return NextResponse.json(
          { error: `Missing ${idKey}` },
          { status: 400 }
        );
      }

      const { requireProjectAccess } = await import('@/lib/server/identity');
      const access = await requireProjectAccess(projectId);
      if (!access.ok) {
        // identity.ts returns 403 for foreign access; we collapse to 404
        // for consistency with withResourceAccess.
        const status = access.status === 403 ? 404 : access.status;
        return NextResponse.json(
          { error: access.message ?? 'not_found' },
          { status }
        );
      }
      ctx.project = { id: projectId };
      return handler(req, ctx);
    };
  };
}

// =============================================================================
// Imperative-check caller identity
// =============================================================================

/**
 * Who an imperative `assert*Access` check runs for.
 *
 * By default the checks resolve the Clerk session themselves. Routes admitted
 * by a machine credential (a personal `oxk_` API key, the service key plus a
 * gateway user, or a `withAuth` wrapper that already resolved the caller) have
 * no Clerk session, so they pass the identity they authenticated instead.
 * Passing `actorUserId: null` means "authenticated, but no user" and is
 * refused with 401 — it never falls back to a session lookup.
 */
export interface AccessActorOptions {
  actorUserId?: string | null;
}

async function resolveActorExternalId(
  opts: AccessActorOptions | undefined
): Promise<string | null> {
  if (opts && 'actorUserId' in opts) return opts.actorUserId ?? null;
  const { resolveApiUser } = await import('./apiRoute');
  const user = await resolveApiUser();
  return user.externalUserId ?? user.userId ?? null;
}

// =============================================================================
// assertWorkspaceAccess — imperative form
// =============================================================================

/**
 * Same check as `withWorkspaceAccess`, callable from inside a plain handler.
 *
 * The composable wrappers above are the better shape for new routes. They are
 * a poor fit for retrofitting an existing one: adopting `compose()` means
 * re-signing the handler, re-indenting its whole body, and moving the
 * workspace id off the query string — a large diff per route, on routes with
 * no test coverage, purely to add one check. Twenty of those in a batch is
 * how a security fix becomes an outage.
 *
 * This returns a `Response` to hand straight back when access fails, and
 * `null` when the caller may proceed:
 *
 *   const denied = await assertWorkspaceAccess(workspaceId);
 *   if (denied) return denied;
 *
 * Semantics deliberately match the wrapper: 401 with no identity, 404 (not
 * 403) when the workspace exists but is not the caller's, so the response
 * leaks nothing about which ids are real.
 */
export async function assertWorkspaceAccess(
  workspaceId: string | null | undefined,
  opts?: AccessActorOptions
): Promise<Response | null> {
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'Missing workspace_id' },
      { status: 400 }
    );
  }

  const externalUserId = await resolveActorExternalId(opts);
  if (!externalUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let accessible: Set<string>;
  try {
    accessible = await listAccessibleWorkspaceIds(externalUserId);
  } catch (error) {
    if (error instanceof WorkspaceAccessLookupError) {
      return NextResponse.json(
        { error: 'workspace_access_unavailable' },
        { status: 503 }
      );
    }
    throw error;
  }

  if (!accessible.has(workspaceId)) {
    logger.warn('[authz] workspace access denied', {
      externalUserId,
      workspaceId,
    });
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return null;
}

// =============================================================================
// assertProspectAccess
// =============================================================================

/**
 * Assert the caller is the prospect, or an operator.
 *
 * The `/api/v1/prospects/[prospectId]/*` routes read business_profiles,
 * artifact_maps, maturity_roadmaps and research_jobs through the service-role
 * client, keyed only on a prospectId from the URL. Middleware does require a
 * Clerk session for them — only `prospects/capture` is in the public
 * allowlist — so this was never an anonymous leak. It was an IDOR: ANY signed
 * in user could read ANY prospect's business profile by supplying its id.
 *
 * Ownership comes from the prospects table itself, which carries `email`
 * (unique) and `converted_to_user_id`. A prospect belongs to the person whose
 * email it is, or to the account it converted into.
 *
 * Operators are allowed through because these routes back an internal GTM
 * funnel view as well as the prospect-facing one; requireAdminAccess is the
 * repo's existing notion of that.
 *
 *   const denied = await assertProspectAccess(prospectId);
 *   if (denied) return denied;
 *
 * 401 with no identity, 404 for a prospect that is not yours or does not
 * exist — never 403, so the response cannot be used to enumerate ids.
 */
export async function assertProspectAccess(
  prospectId: string | null | undefined
): Promise<Response | null> {
  if (!prospectId) {
    return NextResponse.json({ error: 'Missing prospectId' }, { status: 400 });
  }

  const { resolveApiUser } = await import('./apiRoute');
  const user = await resolveApiUser();
  const externalUserId = user.externalUserId ?? user.userId;
  if (!externalUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'prospect_access_unavailable' },
      { status: 503 }
    );
  }

  const { data: prospect, error } = await admin
    .from('prospects')
    .select('id, email, converted_to_user_id')
    .eq('id', prospectId)
    .maybeSingle();

  if (error) {
    logger.warn('[authz] prospect lookup failed', {
      prospectId,
      error: error.message,
    });
    return NextResponse.json(
      { error: 'prospect_access_unavailable' },
      { status: 503 }
    );
  }
  if (!prospect) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const supabaseUserId =
    (await resolveSupabaseUserIdForExternal(externalUserId, {
      createIfMissing: false,
    })) ?? externalUserId;

  const ownsByConversion =
    Boolean(prospect.converted_to_user_id) &&
    prospect.converted_to_user_id === supabaseUserId;

  const callerEmail = user.email?.toLowerCase().trim() ?? null;
  const prospectEmail =
    typeof prospect.email === 'string'
      ? prospect.email.toLowerCase().trim()
      : null;
  const ownsByEmail = Boolean(
    callerEmail && prospectEmail && callerEmail === prospectEmail
  );

  if (ownsByConversion || ownsByEmail) return null;

  // Operators reach the same data through the internal funnel view.
  // requireAdminAccessApi returns null when access is granted and a response
  // when it is not — the void-returning requireAdminAccess() throws instead,
  // which is the wrong shape here.
  try {
    const { requireAdminAccessApi } = await import('./developerAccess');
    const adminDenied = await requireAdminAccessApi();
    if (adminDenied === null) return null;
  } catch {
    // Admin check unavailable in this context — fall through to deny.
  }

  logger.warn('[authz] prospect access denied', {
    externalUserId,
    prospectId,
  });
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

// =============================================================================
// assertInitiativeAccess
// =============================================================================

/**
 * Allow a caller to read an initiative-scoped resource.
 *
 * Several routes take an initiative id off the query string and read through
 * the service-role client without checking anything: mission-control/graph,
 * live/mission-control/graph, streams/initiative-state, streams/progress. An
 * initiative id alone was enough to read another tenant's execution graph.
 *
 * Plain workspace gating would be WRONG here. `/live` is a deliberately public
 * surface — an initiative with `metadata.live.visibility === 'public'` is
 * meant to be readable by anyone, and app/live/[initiativeId]/
 * opengraph-image.tsx renders it for link previews with no session at all.
 * Requiring auth unconditionally would break public proof pages, which is a
 * worse outcome than the leak it closes.
 *
 * So: a public initiative is allowed with no session. Otherwise fall back to
 * ownership, then workspace access. 404 for both "no such initiative" and
 * "not yours", so the response cannot be used to enumerate ids.
 *
 *   const denied = await assertInitiativeAccess(initiativeId);
 *   if (denied) return denied;
 *
 * Public visibility only ever grants READ. A route that writes, launches, or
 * returns something the public /live projection does not already show passes
 * `allowPublicLive: false`, so only the owner or a workspace owner gets in.
 */
export interface InitiativeAccessOptions extends AccessActorOptions {
  /** Default true. Pass false for mutations and non-public projections. */
  allowPublicLive?: boolean;
}

export async function assertInitiativeAccess(
  initiativeId: string | null | undefined,
  opts?: InitiativeAccessOptions
): Promise<Response | null> {
  if (!initiativeId) {
    return NextResponse.json(
      { error: 'Missing initiative_id' },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'initiative_access_unavailable' },
      { status: 503 }
    );
  }

  const { data: initiative, error } = await admin
    .from('initiatives')
    .select('id, owner_id, workspace_id, metadata')
    .eq('id', initiativeId)
    .maybeSingle();

  if (error) {
    logger.warn('[authz] initiative lookup failed', {
      initiativeId,
      error: error.message,
    });
    return NextResponse.json(
      { error: 'initiative_access_unavailable' },
      { status: 503 }
    );
  }
  if (!initiative) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Public live initiatives are readable by anyone, by design.
  if (opts?.allowPublicLive !== false) {
    const { isPublicLiveEntity } = await import('./live/visibility');
    if (isPublicLiveEntity(initiative.metadata)) return null;
  }

  const externalUserId = await resolveActorExternalId(opts);
  if (!externalUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUserId =
    (await resolveSupabaseUserIdForExternal(externalUserId, {
      createIfMissing: false,
    })) ?? externalUserId;

  if (initiative.owner_id && initiative.owner_id === supabaseUserId) {
    return null;
  }

  if (initiative.workspace_id) {
    let accessible: Set<string>;
    try {
      accessible = await listAccessibleWorkspaceIds(externalUserId);
    } catch (accessError) {
      if (accessError instanceof WorkspaceAccessLookupError) {
        return NextResponse.json(
          { error: 'workspace_access_unavailable' },
          { status: 503 }
        );
      }
      throw accessError;
    }
    if (accessible.has(initiative.workspace_id)) return null;
  }

  logger.warn('[authz] initiative access denied', {
    externalUserId,
    initiativeId,
  });
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

// =============================================================================
// listAccessibleInitiativeIds
// =============================================================================

/**
 * Every initiative the caller may read privately: the ones they own plus the
 * ones in a workspace they own. The set form of `assertInitiativeAccess`
 * (without the public-live allowance), for aggregate readers keyed only on
 * `initiative_id` that must be bounded to the caller before they run.
 *
 * Throws on lookup failure — an aggregate must fail closed, never widen.
 */
export async function listAccessibleInitiativeIds(
  externalUserId: string
): Promise<string[]> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new WorkspaceAccessLookupError(
      'Initiative authorization database is unavailable'
    );
  }
  const supabaseUserId =
    (await resolveSupabaseUserIdForExternal(externalUserId, {
      createIfMissing: false,
    })) ?? externalUserId;
  const workspaceIds = Array.from(
    await listAccessibleWorkspaceIds(externalUserId)
  );

  // Paged past the 1,000-row cap, workspace ids chunked to keep URLs short.
  const initiatives = () => admin.from('initiatives').select('id');
  const reads = [
    tryPageAll<{ id: string }>((from, to) =>
      initiatives().eq('owner_id', supabaseUserId).order('id').range(from, to)
    ),
    ...chunkIds(workspaceIds).map((chunk) =>
      tryPageAll<{ id: string }>((from, to) =>
        initiatives().in('workspace_id', chunk).order('id').range(from, to)
      )
    ),
  ];
  const ids = new Set<string>();
  for (const { rows, error, truncated } of await Promise.all(reads)) {
    if (error || truncated) {
      // A partial list would silently under-scope an aggregate; fail closed.
      logger.warn('[routeAuthz] initiative lookup failed', {
        error: error?.message ?? 'row cap reached',
      });
      throw new WorkspaceAccessLookupError(
        'Initiative authorization lookup failed'
      );
    }
    for (const row of rows) ids.add(row.id);
  }
  return Array.from(ids);
}

// =============================================================================
// assertMissionControlScopeAccess
// =============================================================================

export interface MissionControlScope {
  initiativeId?: string | null;
  workstreamId?: string | null;
  milestoneId?: string | null;
  taskId?: string | null;
}

/**
 * The mission-control graph routes accept ANY ONE of initiative_id,
 * workstream_id, milestone_id or task_id. Gating only the initiative would
 * leave three usable bypasses, so every entry point has to resolve to
 * something ownable before the graph is built.
 *
 *   workstreams / milestones -> carry initiative_id, so resolve up and defer
 *                               to assertInitiativeAccess (which keeps public
 *                               live initiatives public)
 *   tasks                    -> carry workspace_id directly
 *
 * Returns a Response to hand back on denial, null to proceed.
 */
export async function assertMissionControlScopeAccess(
  scope: MissionControlScope,
  opts?: InitiativeAccessOptions
): Promise<Response | null> {
  const { initiativeId, workstreamId, milestoneId, taskId } = scope;

  if (initiativeId) return assertInitiativeAccess(initiativeId, opts);

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'initiative_access_unavailable' },
      { status: 503 }
    );
  }

  for (const [table, id] of [
    ['workstreams', workstreamId],
    ['milestones', milestoneId],
  ] as const) {
    if (!id) continue;
    const { data, error } = await admin
      .from(table)
      .select('initiative_id')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      logger.warn('[authz] mission-control scope lookup failed', {
        table,
        id,
        error: error.message,
      });
      return NextResponse.json(
        { error: 'initiative_access_unavailable' },
        { status: 503 }
      );
    }
    if (!data?.initiative_id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return assertInitiativeAccess(data.initiative_id as string, opts);
  }

  if (taskId) {
    const { data, error } = await admin
      .from('tasks')
      .select('workspace_id')
      .eq('id', taskId)
      .maybeSingle();
    if (error) {
      logger.warn('[authz] mission-control task lookup failed', {
        taskId,
        error: error.message,
      });
      return NextResponse.json(
        { error: 'initiative_access_unavailable' },
        { status: 503 }
      );
    }
    if (!data?.workspace_id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return assertWorkspaceAccess(data.workspace_id as string, opts);
  }

  // No scope key at all — the route's own 400 will explain which is required.
  return null;
}

// =============================================================================
// Tests / sanity
// =============================================================================

// Re-export the underlying primitive so route handlers that don't fit the
// wrapper chain can still get a one-liner check.
export { listAccessibleWorkspaceIds as _listAccessibleWorkspaceIds };
