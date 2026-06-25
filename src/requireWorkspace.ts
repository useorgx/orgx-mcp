/**
 * requireWorkspace — workspace-scoped IDOR check at the MCP boundary.
 *
 * Why it exists: every tool handler that mutates a workspace-scoped resource
 * resolves a `workspace_id` from the tool args (or the session context's
 * default), then calls into the OrgX web API. The web API enforces ownership
 * on its own endpoints, but:
 *
 *   1. If a new endpoint slips out without authz, the MCP layer is the only
 *      remaining line of defense.
 *   2. Cost-bearing tools (agent dispatch, plan sessions) shouldn't even
 *      *attempt* the API call when the caller doesn't own the workspace —
 *      we'd waste a round-trip and pollute logs.
 *   3. Audit logs at the MCP layer carry richer caller-side context (tool
 *      name, full arg shape) than the web API's request log.
 *
 * Pattern of use in a tool handler:
 *
 *   const access = await requireWorkspace({
 *     args,
 *     sessionWorkspaceId: this.sessionContext.workspaceId,
 *     userId: this.props?.userId ?? this.sessionAuth?.userId ?? null,
 *     env: this.env,
 *   });
 *   if (!access.ok) return access.error;
 *   const workspaceId = access.workspaceId;
 *   // ... rest of the handler is now safe to assume `workspaceId` is owned
 *
 * Caches per (userId, workspaceId) for 60 seconds to avoid re-hitting the
 * web API on every tool call within a single MCP session.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { toolError } from './authHelpers';
import {
  callOrgxApiJson,
  OrgXApiError,
  type OrgxApiEnv,
} from './orgxApi';

export interface RequireWorkspaceOptions {
  /** Tool input args. */
  args: Record<string, unknown>;
  /** Session-default workspace_id, used as fallback when args don't carry one. */
  sessionWorkspaceId?: string | null;
  /** Caller's resolved user id. Required — there's no anonymous variant. */
  userId: string | null | undefined;
  /** Wrangler env that the orgxApi client needs. */
  env: OrgxApiEnv;
}

export type RequireWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: CallToolResult };

const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const membershipCache = new Map<string, { ok: boolean; expiresAt: number }>();
const membershipInFlight = new Map<string, Promise<void>>();

export async function requireWorkspace(
  opts: RequireWorkspaceOptions
): Promise<RequireWorkspaceResult> {
  const argWorkspaceId = readWorkspaceArg(opts.args);
  const workspaceId = argWorkspaceId ?? opts.sessionWorkspaceId ?? null;

  if (!workspaceId) {
    return {
      ok: false,
      error: toolError('workspace_id is required', {
        code: 'missing_workspace',
        status: 400,
      }),
    };
  }

  if (!opts.userId) {
    return {
      ok: false,
      error: toolError('Authentication required', {
        code: 'unauthorized',
        status: 401,
      }),
    };
  }

  const cacheKey = `${opts.userId}::${workspaceId}`;
  const cached = membershipCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ok
      ? { ok: true, workspaceId }
      : { ok: false, error: notFoundError() };
  }

  let owns = false;
  let probe = membershipInFlight.get(cacheKey);
  if (!probe) {
    probe = callOrgxApiJson(
      opts.env,
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: 'GET' },
      { userId: opts.userId }
    ).then(() => undefined);
    membershipInFlight.set(cacheKey, probe);
  }

  try {
    await probe;
    owns = true;
  } catch (err) {
    if (err instanceof OrgXApiError && err.statusCode === 404) {
      owns = false;
    } else if (err instanceof OrgXApiError && err.statusCode === 403) {
      // The web API used to return 403 — collapse to "not owned" for
      // consistency with our 404-everywhere policy.
      owns = false;
    } else {
      // Any other error (timeout, 500, mis-config) — fail closed but DO NOT
      // cache the negative result. Returning a clear error is better than a
      // false 404.
      console.error('[requireWorkspace] membership probe failed:', err);
      return {
        ok: false,
        error: toolError(
          'Could not verify workspace access. Please try again.',
          { code: 'membership_check_failed', status: 503 }
        ),
      };
    }
  } finally {
    if (membershipInFlight.get(cacheKey) === probe) {
      membershipInFlight.delete(cacheKey);
    }
  }

  membershipCache.set(cacheKey, {
    ok: owns,
    expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS,
  });

  if (!owns) {
    return { ok: false, error: notFoundError() };
  }
  return { ok: true, workspaceId };
}

/**
 * Read `workspace_id` from tool args, supporting the deprecated
 * `command_center_id` alias. If both are present and differ, the caller
 * gets a structured error; this helper just returns the canonical value when
 * there's no conflict.
 */
function readWorkspaceArg(args: Record<string, unknown>): string | null {
  const ws = trimmedString(args.workspace_id);
  const cc = trimmedString(args.command_center_id);
  if (ws && cc && ws !== cc) {
    // Both present and different — handler should use detectWorkspaceArgConflict
    // first if it wants a separate error message. Here we prefer ws.
    return ws;
  }
  return ws ?? cc ?? null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notFoundError(): CallToolResult {
  // 404 (not 403) — we never leak existence of workspaces a caller doesn't own.
  return toolError('Workspace not found', {
    code: 'not_found',
    status: 404,
  });
}

/**
 * For handlers that want to surface the conflict explicitly (instead of
 * silently preferring `workspace_id`), call this BEFORE requireWorkspace.
 */
export function detectWorkspaceArgConflict(
  args: Record<string, unknown>
): CallToolResult | null {
  const ws = trimmedString(args.workspace_id);
  const cc = trimmedString(args.command_center_id);
  if (ws && cc && ws !== cc) {
    return toolError(
      'workspace_id and command_center_id must match when both are provided',
      { code: 'invalid_input', status: 400 }
    );
  }
  return null;
}

/**
 * Test-only helper to clear the membership cache between cases.
 * Marked `@internal` so it doesn't appear in our public surface — but it's
 * still exported so vitest specs can invoke it.
 *
 * @internal
 */
export function _clearMembershipCacheForTests(): void {
  membershipCache.clear();
  membershipInFlight.clear();
}
