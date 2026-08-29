import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  resolveBillingPlanContext,
  type BillingPlanUnavailableReason,
} from './billingPlan';
import { buildBillingSettingsUrl, buildPricingUrl } from './shared/billingLinks';
import { mapPlanToAccountTier, type AccountTier } from './accountTools';

// =============================================================================
// SESSION TOKEN SUPPORT
// =============================================================================

/**
 * Tools that agent session tokens are allowed to call.
 * Session tokens are issued by POST /session-tokens for server-to-server use.
 * They must NOT access billing/account settings or org configuration tools.
 */
export const SESSION_TOKEN_ALLOWED_TOOLS = new Set([
  'orgx_spawn',
  'orgx_submit_receipt',
  'orgx_search',
  'orgx_inspect',
  'recall_memory',
  'create_entity',
  'create_decision',
  'orgx_emit_activity',
  'orgx_request_attention',
  'orgx_poll_attention',
  'orgx_ack_attention',
  'orgx_request_question',
  'orgx_poll_question',
  'orgx_emit_execution_graph',
  'record_quality_score',
  'update_entity',
  'spawn_agent_task',
  'get_task_with_context',
  'get_initiative_pulse',
  'check_execution_readiness',
  'list_entities',
  'save_artifact',
]);

/**
 * Detect whether the calling context is an agent session token.
 *
 * Session tokens are now HMAC-signed (see sessionToken.ts). The decoded
 * payload must have `type: 'session'` and a non-empty `sid` (sessionId).
 * Legacy unsigned tokens (plain base64 with `sessionId` field) are rejected —
 * only signed tokens that have been verified upstream set `type: 'session'`.
 */
export function isSessionToken(props: Record<string, unknown> | null | undefined): boolean {
  if (!props) return false;
  // Only trust the type marker — it is set by the HMAC-verified payload.
  // The `sid` field from signed tokens maps to sessionId in the verified payload.
  if (props['type'] === 'session') {
    const sid = props['sid'] ?? props['sessionId'];
    return typeof sid === 'string' && sid.length > 0;
  }
  return false;
}

/**
 * Check whether a session token caller is allowed to invoke the given tool.
 * Returns a blocked CallToolResult if the tool is not in the allowed set,
 * or null if access is permitted.
 */
export function checkSessionTokenToolAccess(
  toolId: string,
  props: Record<string, unknown> | null | undefined
): CallToolResult | null {
  if (!isSessionToken(props)) return null; // not a session token — normal gating applies

  if (SESSION_TOKEN_ALLOWED_TOOLS.has(toolId)) return null; // allowed

  return {
    content: [
      {
        type: 'text',
        text: `Tool "${toolId}" is not available to agent session tokens. Allowed tools: ${[...SESSION_TOKEN_ALLOWED_TOOLS].join(', ')}.`,
      },
    ],
    structuredContent: {
      ok: false,
      code: 'session_token_restricted',
      tool: toolId,
      allowed_tools: [...SESSION_TOKEN_ALLOWED_TOOLS],
    },
    isError: true,
  } as CallToolResult;
}

type ToolAccessFeature = 'spawn_agent_task' | 'start_autonomous_session';

type ToolAccessRule = {
  minimumTier: Exclude<AccountTier, 'free'>;
  source: string;
  message: string;
};

type ToolAccessAllowed = {
  allowed: true;
  plan: string;
  tier: AccountTier;
  feature: ToolAccessFeature;
  minimumTier: Exclude<AccountTier, 'free'>;
  source: 'api' | 'cache';
  origin: string | null;
};

type ToolAccessBlocked = {
  allowed: false;
  code: 'plan_restricted';
  plan: string;
  tier: AccountTier;
  feature: ToolAccessFeature;
  minimumTier: Exclude<AccountTier, 'free'>;
  source: 'api' | 'cache';
  origin: string | null;
  error: string;
  upgrade_cta: {
    target_plan: Exclude<AccountTier, 'free'>;
    message: string;
    url: string;
    billing_settings_url: string;
  };
};

type ToolAccessUnavailable = {
  allowed: false;
  code: 'plan_unavailable';
  feature: ToolAccessFeature;
  minimumTier: Exclude<AccountTier, 'free'>;
  source: 'unavailable';
  origin: string | null;
  reason: BillingPlanUnavailableReason;
  retryable: true;
  error: string;
};

export type ToolAccessResult =
  | ToolAccessAllowed
  | ToolAccessBlocked
  | ToolAccessUnavailable;

const TOOL_ACCESS_RULES: Record<ToolAccessFeature, ToolAccessRule> = {
  spawn_agent_task: {
    minimumTier: 'pro',
    source: 'mcp_spawn_agent_task',
    message:
      'Upgrade to Pro to delegate work to specialist agents with spawn_agent_task.',
  },
  start_autonomous_session: {
    minimumTier: 'pro',
    source: 'mcp_start_autonomous_session',
    message: 'Upgrade to Pro to start autonomous execution sessions.',
  },
};

function hasTierAccess(
  tier: AccountTier,
  minimumTier: Exclude<AccountTier, 'free'>
) {
  if (minimumTier === 'enterprise') {
    return tier === 'enterprise';
  }
  return tier === 'pro' || tier === 'enterprise';
}

export function evaluateToolAccess(params: {
  feature: ToolAccessFeature;
  plan: string | null | undefined;
  orgxWebUrl?: string | null;
  source?: 'api' | 'cache';
  origin?: string | null;
}): ToolAccessResult {
  const rule = TOOL_ACCESS_RULES[params.feature];
  const plan = (params.plan ?? 'free').trim().toLowerCase() || 'free';
  const tier = mapPlanToAccountTier(plan);

  if (hasTierAccess(tier, rule.minimumTier)) {
    return {
      allowed: true,
      plan,
      tier,
      feature: params.feature,
      minimumTier: rule.minimumTier,
      source: params.source ?? 'api',
      origin: params.origin ?? null,
    };
  }

  return {
    allowed: false,
    code: 'plan_restricted',
    plan,
    tier,
    feature: params.feature,
    minimumTier: rule.minimumTier,
    source: params.source ?? 'api',
    origin: params.origin ?? null,
    error: rule.message,
    upgrade_cta: {
      target_plan: rule.minimumTier,
      message: rule.message,
      url:
        rule.minimumTier === 'enterprise'
          ? buildPricingUrl(params.orgxWebUrl, {
              plan: 'enterprise',
              source: rule.source,
            })
          : buildPricingUrl(params.orgxWebUrl, {
              upgrade: 'true',
              source: rule.source,
            }),
      billing_settings_url: buildBillingSettingsUrl(params.orgxWebUrl, {
        source: rule.source,
      }),
    },
  };
}

export function buildPlanRestrictedToolResult(
  access: ToolAccessBlocked | ToolAccessUnavailable
): CallToolResult {
  if (access.code === 'plan_unavailable') {
    return {
      content: [{ type: 'text', text: access.error }],
      structuredContent: {
        ok: false,
        code: access.code,
        retryable: access.retryable,
        reason: access.reason,
        source: access.source,
        origin: access.origin,
        required_plan: access.minimumTier,
      },
      isError: true,
    } as CallToolResult;
  }
  return {
    content: [
      {
        type: 'text',
        text: `${access.error}\nUpgrade: ${access.upgrade_cta.url}`,
      },
    ],
    structuredContent: {
      ok: false,
      code: access.code,
      plan: access.plan,
      tier: access.tier,
      required_plan: access.minimumTier,
      source: access.source,
      origin: access.origin,
      upgrade_cta: access.upgrade_cta,
    },
    isError: true,
  } as CallToolResult;
}

export async function checkToolPlanAccess(params: {
  env: {
    ORGX_API_URL: string;
    ORGX_SERVICE_KEY: string;
    ORGX_WEB_URL?: string;
  };
  userId?: string | null;
  userEmail?: string | null;
  orgxUserId?: string | null;
  workspaceId?: string | null;
  feature: ToolAccessFeature;
}): Promise<CallToolResult | null> {
  const trimmedUserId =
    typeof params.userId === 'string' ? params.userId.trim() : '';
  const userId = trimmedUserId.length > 0 ? trimmedUserId : null;

  if (!userId) {
    return buildPlanRestrictedToolResult(
      {
        allowed: false,
        code: 'plan_unavailable',
        feature: params.feature,
        minimumTier: TOOL_ACCESS_RULES[params.feature].minimumTier,
        source: 'unavailable',
        origin: null,
        reason: 'identity_missing',
        retryable: true,
        error:
          'Your OrgX billing plan could not be verified because the authenticated identity is unavailable. Please reconnect and try again.',
      }
    );
  }

  const billing = await resolveBillingPlanContext(params.env, userId, {
    userEmail: params.userEmail,
    orgxUserId: params.orgxUserId,
    workspaceId: params.workspaceId,
  });

  if (!billing.available || billing.source === 'unavailable') {
    return buildPlanRestrictedToolResult({
      allowed: false,
      code: 'plan_unavailable',
      feature: params.feature,
      minimumTier: TOOL_ACCESS_RULES[params.feature].minimumTier,
      source: 'unavailable',
      origin: billing.origin,
      reason: billing.reason ?? 'upstream_error',
      retryable: true,
      error:
        'Your OrgX billing plan is temporarily unavailable and this action cannot be authorized yet. Please retry.',
    });
  }

  const access = evaluateToolAccess({
    feature: params.feature,
    plan: billing.plan,
    orgxWebUrl: params.env.ORGX_WEB_URL,
    source: billing.source,
    origin: billing.origin,
  });
  return access.allowed ? null : buildPlanRestrictedToolResult(access);
}
