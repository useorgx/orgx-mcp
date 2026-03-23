import type { SourceClient } from './cross-pollination';

export const MCP_ACTIVATION_STORAGE_KEY = 'mcp_activation_state_v1';

export const MCP_ACTIVATION_MILESTONES = {
  D1: {
    event: 'mcp_skill_catalog_viewed',
    label: 'Skill catalog viewed',
  },
  A1: {
    event: 'mcp_structure_created',
    label: 'Workflow structure created',
  },
  A2: {
    event: 'mcp_task_created',
    label: 'Task created',
  },
  A3: {
    event: 'mcp_morning_brief_viewed',
    label: 'Morning brief viewed',
  },
  A4: {
    event: 'mcp_multi_tool_activation',
    label: 'Multi-tool workflow completed',
  },
} as const;

export type McpActivationStage = keyof typeof MCP_ACTIVATION_MILESTONES;
export type McpActivationEventName =
  (typeof MCP_ACTIVATION_MILESTONES)[McpActivationStage]['event'];

export type McpActivationState = {
  version: 1;
  source_client: SourceClient | null;
  workspace_id: string | null;
  initiative_id: string | null;
  milestones: Partial<Record<McpActivationStage, string>>;
};

export type McpActivationTelemetryEvent = {
  event: McpActivationEventName;
  properties: Record<string, unknown>;
};

type ActivationObservation = {
  toolId: string;
  args?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  sourceClient?: SourceClient | null;
  workspaceId?: string | null;
  initiativeId?: string | null;
  now?: string;
};

export function createEmptyMcpActivationState(): McpActivationState {
  return {
    version: 1,
    source_client: null,
    workspace_id: null,
    initiative_id: null,
    milestones: {},
  };
}

export function parseStoredMcpActivationState(
  value: unknown
): McpActivationState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const milestones =
    record.milestones &&
    typeof record.milestones === 'object' &&
    !Array.isArray(record.milestones)
      ? Object.fromEntries(
          Object.entries(record.milestones).filter(
            ([stage, timestamp]) =>
              stage in MCP_ACTIVATION_MILESTONES &&
              typeof timestamp === 'string' &&
              timestamp.length > 0
          )
        )
      : {};

  return {
    version: 1,
    source_client:
      typeof record.source_client === 'string'
        ? (record.source_client as SourceClient)
        : null,
    workspace_id:
      typeof record.workspace_id === 'string' ? record.workspace_id : null,
    initiative_id:
      typeof record.initiative_id === 'string' ? record.initiative_id : null,
    milestones,
  };
}

function countNestedTasks(value: unknown): number {
  if (!value) return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countNestedTasks(item), 0);
  }
  if (typeof value !== 'object') return 0;

  const record = value as Record<string, unknown>;
  let count =
    record.type === 'task' || record.entity_type === 'task' ? 1 : 0;

  for (const key of ['tasks', 'workstreams', 'milestones', 'hierarchy', 'data']) {
    if (key in record) {
      count += countNestedTasks(record[key]);
    }
  }

  return count;
}

function marksStructureCreated(observation: ActivationObservation): boolean {
  if (observation.toolId === 'scaffold_initiative') return true;
  if (observation.toolId !== 'create_entity') return false;

  const entityType =
    typeof observation.args?.type === 'string'
      ? observation.args.type
      : typeof observation.data?.type === 'string'
      ? observation.data.type
      : null;
  return (
    entityType === 'initiative' ||
    entityType === 'workstream' ||
    entityType === 'milestone'
  );
}

function marksTaskCreated(observation: ActivationObservation): boolean {
  if (observation.toolId === 'scaffold_initiative') {
    return countNestedTasks(observation.data) > 0;
  }

  if (observation.toolId !== 'create_entity') return false;
  const entityType =
    typeof observation.args?.type === 'string'
      ? observation.args.type
      : typeof observation.data?.type === 'string'
      ? observation.data.type
      : null;
  return entityType === 'task';
}

function marksSkillCatalogViewed(observation: ActivationObservation): boolean {
  return (
    observation.toolId === 'list_entities' &&
    observation.args?.type === 'skill'
  );
}

function marksMorningBriefViewed(observation: ActivationObservation): boolean {
  return observation.toolId === 'get_morning_brief';
}

export function applyMcpActivationObservation(
  currentState: McpActivationState | null | undefined,
  observation: ActivationObservation
): {
  state: McpActivationState;
  events: McpActivationTelemetryEvent[];
} {
  const now = observation.now ?? new Date().toISOString();
  const state = {
    ...(currentState ?? createEmptyMcpActivationState()),
  };
  const nextState: McpActivationState = {
    ...state,
    source_client:
      observation.sourceClient ?? state.source_client ?? null,
    workspace_id: observation.workspaceId ?? state.workspace_id ?? null,
    initiative_id: observation.initiativeId ?? state.initiative_id ?? null,
    milestones: { ...(state.milestones ?? {}) },
  };
  const events: McpActivationTelemetryEvent[] = [];

  const markStage = (
    stage: McpActivationStage,
    extraProperties?: Record<string, unknown>
  ) => {
    if (nextState.milestones[stage]) return;
    nextState.milestones[stage] = now;
    events.push({
      event: MCP_ACTIVATION_MILESTONES[stage].event,
      properties: {
        activation_stage: stage,
        activation_label: MCP_ACTIVATION_MILESTONES[stage].label,
        activation_track: 'mcp-skills',
        tool_id: observation.toolId,
        source_client: nextState.source_client,
        workspace_id: nextState.workspace_id,
        initiative_id: nextState.initiative_id,
        ...extraProperties,
      },
    });
  };

  if (marksSkillCatalogViewed(observation)) {
    markStage('D1');
  }
  if (marksStructureCreated(observation)) {
    markStage('A1');
  }
  if (marksTaskCreated(observation)) {
    markStage('A2', {
      task_count:
        observation.toolId === 'scaffold_initiative'
          ? countNestedTasks(observation.data)
          : 1,
    });
  }
  if (marksMorningBriefViewed(observation)) {
    markStage('A3');
  }

  if (
    nextState.milestones.A1 &&
    nextState.milestones.A2 &&
    nextState.milestones.A3
  ) {
    markStage('A4');
  }

  return { state: nextState, events };
}
