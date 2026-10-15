import type { SourceClient } from './cross-pollination';
import {
  getClientHookCoverage,
  type ClientHookCoverage,
} from './clientHookCoverage';
import { exampleIdempotencyKey } from './remedyErrors';
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
  /**
   * Fields the caller must supply before running a write hint (for example a
   * title or parent id). Write hints also carry a freshly minted
   * idempotency_key: reuse it only to retry the same intended change.
   */
  required_inputs?: string[];
};

export type ClientActivationExperience = {
  source_client: SourceClient | null;
  playbook: string;
  progress_pct: number;
  completed_stages: McpActivationStage[];
  next_stage: McpActivationStage | null;
  optimization_hint: string | null;
  next_action: ClientActivationAction | null;
  hook_coverage: ClientHookCoverage;
  celebration?: {
    title: string;
    message: string;
    next_action: ClientActivationAction | null;
    persistent_adoption: PersistentAdoptionSuggestion;
  };
};

export type PersistentAdoptionSuggestion = {
  label: string;
  suggestion: string;
  canonical_block_url: string;
};

// Persistent-adoption suggestion (positioning spine anti-spam guardrail): it
// rides the celebration, which only fires on the once-ever
// mcp_multi_tool_activation event — a completed first win — never on ordinary
// responses. Suggestion-phrased, never imperative.
const PERSISTENT_ADOPTION_SUGGESTION: PersistentAdoptionSuggestion = {
  label: 'Add the OrgX block to CLAUDE.md / AGENTS.md',
  suggestion:
    "Optional: add the OrgX block from https://mcp.useorgx.com/agents.md to this project's CLAUDE.md or AGENTS.md so future sessions keep continuity.",
  canonical_block_url: 'https://mcp.useorgx.com/agents.md',
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

// Every hint names an operation on the default v2 profile
// (tests/clientActivationExperience.spec.ts enforces it). A hint for a write
// is a template: `required_inputs` lists the fields the caller must supply,
// and buildClientActivationExperience mints a fresh idempotency_key for it on
// every response, so retries of one intended change reuse one key.
const ACTIVATION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'orgx_start_plan',
  'orgx_create_task',
  'orgx_submit_work_receipt',
]);

const DEFAULT_NEXT_ACTIONS_HINT: ClientActivationAction = {
  tool: 'orgx_get_next_actions',
  label: 'Ask OrgX for the highest-value next step',
  prompt:
    'Run orgx_get_next_actions for the current workspace to keep momentum after activation.',
  args: {},
};

function skillCatalogHint(label: string, prompt: string): ClientActivationAction {
  return { tool: 'orgx_search', label, prompt, args: { type: 'skill' } };
}

function startPlanHint(label: string, prompt: string): ClientActivationAction {
  return { tool: 'orgx_start_plan', label, prompt, args: {}, required_inputs: ['title'] };
}

function createTaskHint(label: string, prompt: string): ClientActivationAction {
  return {
    tool: 'orgx_create_task',
    label,
    prompt,
    args: {},
    required_inputs: ['title', 'workstream_id'],
  };
}

function operatorBriefHint(
  label: string,
  prompt: string,
  args: Record<string, unknown> = {}
): ClientActivationAction {
  return { tool: 'orgx_get_operator_brief', label, prompt, args };
}

function workspaceContextHint(label: string, prompt: string): ClientActivationAction {
  return { tool: 'orgx_get_workspace_context', label, prompt, args: {} };
}

function workReceiptHint(label: string, prompt: string): ClientActivationAction {
  return {
    tool: 'orgx_submit_work_receipt',
    label,
    prompt,
    args: {},
    required_inputs: ['receipt'],
  };
}

const CLIENT_PLAYBOOKS: Record<SourceClient, ClientPlaybook> = {
  cursor: {
    playbook: 'Cursor inline delivery loop',
    optimizationHint:
      'Optimize for inline suggestions: browse skills, scaffold structure, then ask for the next action without leaving the editor.',
    nextActions: {
      D1: skillCatalogHint(
        'Seed and browse the skill catalog',
        'Run orgx_search type=skill so Cursor can recommend skills inline.'
      ),
      A1: startPlanHint(
        'Scaffold the first initiative',
        'Run orgx_start_plan with a title and an idempotency_key to start the initiative plan and keep the workflow in-editor.'
      ),
      A2: createTaskHint(
        'Add the first executable task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key so Cursor has a concrete unit of work to recommend against.'
      ),
      A3: operatorBriefHint(
        'Open the operator brief',
        'Run orgx_get_operator_brief after the first structure is in place so Cursor can show ROI and next actions.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  claude: {
    playbook: 'Claude Code CLI execution loop',
    optimizationHint:
      'Optimize for CLI throughput: scaffold once, create or hand off a task, then use the operator brief as the continuity checkpoint.',
    nextActions: {
      D1: skillCatalogHint(
        'Inspect the skill catalog',
        'Run orgx_search type=skill to see the default CLI-friendly skills before you start scaffolding.'
      ),
      A1: startPlanHint(
        'Scaffold a CLI-native initiative',
        'Run orgx_start_plan with a title and an idempotency_key so Claude Code can work from a full hierarchy instead of ad-hoc tasks.'
      ),
      A2: createTaskHint(
        'Create the first task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key immediately after scaffolding so Claude Code can move from planning into execution.'
      ),
      A3: operatorBriefHint(
        'Checkpoint with the operator brief',
        'Run orgx_get_operator_brief to confirm value delivered and keep CLI sessions from losing continuity.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  chatgpt: {
    playbook: 'ChatGPT guided planning loop',
    optimizationHint:
      'Optimize for guided conversation: seed the catalog, scaffold from intent, then use the operator brief to keep the assistant anchored in ROI.',
    nextActions: {
      D1: skillCatalogHint(
        'Seed the default skill catalog',
        'Run orgx_search type=skill so ChatGPT can recommend skills by name in-thread.'
      ),
      A1: startPlanHint(
        'Create the initiative from conversation context',
        'Run orgx_start_plan with a title and an idempotency_key so ChatGPT can convert the conversation into a structured initiative.'
      ),
      A2: createTaskHint(
        'Create a first task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key so the assistant can reason about concrete execution next.'
      ),
      A3: operatorBriefHint(
        'Review the operator brief',
        'Run orgx_get_operator_brief to connect the conversation to measurable value and next actions.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  codex: {
    playbook: 'Codex local execution proof loop',
    optimizationHint:
      'Optimize for local execution proof: load workspace context, inspect active work, submit work receipts during execution, then read the operator brief before closing the session.',
    nextActions: {
      D1: workspaceContextHint(
        'Load the OrgX workspace context',
        'Run orgx_get_workspace_context so Codex can discover the current workspace, active work, and reporting contract.'
      ),
      A1: {
        tool: 'orgx_search',
        args: { type: 'initiative', limit: 10 },
        label: 'Inspect active initiatives',
        prompt:
          'Run orgx_search type=initiative so Codex can anchor local work to the right initiative instead of generic session context.',
      },
      A2: workReceiptHint(
        'Submit the first work receipt',
        'Run orgx_submit_work_receipt with the receipt and an idempotency_key after the first meaningful local result so OrgX can see proof, not just a chat summary.'
      ),
      A3: operatorBriefHint(
        'Read the operator brief',
        'Run orgx_get_operator_brief period=30d to verify decisions, artifacts, PRs, velocity, goals, and gaps from the same session.',
        { period: '30d' }
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  opencode: {
    playbook: 'OpenCode peer execution proof loop',
    optimizationHint:
      'Optimize for a narrow executor surface: load workspace context once, bind to active work, submit proof during execution, then checkpoint with the operator brief.',
    nextActions: {
      D1: workspaceContextHint(
        'Load the OrgX workspace context',
        'Run orgx_get_workspace_context so OpenCode can discover its workspace, active work, and reporting contract.'
      ),
      A1: {
        tool: 'orgx_search',
        args: { type: 'task', status: 'active', limit: 10 },
        label: 'Find active executable work',
        prompt:
          'Run orgx_search type=task status=active to bind OpenCode to a concrete unit of work.',
      },
      A2: workReceiptHint(
        'Submit the first work receipt',
        'Run orgx_submit_work_receipt with the receipt and an idempotency_key after the first meaningful result so the peer loop records durable proof.'
      ),
      A3: operatorBriefHint(
        'Read the operator brief',
        'Run orgx_get_operator_brief period=30d to verify decisions, artifacts, delivery, and remaining gaps.',
        { period: '30d' }
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  openclaw: {
    playbook: 'OpenClaw gateway proof loop',
    optimizationHint:
      'Optimize for local gateway handoff: load workspace context, bind to a task, submit work receipts, then checkpoint with the operator brief.',
    nextActions: {
      D1: workspaceContextHint(
        'Load the gateway workspace context',
        'Run orgx_get_workspace_context so the gateway client receives the current workspace and reporting contract.'
      ),
      A1: {
        tool: 'orgx_search',
        args: { type: 'task', status: 'active', limit: 10 },
        label: 'Find executable work',
        prompt:
          'Run orgx_search type=task status=active so OpenClaw can bind the local runner to a concrete task.',
      },
      A2: workReceiptHint(
        'Submit the first gateway work receipt',
        'Run orgx_submit_work_receipt with the receipt and an idempotency_key at the first meaningful result so reporting gets durable progress.'
      ),
      A3: operatorBriefHint(
        'Verify reporting in the operator brief',
        'Run orgx_get_operator_brief period=30d to confirm gateway work is visible in reporting.',
        { period: '30d' }
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  vscode: {
    playbook: 'VS Code planning and delivery loop',
    optimizationHint:
      'Optimize for context-in-editor: use skills for discovery, scaffold structure, then rely on the operator brief to keep value visible.',
    nextActions: {
      D1: skillCatalogHint(
        'Browse the skill catalog',
        'Run orgx_search type=skill to expose the default skills inside VS Code.'
      ),
      A1: startPlanHint(
        'Scaffold the initiative',
        'Run orgx_start_plan with a title and an idempotency_key so VS Code has a full hierarchy available for follow-up actions.'
      ),
      A2: createTaskHint(
        'Add the first execution task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key for one concrete task so the editor can optimize around real work instead of just structure.'
      ),
      A3: operatorBriefHint(
        'Review the brief',
        'Run orgx_get_operator_brief to expose ROI and keep the workflow anchored in delivery, not just planning.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  goose: {
    playbook: 'Goose operations response loop',
    optimizationHint:
      'Optimize for operational triage: use skills to orient, create structure fast, and checkpoint with the operator brief before expanding scope.',
    nextActions: {
      D1: skillCatalogHint(
        'Inspect the ops skill catalog',
        'Run orgx_search type=skill so Goose can start from the operations-heavy default catalog.'
      ),
      A1: startPlanHint(
        'Scaffold the incident or ops initiative',
        'Run orgx_start_plan with a title and an idempotency_key so the operational plan is structured before execution begins.'
      ),
      A2: createTaskHint(
        'Create the first task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key for one high-priority task so Goose can move from orientation into execution.'
      ),
      A3: operatorBriefHint(
        'Review the brief for operational signal',
        'Run orgx_get_operator_brief to surface what changed, what shipped, and what needs attention next.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  api: {
    playbook: 'API-driven automation loop',
    optimizationHint:
      'Optimize for predictable handoffs: keep the first structure/task/brief sequence tight so external clients can automate around it.',
    nextActions: {
      D1: skillCatalogHint(
        'Seed the skill catalog for API callers',
        'Run orgx_search type=skill to browse the default automation catalog.'
      ),
      A1: startPlanHint(
        'Scaffold a machine-readable initiative',
        'Run orgx_start_plan with a title and an idempotency_key so downstream API calls can operate on a stable hierarchy.'
      ),
      A2: createTaskHint(
        'Create the first task payload',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key so automation can immediately continue into execution.'
      ),
      A3: operatorBriefHint(
        'Fetch the operator brief payload',
        'Run orgx_get_operator_brief to get the canonical ROI and continuity payload for the workspace.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  webapp: {
    playbook: 'OrgX webapp guided workflow',
    optimizationHint:
      'Optimize for guided exploration: expose the catalog early, create structure quickly, and use the brief to keep value visible between sessions.',
    nextActions: {
      D1: skillCatalogHint(
        'Browse the default skill catalog',
        'Run orgx_search type=skill to expose the seeded catalog inside the webapp flow.'
      ),
      A1: startPlanHint(
        'Scaffold the initiative',
        'Run orgx_start_plan with a title and an idempotency_key so the web flow starts from a complete structure.'
      ),
      A2: createTaskHint(
        'Add an execution task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key for one concrete task so the workspace can drive follow-on actions from real work.'
      ),
      A3: operatorBriefHint(
        'Open the operator brief',
        'Run orgx_get_operator_brief to see value delivered and recommended follow-up work.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
  other: {
    playbook: 'General OrgX activation loop',
    optimizationHint:
      'Optimize for the shortest path: discover the catalog, create structure, add one task, then confirm value in the operator brief.',
    nextActions: {
      D1: skillCatalogHint(
        'Inspect the skill catalog',
        'Run orgx_search type=skill to see the default catalog before choosing a workflow.'
      ),
      A1: startPlanHint(
        'Scaffold the first initiative',
        'Run orgx_start_plan with a title and an idempotency_key to create the first structured workflow.'
      ),
      A2: createTaskHint(
        'Create the first task',
        'Run orgx_create_task with a title, workstream_id, and idempotency_key to create at least one task so OrgX can move from planning into execution.'
      ),
      A3: operatorBriefHint(
        'Review the operator brief',
        'Run orgx_get_operator_brief to connect the workflow to measurable value.'
      ),
      A4: DEFAULT_NEXT_ACTIONS_HINT,
    },
    celebrationNextAction: DEFAULT_NEXT_ACTIONS_HINT,
  },
};

/** Every activation hint, for contract tests. */
export function listClientActivationHints(): ClientActivationAction[] {
  return Object.values(CLIENT_PLAYBOOKS).flatMap((playbook) => [
    ...Object.values(playbook.nextActions),
    playbook.celebrationNextAction,
  ]);
}

/**
 * Return the hint a response carries. A write hint gets a fresh
 * idempotency_key per response; the static playbook entry is never mutated.
 */
export function materializeActivationAction(
  action: ClientActivationAction | null
): ClientActivationAction | null {
  if (!action) return null;
  if (!ACTIVATION_WRITE_TOOLS.has(action.tool)) return action;
  return {
    ...action,
    args: { ...action.args, idempotency_key: exampleIdempotencyKey(action.tool) },
  };
}

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
  const hookCoverage = getClientHookCoverage(sourceClient);
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
    next_action: materializeActivationAction(
      nextStage ? playbook.nextActions[nextStage] : null
    ),
    hook_coverage: hookCoverage,
    ...(celebrationTriggered
      ? {
          celebration: {
            title: 'Activation complete',
            message:
              'OrgX has now seen a full discovery → structure → execution → brief loop for this client. Keep compounding by following the next recommended workflow.',
            next_action: materializeActivationAction(
              playbook.celebrationNextAction
            ),
            persistent_adoption: PERSISTENT_ADOPTION_SUGGESTION,
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
    lines.push('Activation complete.');
    if (experience.celebration.next_action) {
      lines.push(
        `Next: ${experience.celebration.next_action.label}.`
      );
    }
    lines.push(experience.celebration.persistent_adoption.suggestion);
    return lines.join('\n');
  }

  if (!experience.next_stage || !experience.next_action) {
    return '';
  }

  lines.push(
    `Activation ${experience.progress_pct}% via ${experience.playbook}.`
  );
  lines.push(`Next: ${experience.next_action.label}.`);
  return lines.join('\n');
}
