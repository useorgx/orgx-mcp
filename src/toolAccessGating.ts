import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { callOrgxApiJson } from './orgxApi';
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
  'create_entity',
  'create_decision',
  'orgx_emit_activity',
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
};

type ToolAccessBlocked = {
  allowed: false;
  code: 'plan_restricted';
  plan: string;
  tier: AccountTier;
  feature: ToolAccessFeature;
  minimumTier: Exclude<AccountTier, 'free'>;
  error: string;
  upgrade_cta: {
    target_plan: Exclude<AccountTier, 'free'>;
    message: string;
    url: string;
    billing_settings_url: string;
  };
};

export type ToolAccessResult = ToolAccessAllowed | ToolAccessBlocked;

interface UsageResponse {
  plan?: unknown;
}

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
    };
  }

  return {
    allowed: false,
    code: 'plan_restricted',
    plan,
    tier,
    feature: params.feature,
    minimumTier: rule.minimumTier,
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
  access: ToolAccessBlocked
): CallToolResult {
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
  feature: ToolAccessFeature;
}): Promise<CallToolResult | null> {
  const trimmedUserId =
    typeof params.userId === 'string' ? params.userId.trim() : '';
  const userId = trimmedUserId.length > 0 ? trimmedUserId : null;

  if (!userId) {
    return buildPlanRestrictedToolResult(
      evaluateToolAccess({
        feature: params.feature,
        plan: 'free',
        orgxWebUrl: params.env.ORGX_WEB_URL,
      }) as ToolAccessBlocked
    );
  }

  let plan = 'free';
  try {
    const response = await callOrgxApiJson(
      params.env,
      '/api/billing/usage',
      { method: 'GET' },
      { userId }
    );
    const usage = (await response.json()) as UsageResponse;
    if (typeof usage.plan === 'string' && usage.plan.trim().length > 0) {
      plan = usage.plan.trim().toLowerCase();
    }
  } catch {
    plan = 'free';
  }

  const access = evaluateToolAccess({
    feature: params.feature,
    plan,
    orgxWebUrl: params.env.ORGX_WEB_URL,
  });
  return access.allowed ? null : buildPlanRestrictedToolResult(access);
}
