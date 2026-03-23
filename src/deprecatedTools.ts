type ToolArgs = Record<string, unknown>;

export type DeprecatedToolWarning = {
  deprecatedToolId: string;
  replacementToolId: string;
  replacementAction?: string;
  routed: boolean;
};

const DEPRECATION_ANNOUNCED_AT_ISO = '2026-03-23T00:00:00.000Z';
export const DEPRECATION_WINDOW_DAYS = 90;
export const DEPRECATION_SUNSET_AT_ISO = new Date(
  Date.parse(DEPRECATION_ANNOUNCED_AT_ISO) +
    DEPRECATION_WINDOW_DAYS * 24 * 60 * 60 * 1000
).toISOString();
export const DEPRECATION_SUNSET_HEADER = new Date(
  DEPRECATION_SUNSET_AT_ISO
).toUTCString();

type DeprecatedToolRoute = {
  replacementToolId: string;
  replacementAction?: string;
  route?: (args: ToolArgs) => ToolArgs | null;
};

type FlatHierarchyEntity = {
  type: 'initiative' | 'workstream' | 'milestone' | 'task';
  record: ToolArgs;
  ref?: string;
  originalIndex: number;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBillingCycle(value: unknown): 'monthly' | 'annual' | undefined {
  const normalized = asNonEmptyString(value);
  return normalized === 'monthly' || normalized === 'annual'
    ? normalized
    : undefined;
}

function compactArgs(args: ToolArgs): ToolArgs {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );
}

function asRecord(value: unknown): ToolArgs | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ToolArgs)
    : null;
}

function asEntityType(
  value: unknown
): FlatHierarchyEntity['type'] | undefined {
  const normalized = asNonEmptyString(value);
  if (
    normalized === 'initiative' ||
    normalized === 'workstream' ||
    normalized === 'milestone' ||
    normalized === 'task'
  ) {
    return normalized;
  }
  return undefined;
}

function sortBySequence<T extends { record: ToolArgs; originalIndex: number }>(
  values: T[]
): T[] {
  return [...values].sort((a, b) => {
    const aSequence = asFiniteNumber(a.record.sequence ?? a.record.order);
    const bSequence = asFiniteNumber(b.record.sequence ?? b.record.order);
    if (aSequence !== undefined && bSequence !== undefined) {
      if (aSequence !== bSequence) return aSequence - bSequence;
    } else if (aSequence !== undefined) {
      return -1;
    } else if (bSequence !== undefined) {
      return 1;
    }
    return a.originalIndex - b.originalIndex;
  });
}

function omitKeys(record: ToolArgs, keys: string[]): ToolArgs {
  const omit = new Set(keys);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !omit.has(key))
  );
}

function toScaffoldNode(record: ToolArgs, keysToOmit: string[]): ToolArgs {
  const node = omitKeys(record, keysToOmit);
  const name = asNonEmptyString(node.name);
  if (!asNonEmptyString(node.title) && name) {
    node.title = name;
  }
  return node;
}

function routeBatchCreateEntitiesToScaffoldInitiative(
  args: ToolArgs
): ToolArgs | null {
  const rawEntities = Array.isArray(args.entities) ? args.entities : null;
  if (!rawEntities || rawEntities.length === 0) return null;

  const entities: FlatHierarchyEntity[] = [];
  const refIndex = new Map<string, FlatHierarchyEntity>();

  for (let index = 0; index < rawEntities.length; index += 1) {
    const record = asRecord(rawEntities[index]);
    const type = asEntityType(record?.type);
    if (!record || !type) {
      return null;
    }

    const ref = asNonEmptyString(record.ref);
    if (ref) {
      if (refIndex.has(ref)) return null;
      refIndex.set(ref, { type, record, ref, originalIndex: index });
    }

    entities.push({ type, record, ref: ref ?? undefined, originalIndex: index });
  }

  const initiativeEntities = entities.filter((entity) => entity.type === 'initiative');
  if (initiativeEntities.length !== 1) return null;

  const initiative = initiativeEntities[0]!;
  const initiativeRef = initiative.ref;
  const hasChildren = entities.some((entity) => entity.type !== 'initiative');
  if (hasChildren && !initiativeRef) {
    return null;
  }

  const workstreams = entities.filter((entity) => entity.type === 'workstream');
  const milestones = entities.filter((entity) => entity.type === 'milestone');
  const tasks = entities.filter((entity) => entity.type === 'task');

  const workstreamsByRef = new Map<string, FlatHierarchyEntity>();
  for (const workstream of workstreams) {
    const parentInitiativeRef = asNonEmptyString(workstream.record.initiative_ref);
    const parentInitiativeId = asNonEmptyString(workstream.record.initiative_id);
    if (parentInitiativeId) return null;
    if (initiativeRef && parentInitiativeRef !== initiativeRef) return null;
    if (!workstream.ref) {
      const hasMilestoneChildren = milestones.some(
        (milestone) =>
          asNonEmptyString(milestone.record.workstream_ref) === workstream.ref
      );
      const hasTaskChildren = tasks.some(
        (task) => asNonEmptyString(task.record.workstream_ref) === workstream.ref
      );
      if (hasMilestoneChildren || hasTaskChildren) return null;
    } else {
      workstreamsByRef.set(workstream.ref, workstream);
    }
  }

  const milestonesByRef = new Map<string, FlatHierarchyEntity>();
  const milestonesByWorkstreamRef = new Map<string, FlatHierarchyEntity[]>();
  for (const milestone of milestones) {
    const parentInitiativeRef = asNonEmptyString(milestone.record.initiative_ref);
    const parentInitiativeId = asNonEmptyString(milestone.record.initiative_id);
    const parentWorkstreamRef = asNonEmptyString(milestone.record.workstream_ref);
    const parentWorkstreamId = asNonEmptyString(milestone.record.workstream_id);
    if (parentInitiativeId || parentWorkstreamId || !parentWorkstreamRef) return null;
    if (initiativeRef && parentInitiativeRef && parentInitiativeRef !== initiativeRef) {
      return null;
    }
    if (!workstreamsByRef.has(parentWorkstreamRef)) return null;
    if (milestone.ref) milestonesByRef.set(milestone.ref, milestone);
    const group = milestonesByWorkstreamRef.get(parentWorkstreamRef) ?? [];
    group.push(milestone);
    milestonesByWorkstreamRef.set(parentWorkstreamRef, group);
  }

  const tasksByMilestoneRef = new Map<string, FlatHierarchyEntity[]>();
  for (const task of tasks) {
    const parentInitiativeRef = asNonEmptyString(task.record.initiative_ref);
    const parentInitiativeId = asNonEmptyString(task.record.initiative_id);
    const parentWorkstreamRef = asNonEmptyString(task.record.workstream_ref);
    const parentWorkstreamId = asNonEmptyString(task.record.workstream_id);
    const parentMilestoneRef = asNonEmptyString(task.record.milestone_ref);
    const parentMilestoneId = asNonEmptyString(task.record.milestone_id);
    if (
      parentInitiativeId ||
      parentWorkstreamId ||
      parentMilestoneId ||
      !parentWorkstreamRef ||
      !parentMilestoneRef
    ) {
      return null;
    }
    if (initiativeRef && parentInitiativeRef && parentInitiativeRef !== initiativeRef) {
      return null;
    }
    const parentMilestone = milestonesByRef.get(parentMilestoneRef);
    if (!parentMilestone) return null;
    if (asNonEmptyString(parentMilestone.record.workstream_ref) !== parentWorkstreamRef) {
      return null;
    }
    const group = tasksByMilestoneRef.get(parentMilestoneRef) ?? [];
    group.push(task);
    tasksByMilestoneRef.set(parentMilestoneRef, group);
  }

  const scaffoldWorkstreams = sortBySequence(workstreams).map((workstream) => {
    const workstreamRef = workstream.ref;
    const scaffoldMilestones = workstreamRef
      ? sortBySequence(milestonesByWorkstreamRef.get(workstreamRef) ?? []).map(
          (milestone) => {
            const milestoneRef = milestone.ref;
            const scaffoldTasks = milestoneRef
              ? sortBySequence(tasksByMilestoneRef.get(milestoneRef) ?? []).map(
                  (task) =>
                    toScaffoldNode(task.record, [
                      'type',
                      'initiative_id',
                      'initiative_ref',
                      'workstream_id',
                      'workstream_ref',
                      'milestone_id',
                      'milestone_ref',
                    ])
                )
              : [];

            const scaffoldMilestone = toScaffoldNode(milestone.record, [
              'type',
              'initiative_id',
              'initiative_ref',
              'workstream_id',
              'workstream_ref',
            ]);
            if (scaffoldTasks.length > 0) {
              scaffoldMilestone.tasks = scaffoldTasks;
            }
            return scaffoldMilestone;
          }
        )
      : [];

    const scaffoldWorkstream = toScaffoldNode(workstream.record, [
      'type',
      'initiative_id',
      'initiative_ref',
    ]);
    if (scaffoldMilestones.length > 0) {
      scaffoldWorkstream.milestones = scaffoldMilestones;
    }
    return scaffoldWorkstream;
  });

  const scaffoldArgs = toScaffoldNode(initiative.record, ['type', 'ref']);
  if (!asNonEmptyString(scaffoldArgs.title)) {
    return null;
  }

  if (scaffoldWorkstreams.length > 0) {
    scaffoldArgs.workstreams = scaffoldWorkstreams;
  }

  const topLevelWorkspaceId = asNonEmptyString(args.workspace_id);
  const topLevelCommandCenterId = asNonEmptyString(args.command_center_id);
  const topLevelOwnerId = asNonEmptyString(args.owner_id);
  const topLevelUserId = asNonEmptyString(args.user_id);

  return compactArgs({
    ...scaffoldArgs,
    workspace_id: topLevelWorkspaceId ?? asNonEmptyString(scaffoldArgs.workspace_id),
    command_center_id:
      topLevelCommandCenterId ?? asNonEmptyString(scaffoldArgs.command_center_id),
    owner_id: topLevelOwnerId,
    user_id: topLevelUserId,
    continue_on_error:
      typeof args.continue_on_error === 'boolean' ? args.continue_on_error : undefined,
    launch_after_create:
      typeof args.launch_after_create === 'boolean' ? args.launch_after_create : undefined,
    concurrency: asFiniteNumber(args.concurrency),
  });
}

const DEPRECATED_TOOL_ROUTES: Record<string, DeprecatedToolRoute> = {
  get_pending_decisions: {
    replacementToolId: 'list_entities',
    route: (args) => {
      const urgencyFilter = asNonEmptyString(args.urgency_filter);
      if (urgencyFilter && urgencyFilter !== 'all') {
        return null;
      }

      return compactArgs({
        type: 'decision',
        status: 'pending',
        limit: asFiniteNumber(args.limit),
        initiative_id: asNonEmptyString(args.initiative_id),
      });
    },
  },
  get_decision_history: {
    replacementToolId: 'query_org_memory',
    route: (args) => {
      const topic = asNonEmptyString(args.topic);
      if (!topic || asNonEmptyString(args.initiative_id)) {
        return null;
      }

      return compactArgs({
        query: topic,
        scope: 'decisions',
        limit: asFiniteNumber(args.limit),
      });
    },
  },
  score_next_up_queue: {
    replacementToolId: 'recommend_next_action',
    route: (args) => {
      const initiativeId = asNonEmptyString(args.initiative_id);
      return compactArgs({
        entity_type: initiativeId ? 'initiative' : 'workspace',
        entity_id: initiativeId,
        workspace_id: asNonEmptyString(args.workspace_id),
        command_center_id: asNonEmptyString(args.command_center_id),
        limit: asFiniteNumber(args.limit),
      });
    },
  },
  batch_create_entities: {
    replacementToolId: 'scaffold_initiative',
    route: routeBatchCreateEntitiesToScaffoldInitiative,
  },
  start_autonomous_session: {
    replacementToolId: 'entity_action',
    replacementAction: 'auto_run',
  },
  complete_plan: {
    replacementToolId: 'entity_action',
    replacementAction: 'complete_plan',
  },
  get_outcome_attribution: {
    replacementToolId: 'get_morning_brief',
  },
  create_checkout_session: {
    replacementToolId: 'account_upgrade',
    route: (args) => {
      const plan = asNonEmptyString(args.plan);
      if (plan && plan !== 'starter' && plan !== 'team') {
        return null;
      }

      return compactArgs({
        target_plan: 'pro',
        billing_cycle: asBillingCycle(args.billing_cycle),
        user_id: asNonEmptyString(args.user_id),
      });
    },
  },
};

export function resolveDeprecatedToolCall(
  toolId: string,
  args: ToolArgs = {}
): {
  resolvedToolId: string;
  resolvedArgs: ToolArgs;
  warning?: DeprecatedToolWarning;
} {
  const route = DEPRECATED_TOOL_ROUTES[toolId];
  if (!route) {
    return { resolvedToolId: toolId, resolvedArgs: args };
  }

  if (!route.route) {
    return {
      resolvedToolId: toolId,
      resolvedArgs: args,
      warning: {
        deprecatedToolId: toolId,
        replacementToolId: route.replacementToolId,
        replacementAction: route.replacementAction,
        routed: false,
      },
    };
  }

  const routedArgs = route.route(args);
  if (!routedArgs) {
    return {
      resolvedToolId: toolId,
      resolvedArgs: args,
      warning: {
        deprecatedToolId: toolId,
        replacementToolId: route.replacementToolId,
        replacementAction: route.replacementAction,
        routed: false,
      },
    };
  }

  return {
    resolvedToolId: route.replacementToolId,
    resolvedArgs: routedArgs,
    warning: {
      deprecatedToolId: toolId,
      replacementToolId: route.replacementToolId,
      replacementAction: route.replacementAction,
      routed: true,
    },
  };
}

export function withDeprecatedToolWarningHeaders(
  response: Response,
  warning?: DeprecatedToolWarning
): Response {
  if (!warning) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('x-orgx-deprecated-tool', warning.deprecatedToolId);
  headers.set('x-orgx-replacement-tool', warning.replacementToolId);
  headers.set('x-orgx-deprecation-routed', warning.routed ? 'true' : 'false');
  headers.set('x-orgx-deprecation-sunset-at', DEPRECATION_SUNSET_AT_ISO);
  headers.set(
    'x-orgx-deprecation-window-days',
    String(DEPRECATION_WINDOW_DAYS)
  );
  headers.set('Sunset', DEPRECATION_SUNSET_HEADER);

  if (warning.replacementAction) {
    headers.set('x-orgx-replacement-action', warning.replacementAction);
  }

  const replacement = warning.replacementAction
    ? `${warning.replacementToolId} (action=${warning.replacementAction})`
    : warning.replacementToolId;
  const suffix = warning.routed
    ? ` The request was routed automatically. Migrate before ${DEPRECATION_SUNSET_AT_ISO}.`
    : ` The legacy tool was left in place for compatibility. Migrate before ${DEPRECATION_SUNSET_AT_ISO}.`;
  headers.set(
    'Warning',
    `299 orgx-mcp "${warning.deprecatedToolId} is deprecated; use ${replacement}.${suffix}"`
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
