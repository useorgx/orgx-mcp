import { describe, expect, it } from 'vitest';

import {
  buildAccountStatusResult,
  buildAccountUsageReportResult,
  buildEnterpriseUpgradeResult,
  getTierHourlyLimit,
  mapPlanToAccountTier,
  resolveCheckoutUrl,
} from '../src/accountTools';

describe('worker account tools', () => {
  it('maps paid and enterprise plan aliases to account tiers', () => {
    expect(mapPlanToAccountTier('starter')).toBe('pro');
    expect(mapPlanToAccountTier('team')).toBe('pro');
    expect(mapPlanToAccountTier('enterprise_plus')).toBe('enterprise');
    expect(mapPlanToAccountTier('free')).toBe('free');
    expect(getTierHourlyLimit('free')).toBe(100);
    expect(getTierHourlyLimit('pro')).toBe(1000);
    expect(getTierHourlyLimit('enterprise')).toBeNull();
  });

  it('builds account status payloads with upgrade links and remaining calls', () => {
    const result = buildAccountStatusResult({
      userId: 'user-123',
      orgxWebUrl: 'https://useorgx.com',
      usage: {
        plan: 'starter',
        mcp_calls_used: 125,
        mcpCallsIncluded: 5000,
        scaffoldsUsed: 2,
        scaffoldsIncluded: 10,
      },
    });

    expect(result.text).toContain('Tier: pro (plan=starter)');
    expect(result.payload).toMatchObject({
      user_id: 'user-123',
      tier: 'pro',
      rate_limit_status: {
        window: '1h',
        limit_per_hour: 1000,
        remaining: 875,
      },
      pricing_url: 'https://useorgx.com/pricing',
      billing_settings_url: 'https://useorgx.com/settings/billing',
    });
  });

  it('builds account usage reports from billing payloads', () => {
    const result = buildAccountUsageReportResult({
      userId: 'user-123',
      usage: {
        plan: 'enterprise',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        creditsUsed: 42,
        creditsIncluded: 'unlimited',
        scaffoldsUsed: 4,
        scaffoldsIncluded: 'unlimited',
        mcpCallsUsed: 2500,
      },
    });

    expect(result.text).toContain('Usage report (enterprise)');
    expect(result.text).toContain('Edge limit remaining (hour): unlimited');
    expect(result.payload).toMatchObject({
      user_id: 'user-123',
      tier: 'enterprise',
      edge_rate_limit: {
        window: '1h',
        limit_per_hour: null,
        remaining: null,
      },
    });
  });

  it('builds the enterprise upgrade handoff and resolves checkout urls', () => {
    const enterprise = buildEnterpriseUpgradeResult('https://useorgx.com');
    expect(enterprise.text).toContain('/pricing?plan=enterprise');
    expect(enterprise.payload).toMatchObject({
      target_plan: 'enterprise',
      checkout_required: false,
      contact_sales_url: 'https://useorgx.com/pricing?plan=enterprise',
    });

    expect(resolveCheckoutUrl({ checkout_url: 'https://checkout.example/a' })).toBe(
      'https://checkout.example/a'
    );
    expect(resolveCheckoutUrl({ url: 'https://checkout.example/b' })).toBe(
      'https://checkout.example/b'
    );
    expect(resolveCheckoutUrl({})).toBeNull();
  });
});
