import {
  buildBillingSettingsUrl,
  buildPricingUrl,
} from "./shared/billingLinks";

export type AccountTier = "free" | "pro" | "enterprise";

export type UpgradeOption = {
  plan: "pro" | "enterprise";
  label: string;
  available: boolean;
};

type UsagePayload = Record<string, unknown>;

export type AgentCreditPackId = "credits_500" | "credits_2000";

export type AgentCreditPackOption = {
  id: AgentCreditPackId;
  label: string;
  credits: number;
  amount_cents: number;
  checkout_hint: string;
};

export function mapPlanToAccountTier(
  plan: string | null | undefined
): AccountTier {
  const normalized = (plan ?? "free").trim().toLowerCase();
  if (
    normalized === "enterprise" ||
    normalized === "enterprise_plus" ||
    normalized === "enterprise-pro"
  ) {
    return "enterprise";
  }
  if (
    normalized === "pro" ||
    normalized === "team" ||
    normalized === "starter" ||
    normalized === "growth" ||
    normalized === "scale"
  ) {
    return "pro";
  }
  return "free";
}

export function getTierHourlyLimit(tier: AccountTier): number | null {
  if (tier === "enterprise") return null;
  return tier === "pro" ? 1000 : 100;
}

export function getUpgradeOptions(tier: AccountTier): UpgradeOption[] {
  return [
    {
      plan: "pro",
      label: "Pro",
      available: tier === "free",
    },
    {
      plan: "enterprise",
      label: "Enterprise",
      available: tier !== "enterprise",
    },
  ];
}

export function getMcpCallsUsed(usage: UsagePayload): number {
  return typeof usage.mcpCallsUsed === "number"
    ? usage.mcpCallsUsed
    : typeof usage.mcp_calls_used === "number"
    ? usage.mcp_calls_used
    : 0;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatCredits(value: unknown): string {
  if (value === -1 || value === "unlimited") return "unlimited";
  const numeric = asNumber(value);
  return numeric.toLocaleString("en-US");
}

function formatDollars(cents: unknown): string {
  return `$${(asNumber(cents) / 100).toFixed(2)}`;
}

export function buildAgentCreditsUrl(
  orgxWebUrl?: string | null,
  source = "mcp"
): string {
  return buildBillingSettingsUrl(orgxWebUrl, {
    section: "agent-credits",
    source,
  });
}

export function getAgentCreditPacks(
  usage: UsagePayload
): AgentCreditPackOption[] {
  if (!Array.isArray(usage.creditPacks)) return [];

  return usage.creditPacks.flatMap((pack) => {
    if (!pack || typeof pack !== "object") return [];
    const value = pack as Record<string, unknown>;
    if (value.id !== "credits_500" && value.id !== "credits_2000") return [];
    const credits = asNumber(value.credits);
    const amountCents = asNumber(value.amountCents ?? value.amount_cents);
    if (credits <= 0 || amountCents <= 0) return [];

    return [
      {
        id: value.id,
        label:
          typeof value.label === "string"
            ? value.label
            : `${credits.toLocaleString("en-US")} agent credits`,
        credits,
        amount_cents: amountCents,
        checkout_hint: `Call account_upgrade with credit_pack="${value.id}"`,
      },
    ];
  });
}

export function buildAgentCreditsPayload(
  usage: UsagePayload,
  orgxWebUrl?: string | null
): Record<string, unknown> {
  const topUpUrl = buildAgentCreditsUrl(orgxWebUrl);
  return {
    available: usage.totalCreditsAvailable ?? usage.creditsRemaining ?? null,
    used: usage.creditsUsed ?? 0,
    included: usage.creditsIncluded ?? null,
    purchased: usage.creditsPurchased ?? 0,
    total_available: usage.totalCreditsAvailable ?? null,
    balance: usage.creditBalance ?? null,
    credit_unit_cents: usage.creditUnitCents ?? null,
    total_tokens: usage.totalTokens ?? 0,
    run_cost_cents: usage.totalRunCostCents ?? 0,
    agent_runs: usage.agentRunsActual ?? 0,
    ledger_available: usage.ledgerAvailable ?? null,
    packs: getAgentCreditPacks(usage),
    top_up_url: topUpUrl,
  };
}

function resolvePlan(usage: UsagePayload): string {
  return typeof usage.plan === "string" && usage.plan.trim().length > 0
    ? usage.plan.trim().toLowerCase()
    : "free";
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
  const agentCredits = buildAgentCreditsPayload(
    params.usage,
    params.orgxWebUrl
  );
  const topUpUrl = buildAgentCreditsUrl(params.orgxWebUrl);

  const text = [
    `Tier: ${tier} (plan=${plan})`,
    `Agent credits: ${formatCredits(
      agentCredits.available
    )} available (${formatCredits(agentCredits.used)} used, ${formatCredits(
      agentCredits.purchased
    )} purchased)`,
    `Top up agent credits: ${topUpUrl}`,
    `MCP calls this period: ${mcpCallsUsed}${
      typeof params.usage.mcpCallsIncluded === "number"
        ? ` / ${params.usage.mcpCallsIncluded}`
        : ""
    }`,
    `Edge limit (req/hr): ${hourlyLimit === null ? "unlimited" : hourlyLimit}${
      remainingCalls === null ? "" : ` (remaining: ${remainingCalls})`
    }`,
    `Scaffolds: ${
      typeof params.usage.scaffoldsUsed === "number"
        ? params.usage.scaffoldsUsed
        : 0
    }${
      typeof params.usage.scaffoldsIncluded === "number"
        ? ` / ${params.usage.scaffoldsIncluded}`
        : ""
    }`,
  ].join("\n");

  return {
    text,
    payload: {
      user_id: params.userId,
      plan,
      tier,
      usage: params.usage,
      rate_limit_status: {
        window: "1h",
        limit_per_hour: hourlyLimit,
        remaining: remainingCalls,
      },
      agent_credits: agentCredits,
      available_upgrade_options: getUpgradeOptions(tier),
      pricing_url: buildPricingUrl(params.orgxWebUrl),
      billing_settings_url: topUpUrl,
    },
  };
}

export function buildAccountUsageReportResult(params: {
  userId: string;
  usage: UsagePayload;
  orgxWebUrl?: string | null;
}): { text: string; payload: Record<string, unknown> } {
  const plan = resolvePlan(params.usage);
  const tier = mapPlanToAccountTier(plan);
  const limit = getTierHourlyLimit(tier);
  const mcpCallsUsed = getMcpCallsUsed(params.usage);
  const mcpCallsRemaining =
    limit === null ? null : Math.max(limit - mcpCallsUsed, 0);
  const agentCredits = buildAgentCreditsPayload(
    params.usage,
    params.orgxWebUrl
  );

  const text = [
    `Usage report (${plan})`,
    `Period: ${String(params.usage.periodStart ?? "n/a")} → ${String(
      params.usage.periodEnd ?? "n/a"
    )}`,
    `Agent credits: ${formatCredits(
      agentCredits.available
    )} available (${formatCredits(agentCredits.used)} used, ${formatCredits(
      agentCredits.included
    )} included, ${formatCredits(agentCredits.purchased)} purchased)`,
    `Token audit: ${formatCredits(
      agentCredits.total_tokens
    )} tokens across ${String(
      agentCredits.agent_runs
    )} agent runs (${formatDollars(
      agentCredits.run_cost_cents
    )} estimated cost)`,
    `Top up agent credits: ${String(agentCredits.top_up_url)}`,
    `Scaffolds: ${String(params.usage.scaffoldsUsed ?? 0)} / ${String(
      params.usage.scaffoldsIncluded ?? "unlimited"
    )}`,
    `MCP calls: ${mcpCallsUsed}${
      typeof params.usage.mcpCallsIncluded === "number"
        ? ` / ${params.usage.mcpCallsIncluded}`
        : ""
    }`,
    `Edge limit remaining (hour): ${
      mcpCallsRemaining === null ? "unlimited" : mcpCallsRemaining
    }`,
  ].join("\n");

  return {
    text,
    payload: {
      user_id: params.userId,
      plan,
      tier,
      usage: params.usage,
      edge_rate_limit: {
        window: "1h",
        limit_per_hour: limit,
        remaining: mcpCallsRemaining,
      },
      agent_credits: agentCredits,
      billing_settings_url: agentCredits.top_up_url,
    },
  };
}

export function buildAgentCreditCheckoutResult(params: {
  checkoutUrl: string;
  pack: AgentCreditPackOption;
}): { text: string; payload: Record<string, unknown> } {
  return {
    text: `Agent credit checkout URL: ${params.checkoutUrl}`,
    payload: {
      checkout_type: "agent_credit_pack",
      pack_id: params.pack.id,
      credits: params.pack.credits,
      amount_cents: params.pack.amount_cents,
      checkout_url: params.checkoutUrl,
    },
  };
}

export function buildEnterpriseUpgradeResult(orgxWebUrl?: string | null): {
  text: string;
  payload: Record<string, unknown>;
} {
  const contactSalesUrl = buildPricingUrl(orgxWebUrl, {
    plan: "enterprise",
  });
  return {
    text: `Enterprise plans are handled via sales. Start here: ${contactSalesUrl}`,
    payload: {
      target_plan: "enterprise",
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
    (typeof data.checkout_url === "string" && data.checkout_url) ||
    (typeof data.url === "string" && data.url) ||
    null
  );
}
