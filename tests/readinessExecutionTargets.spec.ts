import { describe, expect, it } from 'vitest';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';

const provider = { configured: true, available: true, source: 'byok', key_hint: null, updated_at: null };
const readiness = {
  has_credentials: true,
  has_execution_credentials: true,
  has_subscription_accounts: false,
  providers: { openai: provider, anthropic: provider, gemini: provider, cursor: provider },
  can_execute: true,
  subscription_execution: {
    has_subscription_accounts: false,
    has_executable_subscription: false,
    has_interactive_route: false,
    has_cloud_route: false,
    accounts: [],
  },
  capabilities: {
    api_sdk: true,
    e2b_container: true,
    subscription_runner: false,
    codex_cloud: false,
    claude_max_runner: false,
    image_generation: true,
    cursor_background_agents: false,
  },
  setup_url: '/settings/execution',
};

describe('orgx_check_execution_readiness execution targets', () => {
  const schema = WIDGET_OUTPUT_SCHEMAS.check_execution_readiness;

  it('accepts the per-runtime availability the app reports', () => {
    const parsed = schema.safeParse({
      ...readiness,
      execution_targets: [
        { runtime: 'cloud_openai', label: 'OrgX cloud, OpenAI Responses', available: true, reason: null, default_model: null, may_fall_back_to: null },
        { runtime: 'cloud_claude', label: 'OrgX cloud, Claude Agent SDK', available: true, reason: null, default_model: null, may_fall_back_to: 'cloud_openai' },
        { runtime: 'managed_openai', label: 'OpenAI Agents API', available: false, reason: 'managed_runtime_disabled', default_model: 'gpt-5.6-sol', may_fall_back_to: null },
        {
          runtime: 'local', label: 'Paired local runner', available: true, reason: null, default_model: null, may_fall_back_to: null,
          runners: [{ provider: 'anthropic', label: 'Claude Code', driver: 'claude_code', last_heartbeat_at: '2026-11-07T22:00:00Z' }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts an app that does not report targets yet', () => {
    expect(schema.safeParse(readiness).success).toBe(true);
  });

  it('rejects a runtime orgx_start_agent_task does not accept', () => {
    const parsed = schema.safeParse({
      ...readiness,
      execution_targets: [{ runtime: 'e2b', label: 'x', available: true, reason: null, default_model: null, may_fall_back_to: null }],
    });
    expect(parsed.success).toBe(false);
  });
});
