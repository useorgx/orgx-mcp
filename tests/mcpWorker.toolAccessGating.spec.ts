import { describe, expect, it } from 'vitest';

import {
  buildPlanRestrictedToolResult,
  evaluateToolAccess,
} from '../src/toolAccessGating';

describe('worker tool access gating', () => {
  it('blocks free plans from spawn_agent_task with an upgrade CTA', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });

    expect(access.allowed).toBe(false);
    if (access.allowed) {
      throw new Error('expected free plan to be blocked');
    }

    expect(access).toMatchObject({
      code: 'plan_restricted',
      tier: 'free',
      minimumTier: 'pro',
      upgrade_cta: {
        target_plan: 'pro',
        billing_settings_url:
          'https://useorgx.com/settings/billing?source=mcp_spawn_agent_task',
      },
    });
    expect(access.upgrade_cta.url).toContain('/pricing');
  });

  it('treats starter/team plans as paid access for gated tools', () => {
    const access = evaluateToolAccess({
      feature: 'spawn_agent_task',
      plan: 'starter',
      orgxWebUrl: 'https://useorgx.com',
    });

    expect(access.allowed).toBe(true);
    if (!access.allowed) {
      throw new Error('expected starter plan to pass');
    }
    expect(access.tier).toBe('pro');
  });

  it('builds a structured MCP error payload for blocked autonomous sessions', () => {
    const access = evaluateToolAccess({
      feature: 'start_autonomous_session',
      plan: 'free',
      orgxWebUrl: 'https://useorgx.com',
    });

    expect(access.allowed).toBe(false);
    if (access.allowed) {
      throw new Error('expected free plan to be blocked');
    }

    const result = buildPlanRestrictedToolResult(access);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      code: 'plan_restricted',
      required_plan: 'pro',
      tier: 'free',
    });
  });
});
