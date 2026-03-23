import { describe, expect, it } from 'vitest';

import {
  buildWelcomeBackNextActions,
  createEmptyMcpSessionReentryState,
  formatWelcomeBackDigest,
  recordSuccessfulSessionTool,
  recordWelcomeBackShown,
  shouldShowWelcomeBack,
} from '../src/welcomeBackContext';

describe('welcomeBackContext', () => {
  it('shows welcome-back only after a meaningful inactivity gap', () => {
    const state = recordSuccessfulSessionTool(
      createEmptyMcpSessionReentryState(),
      '2026-03-23T10:00:00.000Z'
    );

    expect(
      shouldShowWelcomeBack({
        state,
        now: '2026-03-23T10:30:00.000Z',
      })
    ).toBe(false);
    expect(
      shouldShowWelcomeBack({
        state,
        now: '2026-03-23T12:00:00.000Z',
      })
    ).toBe(true);
  });

  it('does not repeat the welcome-back block until another successful session happens', () => {
    const initial = recordSuccessfulSessionTool(
      createEmptyMcpSessionReentryState(),
      '2026-03-23T10:00:00.000Z'
    );
    const welcomed = recordWelcomeBackShown(
      initial,
      '2026-03-23T12:00:00.000Z'
    );

    expect(
      shouldShowWelcomeBack({
        state: welcomed,
        now: '2026-03-23T13:00:00.000Z',
      })
    ).toBe(false);
    expect(
      shouldShowWelcomeBack({
        state: recordSuccessfulSessionTool(
          welcomed,
          '2026-03-23T13:30:00.000Z'
        ),
        now: '2026-03-23T15:30:01.000Z',
      })
    ).toBe(true);
  });

  it('formats a concise welcome-back digest with next actions', () => {
    const digest = formatWelcomeBackDigest({
      workspace_id: 'ws-1',
      workspace_name: 'Command Center',
      last_seen_at: '2026-03-23T10:00:00.000Z',
      live_url: 'https://useorgx.com/live?view=mission-control&workspace=ws-1',
      stats: {
        active_initiatives: 2,
        pending_decisions: 1,
        running_agents: 3,
      },
      recent_activity: [
        {
          title: 'Shipped onboarding telemetry',
          timestamp: '2026-03-23T11:00:00.000Z',
          actor_name: 'Engineering Agent',
        },
      ],
      pending_decisions: [
        {
          title: 'Approve rollout',
          waiting_for: '2 hours',
          priority: 'high',
        },
      ],
      next_actions: buildWelcomeBackNextActions({
        pendingDecisionCount: 1,
        recentActivityCount: 1,
        hasWorkspace: true,
      }),
    });

    expect(digest).toContain('Welcome back.');
    expect(digest).toContain('Pending decisions: 1');
    expect(digest).toContain('Approve rollout [high]');
    expect(digest).toContain('Suggested next actions:');
    expect(digest).toContain('Live view:');
  });
});
