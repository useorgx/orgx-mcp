import { describe, expect, it } from 'vitest';

import {
  formatClientActivationExperience,
  type ClientActivationExperience,
} from '../src/clientActivationExperience';
import {
  formatClientSkillOnboarding,
  type ClientSkillOnboarding,
} from '../src/clientSkillOnboarding';
import { buildNewSessionWelcomeText } from '../src/sessionMessaging';
import {
  formatWelcomeBackDigest,
  type WelcomeBackDigest,
} from '../src/welcomeBackContext';

function approxTokens(value: string) {
  return Math.ceil(value.length / 4);
}

const PREVIOUS_NEW_SESSION_WELCOME = [
  "Welcome to OrgX! You're connected and ready to go.",
  '',
  "Here's what you can do:",
  '• **scaffold_initiative** — Create a full initiative with workstreams, milestones, and tasks in one call',
  "• **get_org_snapshot** — See a bird's-eye view of all your initiatives and progress",
  '• **list_entities** — Review pending decisions with `type=decision` and `status=pending`',
  "• **query_org_memory** — Search your organization's knowledge base",
  '• **recommend_next_action** — See the next best action for your workspace or initiative',
  '• **spawn_agent_task** — Delegate work to specialized AI agents',
  '',
  "Just describe what you'd like to accomplish and I'll pick the right tool.",
].join('\n');

const SAMPLE_WELCOME_BACK_DIGEST: WelcomeBackDigest = {
  workspace_id: 'ws-1',
  workspace_name: 'Launch Control',
  last_seen_at: '2026-03-24T12:00:00.000Z',
  live_url: 'https://useorgx.com/workspaces/ws-1',
  stats: {
    active_initiatives: 12,
    pending_decisions: 4,
    running_agents: 3,
  },
  recent_activity: [
    {
      title: 'Updated pricing plan',
      timestamp: '2026-03-24T12:30:00.000Z',
      actor_name: 'Alex',
    },
    {
      title: 'Created launch milestone',
      timestamp: '2026-03-24T12:31:00.000Z',
      actor_name: 'Casey',
    },
  ],
  pending_decisions: [
    {
      title: 'Approve launch',
      waiting_for: 'exec review',
      priority: 'high',
    },
    {
      title: 'Pick model vendor',
      waiting_for: 'finance',
      priority: 'medium',
    },
  ],
  next_actions: [
    'Review 2 pending decisions first.',
    'Open the live workspace view and inspect recent changes.',
  ],
};

const PREVIOUS_WELCOME_BACK_DIGEST = [
  'Welcome back. Launch Control has changed since your last session.',
  '',
  'Active initiatives: 12',
  'Pending decisions: 4',
  'Running agents: 3',
  '',
  'Recent activity since you were last here:',
  '- Updated pricing plan (Alex)',
  '- Created launch milestone (Casey)',
  '',
  'Pending decisions:',
  '- Approve launch [high] — waiting exec review',
  '- Pick model vendor [medium] — waiting finance',
  '',
  'Suggested next actions:',
  '- Review 2 pending decisions first.',
  '- Open the live workspace view and inspect recent changes.',
  '',
  'Live view: https://useorgx.com/workspaces/ws-1',
].join('\n');

const SAMPLE_SKILL_ONBOARDING: ClientSkillOnboarding = {
  source_client: 'chatgpt',
  first_use: true,
  seeded_defaults: false,
  message: 'Detected chatgpt. Start with one of the recommended skills below.',
  suggestions: [
    {
      skill_name: 'initiative_breakdown',
      title: 'Initiative Breakdown',
      reason: 'good first skill for this client; matches the client workflow domain',
      score: 8,
      already_available: false,
    },
    {
      skill_name: 'stakeholder_update',
      title: 'Stakeholder Update',
      reason: 'matches the client workflow domain',
      score: 5,
      already_available: false,
    },
    {
      skill_name: 'competitive_scan',
      title: 'Competitive Scan',
      reason: 'matches the client workflow domain',
      score: 4,
      already_available: false,
    },
  ],
  next_action: {
    tool: 'list_entities',
    label: 'Seed the default skill catalog',
    args: {
      type: 'skill',
      seed_defaults: true,
    },
  },
};

const PREVIOUS_SKILL_ONBOARDING = [
  '',
  'Detected chatgpt. Start with one of the recommended skills below.',
  'Recommended skills:',
  '- Initiative Breakdown: good first skill for this client; matches the client workflow domain',
  '- Stakeholder Update: matches the client workflow domain',
  '- Competitive Scan: matches the client workflow domain',
  'Tip: set `seed_defaults=true` on `list_entities type=skill` to seed the default skill catalog first.',
].join('\n');

const SAMPLE_ACTIVATION_EXPERIENCE: ClientActivationExperience = {
  source_client: 'chatgpt',
  playbook: 'ChatGPT guided planning loop',
  progress_pct: 60,
  completed_stages: ['D1', 'A1', 'A2'],
  next_stage: 'A3',
  optimization_hint:
    'Optimize for guided conversation: seed the catalog, scaffold from intent, then use the morning brief to keep the assistant anchored in ROI.',
  next_action: {
    tool: 'get_morning_brief',
    label: 'Review the morning brief',
    prompt:
      'Run get_morning_brief to connect the conversation to measurable value and next actions.',
  },
};

const PREVIOUS_ACTIVATION_EXPERIENCE = [
  '',
  'Activation progress: 60% via ChatGPT guided planning loop.',
  'Optimize for guided conversation: seed the catalog, scaffold from intent, then use the morning brief to keep the assistant anchored in ROI.',
  'Next: Run get_morning_brief to connect the conversation to measurable value and next actions.',
].join('\n');

describe('mcp efficiency impact', () => {
  it('cuts representative session-copy token usage materially', () => {
    const before = {
      newSession: PREVIOUS_NEW_SESSION_WELCOME,
      welcomeBack: PREVIOUS_WELCOME_BACK_DIGEST,
      skillOnboarding: PREVIOUS_SKILL_ONBOARDING,
      activation: PREVIOUS_ACTIVATION_EXPERIENCE,
    };
    const after = {
      newSession: buildNewSessionWelcomeText(),
      welcomeBack: formatWelcomeBackDigest(SAMPLE_WELCOME_BACK_DIGEST),
      skillOnboarding: formatClientSkillOnboarding(SAMPLE_SKILL_ONBOARDING),
      activation: formatClientActivationExperience(SAMPLE_ACTIVATION_EXPERIENCE),
    };

    const metrics = Object.fromEntries(
      Object.keys(before).map((key) => {
        const beforeText = before[key as keyof typeof before];
        const afterText = after[key as keyof typeof after];
        return [
          key,
          {
            beforeTokens: approxTokens(beforeText),
            afterTokens: approxTokens(afterText),
            savedTokens:
              approxTokens(beforeText) - approxTokens(afterText),
          },
        ];
      })
    );

    const totalBefore = Object.values(before).reduce(
      (sum, value) => sum + approxTokens(value),
      0
    );
    const totalAfter = Object.values(after).reduce(
      (sum, value) => sum + approxTokens(value),
      0
    );

    console.info(
      JSON.stringify(
        {
          metrics,
          totalBefore,
          totalAfter,
          savedTokens: totalBefore - totalAfter,
          savedPct: Math.round(((totalBefore - totalAfter) / totalBefore) * 100),
        },
        null,
        2
      )
    );

    expect(totalAfter).toBeLessThan(totalBefore);
    expect(totalAfter).toBeLessThanOrEqual(Math.floor(totalBefore * 0.45));
  });
});
