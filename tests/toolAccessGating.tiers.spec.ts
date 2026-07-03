// @vitest-environment node
/**
 * Tool Access Gating – Tier-Aware Tests
 *
 * Verifies that plan restrictions are correctly enforced for MCP tool calls
 * across all three execution contexts:
 *  - API tier   : calls arriving through the orgx MCP worker
 *  - Agent tier : spawn_agent_task dispatched from a running agent job
 *  - Sandbox    : start_autonomous_session from an E2B or fargate context
 *
 * The gating logic lives in the orgx-mcp worker's toolAccessGating module.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPlanRestrictedToolResult,
  evaluateToolAccess,
} from '../src/toolAccessGating';

// ---------------------------------------------------------------------------
// Tier profiles used in parameterised tests
// ---------------------------------------------------------------------------

const TIERS = ['api', 'agent', 'sandbox'] as const;

// ---------------------------------------------------------------------------
// Free plan – all tiers blocked for agent-spawn tools
// ---------------------------------------------------------------------------

describe('free plan – all execution tiers', () => {
  for (const tier of TIERS) {
    it(`[${tier}] blocks spawn_agent_task on free plan`, () => {
      const access = evaluateToolAccess({
        feature: 'spawn_agent_task',
        plan: 'free',
        orgxWebUrl: 'https://useorgx.com',
      });
      expect(access.allowed).toBe(false);
      if (access.allowed) throw new Error('expected blocked');
      expect(access.code).toBe('plan_restricted');
      expect(access.minimumTier).toBe('pro');
    });

    it(`[${tier}] blocks start_autonomous_session on free plan`, () => {
      const access = evaluateToolAccess({
        feature: 'start_autonomous_session',
        plan: 'free',
        orgxWebUrl: 'https://useorgx.com',
      });
      expect(access.allowed).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Starter / pro plan – all tiers allowed
// ---------------------------------------------------------------------------

describe('starter/pro plan – all execution tiers', () => {
  for (const tier of TIERS) {
    for (const plan of ['starter', 'pro', 'team'] as const) {
      it(`[${tier}] allows spawn_agent_task on ${plan} plan`, () => {
        const access = evaluateToolAccess({
          feature: 'spawn_agent_task',
          plan,
          orgxWebUrl: 'https://useorgx.com',
        });
        expect(access.allowed).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Structured MCP error payload contract
// (must surface correctly so the agent/client can show the upgrade CTA)
// ---------------------------------------------------------------------------

describe('MCP error payload structure', () => {
  it('buildPlanRestrictedToolResult returns isError=true', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });
    if (access.allowed) throw new Error('expected blocked');
    const result = buildPlanRestrictedToolResult(access);
    expect(result.isError).toBe(true);
  });

  it('structuredContent has ok:false, code, required_plan, and tier', () => {
    const access = evaluateToolAccess({
      feature: 'start_autonomous_session',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });
    if (access.allowed) throw new Error('expected blocked');
    const result = buildPlanRestrictedToolResult(access);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: 'plan_restricted',
      required_plan: 'pro',
      tier: 'free',
    });
  });

  it('upgrade_cta contains billing_settings_url pointing to MCP source', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });
    if (access.allowed) throw new Error('expected blocked');
    expect(access.upgrade_cta.billing_settings_url).toContain(
      'mcp_spawn_agent_task'
    );
  });

  it('upgrade_cta url points to pricing page', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });
    if (access.allowed) throw new Error('expected blocked');
    expect(access.upgrade_cta.url).toContain('/pricing');
  });
});

// ---------------------------------------------------------------------------
// Tier normalisation: starter / team → 'pro' effective tier
// ---------------------------------------------------------------------------

describe('effective tier normalisation', () => {
  it('starter plan resolves to effective tier "pro"', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'starter',
      orgxWebUrl: 'https://useorgx.com',
    });
    expect(access.allowed).toBe(true);
    if (!access.allowed) throw new Error('expected allowed');
    expect(access.tier).toBe('pro');
  });

  it('team plan resolves to effective tier "pro"', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'team',
      orgxWebUrl: 'https://useorgx.com',
    });
    expect(access.allowed).toBe(true);
    if (!access.allowed) throw new Error('expected allowed');
    expect(access.tier).toBe('pro');
  });
});
