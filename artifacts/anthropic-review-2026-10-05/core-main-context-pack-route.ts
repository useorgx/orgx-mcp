/**
 * Context Pack Endpoint (M backbone, app-side)
 *
 * POST /api/v1/context-pack — return a compiled AgentContextPack for an
 * entity. This is what the orgx-mcp backbone verbs (inspect_context /
 * orgx_bootstrap) and the client SessionStart adapters call so every agent —
 * including hookless clients like Codex — starts briefed by its first call.
 *
 * Auth: Bearer token with a per-user API key (oxk_...), or the trusted MCP
 * service key plus its gateway user identity. Owner-scoped (the loader never
 * reads across tenants).
 */
import { NextRequest, NextResponse } from 'next/server';
import { containsPotentialSecret } from '@orgx/contracts';

import { resolveClientWriteAuth } from '@/lib/server/auth/clientWriteAuth';
import { readBoundedJsonBody } from '@/lib/server/boundedRequestBody';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errors } from '@/lib/server/apiErrors';
import { compose, toRoute, type ApiHandler } from '@/lib/server/apiRoute';
import {
  buildContextPackForEntity,
  createSupabaseGoalFrameLoader,
  thinGoalFrame,
  type GoalFrameAnchorRef,
} from '@/lib/server/goalFrame';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildWorkspaceContextCapsule,
  compileSessionActivationFromPack,
} from '@/lib/server/contextCapsule';
import { applyComposedContextPackIdentity } from '@/lib/server/contextPack/composedIdentity';
import { withContextDelivery } from '@/lib/server/contextPack/delivery';
import { parseContextAccountingRequest } from '@/lib/server/contextPack/payloadAccounting';
import {
  contextContinuationCache,
  parseContextContinuation,
  continuationAuthorizationScope,
} from '@/lib/server/contextPack/continuation';
import { parseContextPackRequestScope } from '@/lib/server/contextPack/requestScope';
import { isAgentDecisionBriefShadowRequestAllowed } from '@/lib/server/agentDecisionBrief/access';
import { decisionBriefShadowFields } from '@/lib/server/agentDecisionBrief/compile';

import {
  fetchInbox,
  type AgentMessage,
} from '@/lib/server/coordination/agentMessages';
import { renderAgentInboxBlock } from '@/lib/server/coordination/renderAgentInbox';

import { ContextPhaseClock } from '@/lib/server/contextPack/phaseClock';
import { verifyFrameCoherentWithCapsule } from '@/lib/server/contextPack/frameCoherence';

export const CONTEXT_PACK_MAX_REQUEST_BYTES = 32 * 1024;
export const CONTEXT_PACK_MAX_TOOL_COUNT = 100;
export const CONTEXT_PACK_MAX_TOOL_BYTES = 200;
export const CONTEXT_PACK_CACHE_CONTROL = 'private, no-store';

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Resolve the most-specific anchor from the request body. Exported for tests. */
export function resolveAnchor(
  raw: Record<string, unknown>
): GoalFrameAnchorRef | null {
  return parseContextPackRequestScope(raw).anchor;
}

function successResponse(
  data: unknown,
  acknowledgedBase = false,
  startedAt = performance.now(),
  accounting?: ReturnType<typeof parseContextAccountingRequest>,
  continuation?: { scope: string; acknowledged?: string },
  clock?: ContextPhaseClock,
  maxBytes?: number
) {
  const payload = continuation
    ? {
        context_transfer: contextContinuationCache.prepare(
          continuation.scope,
          withContextDelivery(data),
          continuation.acknowledged
        ),
      }
    : data;
  const delivered = withContextDelivery(payload, acknowledgedBase, accounting);
  if (
    maxBytes !== undefined &&
    delivered.context_delivery.accounting.serialized_data_bytes > maxBytes
  )
    throw errors.validation(
      'Prepared context exceeds its byte budget; narrow the scope or request the full profile',
      {
        required_bytes:
          delivered.context_delivery.accounting.serialized_data_bytes,
        budget_bytes: maxBytes,
      }
    );
  return NextResponse.json(
    {
      ok: true,
      data: delivered,
    },
    {
      headers: {
        'Cache-Control': CONTEXT_PACK_CACHE_CONTROL,
        'Server-Timing': `context_prepare;dur=${(
          performance.now() - startedAt
        ).toFixed(3)}${clock ? ', ' + clock.header() : ''}`,
        'X-OrgX-Performance-Profile':
          delivered.context_delivery.performance_profile,
      },
    }
  );
}

function resolveTools(raw: Record<string, unknown>): string[] {
  if (raw.tools === undefined) return [];
  if (!Array.isArray(raw.tools)) {
    throw errors.validation('tools must be an array of tool identifiers', {
      field: 'tools',
    });
  }
  if (raw.tools.length > CONTEXT_PACK_MAX_TOOL_COUNT) {
    throw errors.validation(
      `tools must contain at most ${CONTEXT_PACK_MAX_TOOL_COUNT} entries`,
      { field: 'tools', max_items: CONTEXT_PACK_MAX_TOOL_COUNT }
    );
  }

  const tools = raw.tools.map((value, index) => {
    if (typeof value !== 'string') {
      throw errors.validation('each tool must be a string identifier', {
        field: `tools.${index}`,
      });
    }
    const tool = value.trim();
    if (
      !tool ||
      utf8Bytes(tool) > CONTEXT_PACK_MAX_TOOL_BYTES ||
      containsPotentialSecret(tool)
    ) {
      throw errors.validation(
        `each tool must be safe text between 1 and ${CONTEXT_PACK_MAX_TOOL_BYTES} UTF-8 bytes`,
        {
          field: `tools.${index}`,
          max_bytes: CONTEXT_PACK_MAX_TOOL_BYTES,
        }
      );
    }
    return tool;
  });
  return [...new Set(tools)];
}

/**
 * Mail addressed to whoever is about to work this anchor.
 *
 * Deliberately a sibling of the pack, not a field inside it: the pack's
 * `contentDigest` backs a delta-transfer cache and must stay a function of
 * derived, idempotent state, while messages are consumed and acked.
 *
 * A read here does not mark anything delivered. This endpoint is a briefing
 * fetch that a client may repeat; the client records delivery when it acts
 * (`mark_delivered=true` on the inbox read, or an ack). Never throws — a
 * briefing must not fail because the mailbox was unavailable.
 */
async function loadAnchorInbox(
  admin: SupabaseClient,
  ownerId: string,
  anchor: GoalFrameAnchorRef
): Promise<{ messages: AgentMessage[]; prompt_block: string } | null> {
  if (!anchor.id) return null;
  try {
    const messages = await fetchInbox(admin as unknown as Parameters<typeof fetchInbox>[0], {
      ownerId,
      reader: {
        taskId: anchor.type === 'task' ? anchor.id : null,
        workstreamId: anchor.type === 'workstream' ? anchor.id : null,
        initiativeId: anchor.type === 'initiative' ? anchor.id : null,
      },
    });
    if (messages.length === 0) return null;
    return { messages, prompt_block: renderAgentInboxBlock(messages) };
  } catch {
    return null;
  }
}

const TABLE_BY_ANCHOR: Record<GoalFrameAnchorRef['type'], string | null> = {
  initiative: 'initiatives',
  workstream: 'workstreams',
  task: 'workstream_tasks',
  goal: null,
};

interface ResolvedAnchorScope {
  workspaceId: string;
  initiativeId?: string;
  workstreamId?: string;
}

async function resolveAnchorScope(input: {
  admin: SupabaseClient;
  ownerId: string;
  anchor: GoalFrameAnchorRef;
}): Promise<ResolvedAnchorScope | null> {
  const table = TABLE_BY_ANCHOR[input.anchor.type];
  if (!table || !input.anchor.id) return null;
  const result = await input.admin
    .from(table)
    .select(
      input.anchor.type === 'initiative'
        ? 'workspace_id'
        : input.anchor.type === 'workstream'
          ? 'workspace_id, initiative_id'
          : 'workspace_id, initiative_id, workstream_id'
    )
    .eq('id', input.anchor.id)
    .eq('owner_id', input.ownerId)
    .maybeSingle();
  if (result.error) {
    throw errors.internal(`Unable to verify ${input.anchor.type} scope`);
  }
  const row = result.data as {
    workspace_id?: unknown;
    initiative_id?: unknown;
    workstream_id?: unknown;
  } | null;
  const workspaceId = row?.workspace_id;
  if (input.anchor.type === 'initiative') {
    return typeof workspaceId === 'string' && workspaceId
      ? { workspaceId, initiativeId: input.anchor.id }
      : null;
  }
  if (typeof row?.initiative_id !== 'string' || !row.initiative_id) return null;
  const initiative = await input.admin
    .from('initiatives')
    .select('workspace_id')
    .eq('id', row.initiative_id)
    .eq('owner_id', input.ownerId)
    .maybeSingle();
  if (initiative.error) {
    throw errors.internal('Unable to verify task initiative scope');
  }
  const inheritedWorkspaceId = (
    initiative.data as { workspace_id?: unknown } | null
  )?.workspace_id;
  if (typeof inheritedWorkspaceId !== 'string' || !inheritedWorkspaceId) {
    return null;
  }
  if (
    typeof workspaceId === 'string' &&
    workspaceId &&
    workspaceId !== inheritedWorkspaceId
  ) {
    return null;
  }
  if (input.anchor.type === 'workstream') {
    return {
      workspaceId: inheritedWorkspaceId,
      initiativeId: row.initiative_id,
      workstreamId: input.anchor.id,
    };
  }
  if (typeof row.workstream_id !== 'string' || !row.workstream_id) return null;
  const workstream = await input.admin
    .from('workstreams')
    .select('initiative_id, workspace_id')
    .eq('id', row.workstream_id)
    .eq('owner_id', input.ownerId)
    .maybeSingle();
  if (workstream.error) {
    throw errors.internal('Unable to verify task workstream scope');
  }
  const workstreamRow = workstream.data as {
    initiative_id?: unknown;
    workspace_id?: unknown;
  } | null;
  if (
    workstreamRow?.initiative_id !== row.initiative_id ||
    (typeof workstreamRow.workspace_id === 'string' &&
      workstreamRow.workspace_id &&
      workstreamRow.workspace_id !== inheritedWorkspaceId)
  ) {
    return null;
  }
  return {
    workspaceId: inheritedWorkspaceId,
    initiativeId: row.initiative_id,
    workstreamId: row.workstream_id,
  };
}

const postHandler: ApiHandler = async (request: Request) => {
  const startedAt = performance.now();
  const clock = new ContextPhaseClock();
  const body = await readBoundedJsonBody(
    request,
    CONTEXT_PACK_MAX_REQUEST_BYTES
  );
  if (!body.ok) {
    return NextResponse.json(
      { ok: false, error: body.message, code: body.code },
      { status: body.status }
    );
  }
  const raw = body.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('Invalid JSON body');
  }
  const requestBody = raw as Record<string, unknown>;
  const responseProfile = requestBody.response_profile ?? 'full';
  if (responseProfile !== 'full' && responseProfile !== 'prepared')
    throw errors.badRequest('Unknown context response profile');
  if (responseProfile === 'prepared' && requestBody.delivery_mode !== undefined)
    throw errors.badRequest(
      'Prepared context uses direct delivery; use the full profile for delta transfer'
    );
  const acknowledgedBase = requestBody.acknowledged_capsule_id;
  if (
    acknowledgedBase !== undefined &&
    (typeof acknowledgedBase !== 'string' ||
      !/^capsule_[0-9a-f]{24}$/.test(acknowledgedBase))
  ) {
    throw errors.badRequest('Invalid acknowledged capsule ID');
  }
  const requestScope = parseContextPackRequestScope(requestBody);
  const tools = resolveTools(requestBody);
  const decisionBriefShadow =
    responseProfile === 'full' &&
    isAgentDecisionBriefShadowRequestAllowed(request.headers);
  const accounting = parseContextAccountingRequest(requestBody);
  const continuationRequest = parseContextContinuation(requestBody);
  if (continuationRequest && acknowledgedBase !== undefined)
    throw errors.badRequest('Use one continuation acknowledgement format');

  const auth = await clock.measure('authentication', () =>
    resolveClientWriteAuth(request)
  );
  const userId = auth.requesterId;

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw errors.internal('Database client not configured');
  }

  const anchor = requestScope.anchor;
  const requestedInitiativeId = requestScope.initiativeId;
  const requestedWorkstreamId = requestScope.workstreamId;
  const requestedWorkspaceId = requestScope.workspaceId;
  if (
    auth.workspaceId &&
    requestedWorkspaceId &&
    auth.workspaceId !== requestedWorkspaceId
  ) {
    throw errors.notFound('Workspace not found');
  }
  const anchorScope = anchor
    ? await clock.measure('scope', () =>
        resolveAnchorScope({
          admin: admin as SupabaseClient,
          ownerId: userId,
          anchor,
        })
      )
    : null;
  if (anchor && !anchorScope) {
    throw errors.notFound('Entity not found');
  }
  if (
    anchorScope &&
    ((auth.workspaceId && auth.workspaceId !== anchorScope.workspaceId) ||
      (requestedWorkspaceId &&
        requestedWorkspaceId !== anchorScope.workspaceId))
  ) {
    throw errors.notFound('Entity not found');
  }
  if (
    anchorScope &&
    ((requestedInitiativeId &&
      requestedInitiativeId !== anchorScope.initiativeId) ||
      (requestedWorkstreamId &&
        requestedWorkstreamId !== anchorScope.workstreamId))
  ) {
    throw errors.badRequest('Entity scope fields disagree');
  }
  const workspaceId =
    requestedWorkspaceId ?? auth.workspaceId ?? anchorScope?.workspaceId;
  const continuation =
    continuationRequest && workspaceId
      ? {
          ...continuationRequest,
          scope: continuationAuthorizationScope(userId, workspaceId, request, [
            requestScope,
            tools,
            responseProfile,
            ...(decisionBriefShadow
              ? ['agent-decision-brief-shadow/v0.1']
              : []),
          ]),
        }
      : undefined;
  if (!anchor && !workspaceId) {
    throw errors.badRequest(
      'Provide workspace_id, initiative_id, workstream_id, or task_id'
    );
  }

  // The prepared profile intentionally stays capsule-only to preserve the
  // existing 8 KiB response contract. The promoted decision brief is part of
  // the full agent context profile and is never silently truncated into this
  // smaller compatibility surface.
  if (responseProfile === 'prepared' && workspaceId) {
    const contextCapsule = await clock.measure('capsule', () =>
      buildWorkspaceContextCapsule({
        admin: admin as SupabaseClient,
        ownerId: userId,
        workspaceId,
        ...(anchorScope?.initiativeId
          ? { initiativeId: anchorScope.initiativeId }
          : {}),
        ...(anchorScope?.workstreamId
          ? { workstreamId: anchorScope.workstreamId }
          : {}),
        ...(anchor?.type === 'task' ? { taskId: anchor.id } : {}),
        generatedAt: new Date().toISOString(),
      })
    );
    return successResponse(
      { context_capsule: contextCapsule },
      acknowledgedBase !== undefined,
      startedAt,
      accounting,
      undefined,
      clock,
      8192
    );
  }

  if (!anchor && workspaceId) {
    const contextCapsule = await clock.measure('capsule', () =>
      buildWorkspaceContextCapsule({
        admin: admin as SupabaseClient,
        ownerId: userId,
        workspaceId,
        generatedAt: new Date().toISOString(),
      })
    );
    const sessionActivation = compileSessionActivationFromPack({
      capsule: contextCapsule,
      frame: thinGoalFrame({
        type: 'goal',
        id: workspaceId,
        title: 'Workspace continuation',
      }),
    });
    const data = applyComposedContextPackIdentity({
      data: {
        contextCapsule,
        context_capsule: contextCapsule,
        sessionActivation,
        sessionWorkContext: sessionActivation.work_context,
        ...decisionBriefShadowFields(decisionBriefShadow, {
          capsule: contextCapsule,
        }),
      },
      contextCapsule: contextCapsule as unknown as Record<string, unknown>,
      sessionActivation: sessionActivation as unknown as Record<
        string,
        unknown
      >,
    });
    return successResponse(
      data,
      acknowledgedBase !== undefined,
      startedAt,
      accounting,
      continuation,
      clock
    );
  }

  if (!anchor) {
    throw errors.badRequest(
      'Provide initiative_id, workstream_id, or task_id for an entity context pack'
    );
  }

  const loader = createSupabaseGoalFrameLoader(admin as SupabaseClient, userId);
  const pack = await clock.measure('goal_frame', () =>
    buildContextPackForEntity(loader, anchor, {
      compiledAt: new Date().toISOString(),
      tools,
    })
  );
  const agentInbox = await loadAnchorInbox(
    admin as SupabaseClient,
    userId,
    anchor
  );

  if (
    workspaceId &&
    anchor.id &&
    (anchor.type === 'task' ||
      anchor.type === 'workstream' ||
      anchor.type === 'initiative')
  ) {
    const contextCapsule = await clock.measure('capsule', () =>
      buildWorkspaceContextCapsule({
        admin: admin as SupabaseClient,
        ownerId: userId,
        workspaceId,
        ...(anchor.type === 'task' ? { taskId: anchor.id } : {}),
        ...(anchor.type === 'workstream' ? { workstreamId: anchor.id } : {}),
        ...(anchor.type === 'initiative' ? { initiativeId: anchor.id } : {}),
        generatedAt: new Date().toISOString(),
      })
    );
    const sessionActivation = compileSessionActivationFromPack({
      capsule: contextCapsule,
      frame: pack.frame,
    });
    const frameSnapshotVerified = await clock.measure('frame_coherence', () =>
      verifyFrameCoherentWithCapsule(admin as SupabaseClient, {
        ownerId: userId,
        workspaceId,
        capsule: contextCapsule,
      })
    );
    const data = applyComposedContextPackIdentity({
      data: {
        ...pack,
        frame_snapshot_verified: frameSnapshotVerified,
        ...(agentInbox ? { agent_inbox: agentInbox } : {}),
        contextCapsule,
        context_capsule: contextCapsule,
        sessionActivation,
        sessionWorkContext: sessionActivation.work_context,
        ...decisionBriefShadowFields(decisionBriefShadow, {
          capsule: contextCapsule,
          frame: pack.frame,
        }),
      },
      contextCapsule: contextCapsule as unknown as Record<string, unknown>,
      sessionActivation: sessionActivation as unknown as Record<
        string,
        unknown
      >,
    });
    return successResponse(
      data,
      acknowledgedBase !== undefined,
      startedAt,
      accounting,
      continuation,
      clock
    );
  }

  return successResponse(
    agentInbox ? { ...pack, agent_inbox: agentInbox } : pack,
    acknowledgedBase !== undefined,
    startedAt,
    accounting,
    continuation,
    clock
  );
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<Record<string, string | string[]>> }
) {
  return toRoute(compose()(postHandler))(request, context);
}
