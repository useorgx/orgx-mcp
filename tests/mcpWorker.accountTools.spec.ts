import { describe, expect, it } from "vitest";

import {
  buildAgentCreditCheckoutResult,
  buildAccountStatusResult,
  buildAccountUsageReportResult,
  buildEnterpriseUpgradeResult,
  getTierHourlyLimit,
  mapPlanToAccountTier,
  resolveCheckoutUrl,
} from "../src/accountTools";

describe("worker account tools", () => {
  it("maps paid and enterprise plan aliases to account tiers", () => {
    expect(mapPlanToAccountTier("starter")).toBe("pro");
    expect(mapPlanToAccountTier("team")).toBe("pro");
    expect(mapPlanToAccountTier("enterprise_plus")).toBe("enterprise");
    expect(mapPlanToAccountTier("free")).toBe("free");
    expect(getTierHourlyLimit("free")).toBe(100);
    expect(getTierHourlyLimit("pro")).toBe(1000);
    expect(getTierHourlyLimit("enterprise")).toBeNull();
  });

  it("builds account status payloads with upgrade links and remaining calls", () => {
    const result = buildAccountStatusResult({
      userId: "user-123",
      orgxWebUrl: "https://useorgx.com",
      usage: {
        plan: "starter",
        mcp_calls_used: 125,
        mcpCallsIncluded: 5000,
        scaffoldsUsed: 2,
        scaffoldsIncluded: 10,
        creditsUsed: 128,
        creditsPurchased: 500,
        totalCreditsAvailable: 872,
        totalTokens: 345678,
        totalRunCostCents: 246,
        agentRunsActual: 7,
        creditPacks: [
          {
            id: "credits_500",
            label: "500 agent credits",
            credits: 500,
            amountCents: 2900,
          },
        ],
      },
    });

    expect(result.text).toContain("Tier: pro (plan=starter)");
    expect(result.text).toContain("Agent credits: 872 available");
    expect(result.text).toContain(
      "Top up agent credits: https://useorgx.com/settings/billing?section=agent-credits&source=mcp"
    );
    expect(result.payload).toMatchObject({
      user_id: "user-123",
      tier: "pro",
      rate_limit_status: {
        window: "1h",
        limit_per_hour: 1000,
        remaining: 875,
      },
      pricing_url: "https://useorgx.com/pricing",
      billing_settings_url:
        "https://useorgx.com/settings/billing?section=agent-credits&source=mcp",
      agent_credits: {
        available: 872,
        used: 128,
        purchased: 500,
        total_tokens: 345678,
        run_cost_cents: 246,
        agent_runs: 7,
        packs: [
          {
            id: "credits_500",
            amount_cents: 2900,
            checkout_hint:
              'Call account_upgrade with credit_pack="credits_500"',
          },
        ],
      },
    });
  });

  it("builds account usage reports from billing payloads", () => {
    const result = buildAccountUsageReportResult({
      userId: "user-123",
      orgxWebUrl: "https://useorgx.com",
      usage: {
        plan: "enterprise",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        creditsUsed: 42,
        creditsIncluded: "unlimited",
        scaffoldsUsed: 4,
        scaffoldsIncluded: "unlimited",
        mcpCallsUsed: 2500,
        creditsPurchased: 2000,
        totalCreditsAvailable: "unlimited",
        totalTokens: 1234567,
        totalRunCostCents: 987,
        agentRunsActual: 3,
        creditPacks: [
          {
            id: "credits_2000",
            label: "2,000 agent credits",
            credits: 2000,
            amountCents: 7900,
          },
        ],
      },
    });

    expect(result.text).toContain("Usage report (enterprise)");
    expect(result.text).toContain("Edge limit remaining (hour): unlimited");
    expect(result.text).toContain(
      "Token audit: 1,234,567 tokens across 3 agent runs"
    );
    expect(result.text).toContain(
      "Top up agent credits: https://useorgx.com/settings/billing?section=agent-credits&source=mcp"
    );
    expect(result.payload).toMatchObject({
      user_id: "user-123",
      tier: "enterprise",
      edge_rate_limit: {
        window: "1h",
        limit_per_hour: null,
        remaining: null,
      },
      agent_credits: {
        available: "unlimited",
        used: 42,
        purchased: 2000,
        total_tokens: 1234567,
        run_cost_cents: 987,
        agent_runs: 3,
      },
      billing_settings_url:
        "https://useorgx.com/settings/billing?section=agent-credits&source=mcp",
    });
  });

  it("builds credit checkout and enterprise upgrade handoffs", () => {
    const creditCheckout = buildAgentCreditCheckoutResult({
      checkoutUrl: "https://checkout.example/credits",
      pack: {
        id: "credits_500",
        label: "500 agent credits",
        credits: 500,
        amount_cents: 2900,
        checkout_hint: 'Call account_upgrade with credit_pack="credits_500"',
      },
    });
    expect(creditCheckout.text).toContain("https://checkout.example/credits");
    expect(creditCheckout.payload).toMatchObject({
      checkout_type: "agent_credit_pack",
      pack_id: "credits_500",
      credits: 500,
      amount_cents: 2900,
      checkout_url: "https://checkout.example/credits",
    });

    const enterprise = buildEnterpriseUpgradeResult("https://useorgx.com");
    expect(enterprise.text).toContain("/pricing?plan=enterprise");
    expect(enterprise.payload).toMatchObject({
      target_plan: "enterprise",
      checkout_required: false,
      contact_sales_url: "https://useorgx.com/pricing?plan=enterprise",
    });

    expect(
      resolveCheckoutUrl({ checkout_url: "https://checkout.example/a" })
    ).toBe("https://checkout.example/a");
    expect(resolveCheckoutUrl({ url: "https://checkout.example/b" })).toBe(
      "https://checkout.example/b"
    );
    expect(resolveCheckoutUrl({})).toBeNull();
  });
});
