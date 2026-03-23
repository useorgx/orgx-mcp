import { buildBillingSettingsUrl, buildPricingUrl } from './shared/billingLinks';
import type { RateLimitDecision } from './edgeRateLimit';
import { withCorsAndHeaders } from './mcpTransport';

export function buildRateLimitExceededPayload(
  rateLimit: RateLimitDecision,
  orgxWebUrl?: string
) {
  const upgradeTarget = rateLimit.tier === 'free' ? 'pro' : 'enterprise';
  const upgradeUrl =
    upgradeTarget === 'pro'
      ? buildPricingUrl(orgxWebUrl, {
          upgrade: 'true',
          source: 'mcp_rate_limit',
        })
      : buildPricingUrl(orgxWebUrl, {
          plan: 'enterprise',
          source: 'mcp_rate_limit',
        });
  const billingSettingsUrl = buildBillingSettingsUrl(orgxWebUrl, {
    source: 'mcp_rate_limit',
  });

  return {
    error: 'Rate limit exceeded',
    tier: rateLimit.tier,
    retry_after_seconds: rateLimit.retryAfterSeconds ?? 60,
    upgrade_cta: {
      target_plan: upgradeTarget,
      message:
        upgradeTarget === 'pro'
          ? 'Upgrade to Pro for higher MCP request limits.'
          : 'Upgrade to Enterprise for unlimited MCP request limits.',
      url: upgradeUrl,
      billing_settings_url: billingSettingsUrl,
    },
  };
}

export function buildRateLimitedResponse(
  rateLimit: RateLimitDecision,
  orgxWebUrl?: string
): Response {
  const response = new Response(
    JSON.stringify(buildRateLimitExceededPayload(rateLimit, orgxWebUrl)),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
      },
    }
  );
  return withCorsAndHeaders(response, rateLimit.headers);
}
