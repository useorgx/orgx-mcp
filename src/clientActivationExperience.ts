import type { SourceClient } from './cross-pollination';
import type {
  McpActivationStage,
  McpActivationState,
  McpActivationTelemetryEvent,
} from './mcpActivationTracker';

export type ClientActivationAction = {
  tool: string;
  label: string;
  prompt: string;
  args?: Record<string, unknown>;
};

export type ClientActivationExperience = {
  source_client: SourceClient | null;
  playbook: string;
  progress_pct: number;
  completed_stages: McpActivationStage[];
  next_stage: McpActivationStage | null;
  optimization_hint: string | null;
  next_action: ClientActivationAction | null;
  celebration?: {
    title: string;
    message: string;
    next_action: ClientActivationAction | null;
  };
};

const ACTIVATION_STAGE_ORDER: McpActivationStage[] = [
  'D1',
  'A1',
  'A2',
  'A3',
  'A4',
];

type ClientPlaybook = {
  playbook: string;
  optimizationHint: string;
  nextActions: Record<McpActivationStage, ClientActivationAction>;
  celebrationNextAction: ClientActivationAction;
};

const DEFAULT_RECOMMEND_NEXT_ACTION: ClientActivationAction = {
  tool: 'recommend_next_action',
  label: 'Ask OrgX for the highest-value next step',
  prompt:
    'Run recommend_next_action for the current workspace to keep momentum after activation.',
};

const CLIENT_PLAYBOOKS: Record<SourceClient, ClientPlaybook> = {
  cursor: {
    playbook: 'Cursor inline delivery loop',
    optimizationHint:
      'Optimize for inline suggestions: browse skills, scaffold structure, then ask for the next action without leaving the editor.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Seed and browse the skill catalog',
        prompt:
          'Run list_entities type=skill with seed_defaults=true so Cursor can recommend skills inline.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold the first initiative',
        prompt:
          'Use scaffold_initiative to create the initiative hierarchy in one pass and keep the workflow in-editor.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Add the first executable task',
        prompt:
          'Create at least one task so Cursor has a concrete unit of work to recommend against.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Open the morning brief',
        prompt:
          'Run get_morning_brief after the first structure is in place so Cursor can show ROI and next actions.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  claude: {
    playbook: 'Claude Code CLI execution loop',
    optimizationHint:
      'Optimize for CLI throughput: scaffold once, create or hand off a task, then use the morning brief as the continuity checkpoint.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Inspect the skill catalog',
        prompt:
          'Run list_entities type=skill to see the default CLI-friendly skills before you start scaffolding.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold a CLI-native initiative',
        prompt:
          'Use scaffold_initiative so Claude Code can work from a full hierarchy instead of ad-hoc tasks.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Create the first task',
        prompt:
          'Create the first task immediately after scaffolding so Claude Code can move from planning into execution.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Checkpoint with the morning brief',
        prompt:
          'Run get_morning_brief to confirm value delivered and keep CLI sessions from losing continuity.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  chatgpt: {
    playbook: 'ChatGPT guided planning loop',
    optimizationHint:
      'Optimize for guided conversation: seed the catalog, scaffold from intent, then use the morning brief to keep the assistant anchored in ROI.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Seed the default skill catalog',
        prompt:
          'Run list_entities type=skill with seed_defaults=true so ChatGPT can recommend skills by name in-thread.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Create the initiative from conversation context',
        prompt:
          'Use scaffold_initiative so ChatGPT can convert the conversation into a structured initiative.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Create a first task or milestone',
        prompt:
          'Create at least one task or milestone so the assistant can reason about concrete execution next.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Review the morning brief',
        prompt:
          'Run get_morning_brief to connect the conversation to measurable value and next actions.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  vscode: {
    playbook: 'VS Code planning and delivery loop',
    optimizationHint:
      'Optimize for context-in-editor: use skills for discovery, scaffold structure, then rely on the morning brief to keep value visible.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Browse the skill catalog',
        prompt:
          'Run list_entities type=skill to expose the default skills inside VS Code.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold the initiative',
        prompt:
          'Use scaffold_initiative so VS Code has a full hierarchy available for follow-up actions.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Add the first execution task',
        prompt:
          'Create one concrete task so the editor can optimize around real work instead of just structure.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Review the brief',
        prompt:
          'Run get_morning_brief to expose ROI and keep the workflow anchored in delivery, not just planning.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  goose: {
    playbook: 'Goose operations response loop',
    optimizationHint:
      'Optimize for operational triage: use skills to orient, create structure fast, and checkpoint with the morning brief before expanding scope.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Inspect the ops skill catalog',
        prompt:
          'Run list_entities type=skill so Goose can start from the operations-heavy default catalog.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold the incident or ops initiative',
        prompt:
          'Use scaffold_initiative so the operational plan is structured before execution begins.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Create the first task',
        prompt:
          'Create one high-priority task so Goose can move from orientation into execution.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Review the brief for operational signal',
        prompt:
          'Run get_morning_brief to surface what changed, what shipped, and what needs attention next.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  api: {
    playbook: 'API-driven automation loop',
    optimizationHint:
      'Optimize for predictable handoffs: keep the first structure/task/brief sequence tight so external clients can automate around it.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Seed the skill catalog for API callers',
        prompt:
          'Run list_entities type=skill with seed_defaults=true to establish the default automation catalog.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold a machine-readable initiative',
        prompt:
          'Use scaffold_initiative so downstream API calls can operate on a stable hierarchy.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Create the first task payload',
        prompt:
          'Create at least one task so automation can immediately continue into execution.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Fetch the morning brief payload',
        prompt:
          'Run get_morning_brief to get the canonical ROI and continuity payload for the workspace.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  webapp: {
    playbook: 'OrgX webapp guided workflow',
    optimizationHint:
      'Optimize for guided exploration: expose the catalog early, create structure quickly, and use the brief to keep value visible between sessions.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Browse the default skill catalog',
        prompt:
          'Run list_entities type=skill to expose the seeded catalog inside the webapp flow.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold the initiative',
        prompt:
          'Use scaffold_initiative so the web flow starts from a complete structure.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Add an execution task',
        prompt:
          'Create one concrete task so the workspace can drive follow-on actions from real work.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Open the morning brief',
        prompt:
          'Run get_morning_brief to see value delivered and recommended follow-up work.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
  other: {
    playbook: 'General OrgX activation loop',
    optimizationHint:
      'Optimize for the shortest path: discover the catalog, create structure, add one task, then confirm value in the morning brief.',
    nextActions: {
      D1: {
        tool: 'list_entities',
        label: 'Inspect the skill catalog',
        prompt:
          'Run list_entities type=skill to see the default catalog before choosing a workflow.',
        args: { type: 'skill', seed_defaults: true },
      },
      A1: {
        tool: 'scaffold_initiative',
        label: 'Scaffold the first initiative',
        prompt:
          'Use scaffold_initiative to create the first structured workflow.',
      },
      A2: {
        tool: 'create_entity',
        label: 'Create the first task',
        prompt:
          'Create at least one task so OrgX can move from planning into execution.',
      },
      A3: {
        tool: 'get_morning_brief',
        label: 'Review the morning brief',
        prompt:
          'Run get_morning_brief to connect the workflow to measurable value.',
      },
      A4: DEFAULT_RECOMMEND_NEXT_ACTION,
    },
    celebrationNextAction: DEFAULT_RECOMMEND_NEXT_ACTION,
  },
};

function resolveCompletedStages(
  state: McpActivationState | null | undefined
): McpActivationStage[] {
  if (!state?.milestones) return [];
  return ACTIVATION_STAGE_ORDER.filter((stage) => Boolean(state.milestones[stage]));
}

export function buildClientActivationExperience(params: {
  state: McpActivationState | null | undefined;
  sourceClient?: SourceClient | null;
  events?: McpActivationTelemetryEvent[];
}): ClientActivationExperience | null {
  const sourceClient = params.sourceClient ?? params.state?.source_client ?? null;
  if (!sourceClient && !params.state?.milestones) return null;

  const playbook = CLIENT_PLAYBOOKS[sourceClient ?? 'other'];
  const completedStages = resolveCompletedStages(params.state);
  const nextStage =
    ACTIVATION_STAGE_ORDER.find((stage) => !completedStages.includes(stage)) ??
    null;
  const progressPct = Math.round(
    (completedStages.length / ACTIVATION_STAGE_ORDER.length) * 100
  );
  const celebrationTriggered = (params.events ?? []).some(
    (event) => event.event === 'mcp_multi_tool_activation'
  );

  return {
    source_client: sourceClient,
    playbook: playbook.playbook,
    progress_pct: progressPct,
    completed_stages: completedStages,
    next_stage: nextStage,
    optimization_hint: nextStage ? playbook.optimizationHint : null,
    next_action: nextStage ? playbook.nextActions[nextStage] : null,
    ...(celebrationTriggered
      ? {
          celebration: {
            title: 'Activation complete',
            message:
              'OrgX has now seen a full discovery → structure → execution → brief loop for this client. Keep compounding by following the next recommended workflow.',
            next_action: playbook.celebrationNextAction,
          },
        }
      : {}),
  };
}

export function formatClientActivationExperience(
  experience: ClientActivationExperience | null
): string {
  if (!experience) return '';

  const lines: string[] = [''];

  if (experience.celebration) {
    lines.push(`Activation complete: ${experience.celebration.message}`);
    if (experience.celebration.next_action) {
      lines.push(
        `Next: ${experience.celebration.next_action.prompt}`
      );
    }
    return lines.join('\n');
  }

  if (!experience.next_stage || !experience.next_action) {
    return '';
  }

  lines.push(
    `Activation progress: ${experience.progress_pct}% via ${experience.playbook}.`
  );
  if (experience.optimization_hint) {
    lines.push(experience.optimization_hint);
  }
  lines.push(`Next: ${experience.next_action.prompt}`);
  return lines.join('\n');
}
