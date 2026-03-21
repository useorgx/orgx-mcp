import type { BatchCreateSummary } from './batchCreate';

export type ScaffoldBatchBuildResult = {
  batch: Array<Record<string, unknown>>;
  initiativeRef: string;
  wsRefs: string[];
  msRefs: string[][];
  taskRefs: string[][][];
};

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function omitKeys(obj: Record<string, unknown>, keys: Set<string>) {
  return Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.has(key))
  );
}

function ensureRef(input: Record<string, unknown>, fallback: string): string {
  return typeof input.ref === 'string' && input.ref.trim().length > 0
    ? input.ref.trim()
    : fallback;
}

const TOKENS_PER_HOUR = 6_500;
const USD_PER_1K_TOKENS = 0.012;

const DOMAIN_ALIASES: Record<string, string> = {
  eng: 'engineering',
  engineering: 'engineering',
  product: 'product',
  prod: 'product',
  design: 'design',
  ux: 'design',
  ui: 'design',
  marketing: 'marketing',
  growth: 'marketing',
  gtm: 'marketing',
  mark: 'marketing',
  sales: 'sales',
  revenue: 'sales',
  sage: 'sales',
  ops: 'operations',
  operation: 'operations',
  operations: 'operations',
  pace: 'product',
  eli: 'engineering',
  dana: 'design',
};

const DOMAIN_DEFAULT_AGENT_ID: Record<string, string> = {
  product: 'product-agent',
  engineering: 'engineering-agent',
  marketing: 'marketing-agent',
  sales: 'sales-agent',
  operations: 'operations-agent',
  design: 'design-agent',
  orchestrator: 'orchestrator-agent',
};

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  const direct = DOMAIN_ALIASES[normalized];
  if (direct) return direct;

  if (normalized.includes('product')) return 'product';
  if (normalized.includes('engineer') || normalized === 'eng')
    return 'engineering';
  if (normalized.includes('design') || normalized.includes('ux') || normalized.includes('ui')) {
    return 'design';
  }
  if (
    normalized.includes('market') ||
    normalized.includes('growth') ||
    normalized.includes('gtm')
  ) {
    return 'marketing';
  }
  if (normalized.includes('sales') || normalized.includes('revenue')) {
    return 'sales';
  }
  if (normalized.includes('ops') || normalized.includes('operation')) {
    return 'operations';
  }
  if (normalized.includes('orchestr')) return 'orchestrator';
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function titleCaseFromAgentId(agentId: string): string {
  return agentId
    .replace(/-agent$/i, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveAssignedAgentIds(
  entity: Record<string, unknown>,
  metadata: Record<string, unknown>
): string[] {
  const ownerAgent =
    typeof entity.ownerAgent === 'string' ? entity.ownerAgent.trim() : '';
  const primaryAgent =
    typeof entity.primaryAgent === 'string' ? entity.primaryAgent.trim() : '';
  const metadataOwnerAgent =
    typeof metadata.ownerAgent === 'string' ? metadata.ownerAgent.trim() : '';
  const metadataPrimaryAgent =
    typeof metadata.primaryAgent === 'string'
      ? metadata.primaryAgent.trim()
      : '';

  return dedupeStrings([
    ...parseStringArray(entity.assigned_agent_ids),
    ...parseStringArray(entity.assignedAgentIds),
    ...parseStringArray(metadata.assigned_agent_ids),
    ...parseStringArray(metadata.assignedAgentIds),
    ownerAgent,
    primaryAgent,
    metadataOwnerAgent,
    metadataPrimaryAgent,
  ]);
}

function resolveAssignedAgentNames(
  entity: Record<string, unknown>,
  metadata: Record<string, unknown>
): string[] {
  return dedupeStrings([
    ...parseStringArray(entity.assigned_agent_names),
    ...parseStringArray(entity.assignedAgentNames),
    ...parseStringArray(metadata.assigned_agent_names),
    ...parseStringArray(metadata.assignedAgentNames),
  ]);
}

function defaultAgentIdForDomain(domain: string | null): string | null {
  if (!domain) return null;
  return DOMAIN_DEFAULT_AGENT_ID[domain] ?? null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function withDefaultSequence(
  entity: Record<string, unknown>,
  fallbackSequence: number
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...entity };
  const existing = toFiniteNumber(next.sequence ?? next.order);
  if (existing && existing > 0) return next;
  next.sequence = fallbackSequence;
  return next;
}

function hasAnyKey(entity: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => key in entity);
}

function hasDependsOn(entity: Record<string, unknown>): boolean {
  return hasAnyKey(entity, [
    'depends_on',
    'dependsOn',
    'dependencies',
    'dependency_ids',
    'dependencyIds',
  ]);
}

function defaultTaskList(milestoneTitle: string): Record<string, unknown>[] {
  const title =
    typeof milestoneTitle === 'string' && milestoneTitle.trim().length > 0
      ? milestoneTitle.trim()
      : 'Milestone';
  return [
    {
      title: `${title}: discovery`,
      description: `Gather requirements and unblock dependencies for ${title}.`,
      type: 'research',
      auto_generated: true,
    },
    {
      title: `${title}: implementation`,
      description: `Execute core work for ${title}.`,
      type: 'implement',
      auto_generated: true,
    },
    {
      title: `${title}: validation`,
      description: `Validate outputs and handoff for ${title}.`,
      type: 'review',
      auto_generated: true,
    },
  ];
}

function estimateTaskHours(task: Record<string, unknown>): number {
  const explicitHours = toFiniteNumber(
    task.estimated_hours ?? task.estimatedHours ?? task.expected_duration_hours
  );
  if (explicitHours && explicitHours > 0) return explicitHours;

  const type =
    typeof task.type === 'string' ? task.type.toLowerCase().trim() : '';
  const base =
    type === 'implement'
      ? 4
      : type === 'create'
      ? 3
      : type === 'research'
      ? 2
      : type === 'review'
      ? 1.5
      : 2.5;
  const text = `${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
  const complexityBoost = [
    'integration',
    'migration',
    'architecture',
    'performance',
    'security',
    'cross-team',
  ].some((token) => text.includes(token))
    ? 1.4
    : 1;
  return Math.max(1, Math.round(base * complexityBoost * 10) / 10);
}

function withEstimateDefaults(
  entity: Record<string, unknown>,
  defaults: { expectedTokens: number; expectedHours: number }
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...entity };

  const hasTokenField = hasAnyKey(next, [
    'expected_tokens',
    'expectedTokens',
    'token_budget',
    'tokenBudget',
    'tokens',
  ]);
  const hasBudgetField = hasAnyKey(next, [
    'expected_budget_usd',
    'expectedBudgetUsd',
    'budget_usd',
    'budgetUsd',
  ]);
  const hasDurationHours = hasAnyKey(next, [
    'expected_duration_hours',
    'expectedDurationHours',
    'duration_hours',
    'durationHours',
  ]);

  if (!hasTokenField) {
    next.expected_tokens = defaults.expectedTokens;
  }
  if (!hasDurationHours) {
    next.expected_duration_hours = Number(defaults.expectedHours.toFixed(1));
  }
  if (!hasBudgetField) {
    const budget = (defaults.expectedTokens / 1000) * USD_PER_1K_TOKENS;
    next.expected_budget_usd = Number(budget.toFixed(4));
  }

  return next;
}

/**
 * Convert nested scaffold input into a flat ref-based batch suitable for
 * batch_create_entities. This keeps scaffold_initiative as syntactic sugar
 * over the ref engine (single creation path, predictable semantics).
 */
export function buildScaffoldInitiativeBatch(
  args: Record<string, unknown>
): ScaffoldBatchBuildResult {
  const initiativeRef = 'initiative';
  const workstreamsInput = Array.isArray(args.workstreams)
    ? (args.workstreams as unknown[])
    : [];

  const batch: Array<Record<string, unknown>> = [];

  const initiativeEntity = withDefaultSequence(
    omitKeys(
      safeRecord(args),
      new Set([
        'workstreams',
        'launch_after_create',
        'continue_on_error',
        'concurrency',
        // owner_id intentionally NOT omitted — it must propagate into the
        // batch so the POST handler can set it on the initiative row.
        'user_id',
      ])
    ),
    1
  );
  const hasExplicitWorkstreams = workstreamsInput.length > 0;
  const autoPlanOverride =
    typeof args.auto_plan === 'boolean'
      ? args.auto_plan
      : typeof args.autoPlan === 'boolean'
      ? args.autoPlan
      : null;

  delete initiativeEntity.autoPlan;
  initiativeEntity.auto_plan =
    autoPlanOverride ?? !hasExplicitWorkstreams;

  // Ensure scaffolded initiatives default to public live visibility so the
  // /live/[initiativeId] room is accessible immediately after creation.
  // Callers can override by passing metadata.live.visibility explicitly.
  const existingMetadata = safeRecord(initiativeEntity.metadata);
  const existingLive = safeRecord(existingMetadata.live);
  if (!existingLive.visibility) {
    initiativeEntity.metadata = {
      ...existingMetadata,
      live: { ...existingLive, visibility: 'public' },
    };
  }

  batch.push({
    ...initiativeEntity,
    type: 'initiative',
    ref: initiativeRef,
  });

  const wsRefs: string[] = [];
  const msRefs: string[][] = [];
  const taskRefs: string[][][] = [];

  for (let wsIdx = 0; wsIdx < workstreamsInput.length; wsIdx++) {
    const ws = safeRecord(workstreamsInput[wsIdx]);
    const wsRef = ensureRef(ws, `ws-${wsIdx + 1}`);
    wsRefs[wsIdx] = wsRef;

    const wsMilestones = Array.isArray(ws.milestones)
      ? (ws.milestones as unknown[])
      : [];
    msRefs[wsIdx] = [];
    taskRefs[wsIdx] = [];

    const wsEntity = withDefaultSequence(
      omitKeys(ws, new Set(['milestones'])),
      wsIdx + 1
    );
    const normalizedDomain = normalizeDomain(
      wsEntity.domain ?? wsEntity.persona ?? null
    );
    const wsMetadata =
      wsEntity.metadata && typeof wsEntity.metadata === 'object'
        ? (wsEntity.metadata as Record<string, unknown>)
        : {};

    const wsExpectedTokens = Math.max(18_000, wsMilestones.length * 12_000);
    const wsExpectedHours = wsExpectedTokens / TOKENS_PER_HOUR;
    const wsWithEstimates = withEstimateDefaults(wsEntity, {
      expectedTokens: wsExpectedTokens,
      expectedHours: wsExpectedHours,
    });
    const wsAssignedAgentIds = resolveAssignedAgentIds(wsWithEstimates, wsMetadata);
    const wsAssignedAgentNames = resolveAssignedAgentNames(
      wsWithEstimates,
      wsMetadata
    );
    const wsDefaultAgentId =
      wsAssignedAgentIds[0] ?? defaultAgentIdForDomain(normalizedDomain);
    const wsDefaultAgentName =
      wsAssignedAgentNames[0] ??
      (wsDefaultAgentId ? titleCaseFromAgentId(wsDefaultAgentId) : null);
    if (!wsWithEstimates.persona && normalizedDomain) {
      wsWithEstimates.persona = normalizedDomain;
    }
    if (
      wsDefaultAgentId &&
      !hasAnyKey(wsWithEstimates, ['assigned_agent_ids', 'assignedAgentIds'])
    ) {
      wsWithEstimates.assigned_agent_ids = [wsDefaultAgentId];
    }
    if (
      wsDefaultAgentName &&
      !hasAnyKey(wsWithEstimates, ['assigned_agent_names', 'assignedAgentNames'])
    ) {
      wsWithEstimates.assigned_agent_names = [wsDefaultAgentName];
    }
    const wsMetadataAssignedIds =
      wsAssignedAgentIds.length > 0
        ? wsAssignedAgentIds
        : wsDefaultAgentId
        ? [wsDefaultAgentId]
        : [];
    const wsMetadataAssignedNames =
      wsAssignedAgentNames.length > 0
        ? wsAssignedAgentNames
        : wsDefaultAgentName
        ? [wsDefaultAgentName]
        : [];
    wsWithEstimates.metadata = {
      ...wsMetadata,
      ref: wsRef,
      domain: normalizedDomain ?? wsMetadata.domain ?? null,
      agent_domain: normalizedDomain ?? wsMetadata.agent_domain ?? null,
      ...(wsMetadataAssignedIds.length > 0
        ? { assigned_agent_ids: wsMetadataAssignedIds }
        : {}),
      ...(wsMetadataAssignedNames.length > 0
        ? { assigned_agent_names: wsMetadataAssignedNames }
        : {}),
    };

    batch.push({
      ...wsWithEstimates,
      type: 'workstream',
      ref: wsRef,
      initiative_ref: initiativeRef,
    });

    for (let msIdx = 0; msIdx < wsMilestones.length; msIdx++) {
      const ms = safeRecord(wsMilestones[msIdx]);
      const msRef = ensureRef(ms, `ms-${wsIdx + 1}-${msIdx + 1}`);
      msRefs[wsIdx]![msIdx] = msRef;
      taskRefs[wsIdx]![msIdx] = [];

      const msTasksRaw = Array.isArray(ms.tasks) ? (ms.tasks as unknown[]) : [];
      const msTasks =
        msTasksRaw.length > 0
          ? msTasksRaw
          : defaultTaskList(
              typeof ms.title === 'string' ? ms.title : `Milestone ${msIdx + 1}`
            );
      const msEntityBase = withDefaultSequence(
        omitKeys(ms, new Set(['tasks'])),
        msIdx + 1
      );
      const msTaskCount = Math.max(1, msTasks.length);
      const msExpectedTokens = Math.max(8_000, msTaskCount * 4_500);
      const msExpectedHours = msExpectedTokens / TOKENS_PER_HOUR;
      const msEntity = withEstimateDefaults(msEntityBase, {
        expectedTokens: msExpectedTokens,
        expectedHours: msExpectedHours,
      });
      if (msIdx > 0 && !hasDependsOn(msEntity)) {
        msEntity.depends_on = [msRefs[wsIdx]![msIdx - 1]];
      }
      const msMetadata =
        msEntity.metadata && typeof msEntity.metadata === 'object'
          ? (msEntity.metadata as Record<string, unknown>)
          : {};
      const msAssignedAgentIds = resolveAssignedAgentIds(msEntity, msMetadata);
      const msAssignedAgentNames = resolveAssignedAgentNames(msEntity, msMetadata);
      const msDefaultAgentId = msAssignedAgentIds[0] ?? wsDefaultAgentId;
      const msDefaultAgentName =
        msAssignedAgentNames[0] ??
        wsDefaultAgentName ??
        (msDefaultAgentId ? titleCaseFromAgentId(msDefaultAgentId) : null);
      if (
        msDefaultAgentId &&
        !hasAnyKey(msEntity, ['assigned_agent_ids', 'assignedAgentIds'])
      ) {
        msEntity.assigned_agent_ids = [msDefaultAgentId];
      }
      if (
        msDefaultAgentName &&
        !hasAnyKey(msEntity, ['assigned_agent_names', 'assignedAgentNames'])
      ) {
        msEntity.assigned_agent_names = [msDefaultAgentName];
      }
      msEntity.metadata = {
        ...msMetadata,
        domain:
          normalizedDomain ??
          (typeof msMetadata.domain === 'string' ? msMetadata.domain : null),
        agent_domain:
          normalizedDomain ??
          (typeof msMetadata.agent_domain === 'string'
            ? msMetadata.agent_domain
            : null),
        ...(msDefaultAgentId ? { assigned_agent_ids: [msDefaultAgentId] } : {}),
        ...(msDefaultAgentName
          ? { assigned_agent_names: [msDefaultAgentName] }
          : {}),
      };
      batch.push({
        ...msEntity,
        type: 'milestone',
        ref: msRef,
        initiative_ref: initiativeRef,
        workstream_ref: wsRef,
      });

      const taskEntries = msTasks.map((taskInput, tIdx) => {
        const task = safeRecord(taskInput);
        const tRef = ensureRef(
          task,
          `task-${wsIdx + 1}-${msIdx + 1}-${tIdx + 1}`
        );
        return { task, tRef };
      });

      for (let tIdx = 0; tIdx < msTasks.length; tIdx++) {
        const { task, tRef } = taskEntries[tIdx]!;
        taskRefs[wsIdx]![msIdx]![tIdx] = tRef;
        const taskHours = estimateTaskHours(task);
        const taskExpectedTokens = Math.max(
          1_500,
          Math.round(taskHours * TOKENS_PER_HOUR)
        );
        const taskEntity = withEstimateDefaults(
          withDefaultSequence(task, tIdx + 1),
          {
          expectedTokens: taskExpectedTokens,
          expectedHours: taskHours,
          }
        );
        if (tIdx > 0 && !hasDependsOn(taskEntity)) {
          taskEntity.depends_on = [taskEntries[tIdx - 1]!.tRef];
        }
        const taskMetadata =
          taskEntity.metadata && typeof taskEntity.metadata === 'object'
            ? (taskEntity.metadata as Record<string, unknown>)
            : {};
        const taskAssignedAgentIds = resolveAssignedAgentIds(taskEntity, taskMetadata);
        const taskAssignedAgentNames = resolveAssignedAgentNames(
          taskEntity,
          taskMetadata
        );
        const taskDefaultAgentId = taskAssignedAgentIds[0] ?? msDefaultAgentId;
        const taskDefaultAgentName =
          taskAssignedAgentNames[0] ??
          msDefaultAgentName ??
          (taskDefaultAgentId ? titleCaseFromAgentId(taskDefaultAgentId) : null);
        if (
          taskDefaultAgentId &&
          !hasAnyKey(taskEntity, ['assigned_agent_ids', 'assignedAgentIds'])
        ) {
          taskEntity.assigned_agent_ids = [taskDefaultAgentId];
        }
        if (
          taskDefaultAgentName &&
          !hasAnyKey(taskEntity, ['assigned_agent_names', 'assignedAgentNames'])
        ) {
          taskEntity.assigned_agent_names = [taskDefaultAgentName];
        }
        taskEntity.metadata = {
          ...taskMetadata,
          domain:
            normalizedDomain ??
            (typeof taskMetadata.domain === 'string' ? taskMetadata.domain : null),
          agent_domain:
            normalizedDomain ??
            (typeof taskMetadata.agent_domain === 'string'
              ? taskMetadata.agent_domain
              : null),
          ...(taskDefaultAgentId ? { assigned_agent_ids: [taskDefaultAgentId] } : {}),
          ...(taskDefaultAgentName
            ? { assigned_agent_names: [taskDefaultAgentName] }
            : {}),
        };
        batch.push({
          ...taskEntity,
          type: 'task',
          ref: tRef,
          initiative_ref: initiativeRef,
          workstream_ref: wsRef,
          milestone_ref: msRef,
        });
      }
    }
  }

  return { batch, initiativeRef, wsRefs, msRefs, taskRefs };
}

export function buildScaffoldHierarchy(params: {
  result: BatchCreateSummary;
  initiativeRef: string;
  wsRefs: string[];
  msRefs: string[][];
  taskRefs: string[][][];
}) {
  const { result, initiativeRef, wsRefs, msRefs, taskRefs } = params;

  const byRef = new Map<
    string,
    { success: boolean; data?: Record<string, unknown> | null; error?: string }
  >();
  for (const item of result.results) {
    if (item.ref) {
      byRef.set(item.ref, {
        success: item.success,
        data: item.data ?? null,
        error: item.error,
      });
    }
  }

  const nodeForRef = (ref: string) => {
    const info = byRef.get(ref);
    return {
      ref,
      success: info?.success ?? false,
      ...(info?.data ?? {}),
      ...(info?.success === false ? { error: info?.error } : {}),
    };
  };

  return {
    initiative: nodeForRef(initiativeRef),
    workstreams: wsRefs.map((wsRef, wsIdx) => ({
      ...nodeForRef(wsRef),
      milestones: (msRefs[wsIdx] ?? []).map((msRef, msIdx) => ({
        ...nodeForRef(msRef),
        tasks: (taskRefs[wsIdx]?.[msIdx] ?? []).map((tRef) => nodeForRef(tRef)),
      })),
    })),
  };
}
