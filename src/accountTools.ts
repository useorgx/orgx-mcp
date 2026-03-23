import { buildBillingSettingsUrl, buildPricingUrl } from './shared/billingLinks';

export type AccountTier = 'free' | 'pro' | 'enterprise';

export type UpgradeOption = {
  plan: 'pro' | 'enterprise';
  label: string;
  available: boolean;
};

type UsagePayload = Record<string, unknown>;

export function mapPlanToAccountTier(
  plan: string | null | undefined
): AccountTier {
  const normalized = (plan ?? 'free').trim().toLowerCase();
  if (
    normalized === 'enterprise' ||
    normalized === 'enterprise_plus' ||
    normalized === 'enterprise-pro'
  ) {
    return 'enterprise';
  }
  if (
    normalized === 'pro' ||
    normalized === 'team' ||
    normalized === 'starter' ||
    normalized === 'growth' ||
    normalized === 'scale'
  ) {
    return 'pro';
  }
  return 'free';
}

export function getTierHourlyLimit(tier: AccountTier): number | null {
  if (tier === 'enterprise') return null;
  return tier === 'pro' ? 1000 : 100;
}

export function getUpgradeOptions(tier: AccountTier): UpgradeOption[] {
  return [
    {
      plan: 'pro',
      label: 'Pro',
      available: tier === 'free',
    },
    {
      plan: 'enterprise',
      label: 'Enterprise',
      available: tier !== 'enterprise',
    },
  ];
}

export function getMcpCallsUsed(usage: UsagePayload): number {
  return typeof usage.mcpCallsUsed === 'number'
    ? usage.mcpCallsUsed
    : typeof usage.mcp_calls_used === 'number'
    ? usage.mcp_calls_used
    : 0;
}

function resolvePlan(usage: UsagePayload): string {
  return typeof usage.plan === 'string' && usage.plan.trim().length > 0
    ? usage.plan.trim().toLowerCase()
    : 'free';
}

export function buildAccountStatusResult(params: {
  userId: string;
  usage: UsagePayload;
  orgxWebUrl?: string | null;
}): { text: string; payload: Record<string, unknown> } {
  const plan = resolvePlan(params.usage);
  const tier = mapPlanToAccountTier(plan);
  const hourlyLimit = getTierHourlyLimit(tier);
  const mcpCallsUsed = getMcpCallsUsed(params.usage);
  const remainingCalls =
    hourlyLimit === null ? null : Math.max(hourlyLimit - mcpCallsUsed, 0);

  const text = [
    `Tier: ${tier} (plan=${plan})`,
    `MCP calls this period: ${mcpCallsUsed}${
      typeof params.usage.mcpCallsIncluded === 'number'
        ? ` / ${params.usage.mcpCallsIncluded}`
        : ''
    }`,
    `Edge limit (req/hr): ${
      hourlyLimit === null ? 'unlimited' : hourlyLimit
    }${remainingCalls === null ? '' : ` (remaining: ${remainingCalls})`}`,
    `Scaffolds: ${
      typeof params.usage.scaffoldsUsed === 'number'
        ? params.usage.scaffoldsUsed
        : 0
    }${
      typeof params.usage.scaffoldsIncluded === 'number'
        ? ` / ${params.usage.scaffoldsIncluded}`
        : ''
    }`,
  ].join('\n');

  return {
    text,
    payload: {
      user_id: params.userId,
      plan,
      tier,
      usage: params.usage,
      rate_limit_status: {
        window: '1h',
        limit_per_hour: hourlyLimit,
        remaining: remainingCalls,
      },
      available_upgrade_options: getUpgradeOptions(tier),
      pricing_url: buildPricingUrl(params.orgxWebUrl),
      billing_settings_url: buildBillingSettingsUrl(params.orgxWebUrl),
    },
  };
}

export function buildAccountUsageReportResult(params: {
  userId: string;
  usage: UsagePayload;
}): { text: string; payload: Record<string, unknown> } {
  const plan = resolvePlan(params.usage);
  const tier = mapPlanToAccountTier(plan);
  const limit = getTierHourlyLimit(tier);
  const mcpCallsUsed = getMcpCallsUsed(params.usage);
  const mcpCallsRemaining =
    limit === null ? null : Math.max(limit - mcpCallsUsed, 0);

  const text = [
    `Usage report (${plan})`,
    `Period: ${String(params.usage.periodStart ?? 'n/a')} → ${String(
      params.usage.periodEnd ?? 'n/a'
    )}`,
    `Credits: ${String(params.usage.creditsUsed ?? 0)} / ${String(
      params.usage.creditsIncluded ?? 'unlimited'
    )}`,
    `Scaffolds: ${String(params.usage.scaffoldsUsed ?? 0)} / ${String(
      params.usage.scaffoldsIncluded ?? 'unlimited'
    )}`,
    `MCP calls: ${mcpCallsUsed}${
      typeof params.usage.mcpCallsIncluded === 'number'
        ? ` / ${params.usage.mcpCallsIncluded}`
        : ''
    }`,
    `Edge limit remaining (hour): ${
      mcpCallsRemaining === null ? 'unlimited' : mcpCallsRemaining
    }`,
  ].join('\n');

  return {
    text,
    payload: {
      user_id: params.userId,
      plan,
      tier,
      usage: params.usage,
      edge_rate_limit: {
        window: '1h',
        limit_per_hour: limit,
        remaining: mcpCallsRemaining,
      },
    },
  };
}

export function buildEnterpriseUpgradeResult(orgxWebUrl?: string | null): {
  text: string;
  payload: Record<string, unknown>;
} {
  const contactSalesUrl = buildPricingUrl(orgxWebUrl, {
    plan: 'enterprise',
  });
  return {
    text: `Enterprise plans are handled via sales. Start here: ${contactSalesUrl}`,
    payload: {
      target_plan: 'enterprise',
      checkout_required: false,
      contact_sales_url: contactSalesUrl,
    },
  };
}

export function resolveCheckoutUrl(data: {
  checkout_url?: string;
  url?: string;
}): string | null {
  return (
    (typeof data.checkout_url === 'string' && data.checkout_url) ||
    (typeof data.url === 'string' && data.url) ||
    null
  );
}
