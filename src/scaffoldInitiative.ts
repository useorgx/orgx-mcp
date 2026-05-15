import type { BatchCreateSummary } from './batchCreate';
import type {
  MaterializedDependencyEdge,
  ScaffoldContractWarning,
} from './scaffoldControl';

export type ScaffoldBatchBuildResult = {
  batch: Array<Record<string, unknown>>;
  initiativeRef: string;
  wsRefs: string[];
  msRefs: string[][];
  taskRefs: string[][][];
  materializedDependencies: MaterializedDependencyEdge[];
  warnings: ScaffoldContractWarning[];
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

const DIRECT_ECONOMICS_KEYS = new Set([
  'estimated_hours',
  'estimatedHours',
  'estimated_spend_usd',
  'estimatedSpendUsd',
  'estimated_roi_usd',
  'estimatedRoiUsd',
  'actual_hours',
  'actualHours',
  'actual_spend_usd',
  'actualSpendUsd',
  'daily_limit_usd',
  'dailyLimitUsd',
  'hourly_limit_usd',
  'hourlyLimitUsd',
  'priority_rank',
  'priorityRank',
  'human_equivalent_hourly_rate_usd',
  'humanEquivalentHourlyRateUsd',
  'human_equivalent_value_usd',
  'humanEquivalentValueUsd',
  'value_basis',
  'valueBasis',
]);

function omitScaffoldInputKeys(
  obj: Record<string, unknown>,
  keys: Iterable<string>
) {
  return omitKeys(obj, new Set([...keys, ...DIRECT_ECONOMICS_KEYS]));
}

function ensureRef(input: Record<string, unknown>, fallback: string): string {
  return typeof input.ref === 'string' && input.ref.trim().length > 0
    ? input.ref.trim()
    : fallback;
}

function normalizeDependencyLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

const TOKENS_PER_HOUR = 6_500;
const USD_PER_1K_TOKENS = 0.012;
const TASK_TYPES = ['research', 'create', 'review', 'implement'] as const;
type ScaffoldTaskType = (typeof TASK_TYPES)[number];
const DEFAULT_HUMAN_EQUIVALENT_RATE_USD = 175;
const HUMAN_EQUIVALENT_RATE_BY_TASK_TYPE_USD: Record<ScaffoldTaskType, number> =
  {
    research: 140,
    create: 175,
    review: 155,
    implement: 210,
  };
const ECONOMICS_VALUE_BASIS = 'market_rate_by_task_type_less_spend';

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
  orion: 'operations',
  dana: 'design',
  xandy: 'orchestrator',
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

const DOMAIN_DEFAULT_AGENT_NAME: Record<string, string> = {
  product: 'Pace',
  engineering: 'Eli',
  marketing: 'Mark',
  sales: 'Sage',
  operations: 'Orion',
  design: 'Dana',
  orchestrator: 'Xandy',
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

function normalizeTaskType(value: unknown): ScaffoldTaskType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return TASK_TYPES.includes(normalized as ScaffoldTaskType)
    ? (normalized as ScaffoldTaskType)
    : null;
}

function taskTypeHint(
  record: Record<string, unknown>
): ScaffoldTaskType | null {
  const metadata = safeRecord(record.metadata);
  return (
    normalizeTaskType(record.task_type) ??
    normalizeTaskType(record.taskType) ??
    normalizeTaskType(record.work_type) ??
    normalizeTaskType(record.workType) ??
    normalizeTaskType(metadata.task_type) ??
    normalizeTaskType(metadata.taskType) ??
    normalizeTaskType(metadata.work_type) ??
    normalizeTaskType(metadata.workType) ??
    normalizeTaskType(record.type)
  );
}

function humanEquivalentRateUsd(value: unknown): number {
  const taskType =
    value && typeof value === 'object' && !Array.isArray(value)
      ? taskTypeHint(value as Record<string, unknown>)
      : normalizeTaskType(value);
  return taskType
    ? HUMAN_EQUIVALENT_RATE_BY_TASK_TYPE_USD[taskType]
    : DEFAULT_HUMAN_EQUIVALENT_RATE_USD;
}

function withObjectiveAlias(entity: Record<string, unknown>): Record<string, unknown> {
  const next = { ...entity };
  const objectiveIds = parseStringArray(next.objective_ids);
  const goalIds = parseStringArray(next.goal_ids);
  if (objectiveIds.length > 0 && goalIds.length === 0) {
    next.goal_ids = objectiveIds;
  }
  delete next.objective_ids;
  return next;
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

function canonicalizeAgentId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.endsWith('-agent')) return normalized;
  const domain = normalizeDomain(normalized);
  if (!domain) return normalized;
  return defaultAgentIdForDomain(domain) ?? normalized;
}

function titleCaseFromAgentId(agentId: string): string {
  const canonicalId = canonicalizeAgentId(agentId);
  const domain = normalizeDomain(canonicalId.replace(/-agent$/i, ''));
  if (domain && DOMAIN_DEFAULT_AGENT_NAME[domain]) {
    return DOMAIN_DEFAULT_AGENT_NAME[domain];
  }
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
  ].map(canonicalizeAgentId).filter(Boolean));
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

function readExplicitEstimateSignal(
  entity: Record<string, unknown>
): {
  durationHours: number | null;
  tokens: number | null;
  budgetUsd: number | null;
} {
  return {
    durationHours: toFiniteNumber(
      entity.expected_duration_hours ??
        entity.expectedDurationHours ??
        entity.duration_hours ??
        entity.durationHours ??
        entity.estimated_hours ??
        entity.estimatedHours
    ),
    tokens: toFiniteNumber(
      entity.expected_tokens ??
        entity.expectedTokens ??
        entity.token_budget ??
        entity.tokenBudget ??
        entity.tokens
    ),
    budgetUsd: toFiniteNumber(
      entity.expected_budget_usd ??
        entity.expectedBudgetUsd ??
        entity.budget_usd ??
        entity.budgetUsd
    ),
  };
}

function hasTinyExplicitEstimate(entity: Record<string, unknown>): boolean {
  const estimate = readExplicitEstimateSignal(entity);
  return (
    (estimate.durationHours !== null && estimate.durationHours <= 0.25) ||
    (estimate.tokens !== null && estimate.tokens <= 2_000) ||
    (estimate.budgetUsd !== null && estimate.budgetUsd <= 0.05)
  );
}

function shouldUseMinimalExecutionPolicy(
  args: Record<string, unknown>,
  workstreamsInput: unknown[]
): boolean {
  if (hasTinyExplicitEstimate(args)) return true;

  for (const wsInput of workstreamsInput) {
    const ws = safeRecord(wsInput);
    if (hasTinyExplicitEstimate(ws)) return true;
    const milestones = Array.isArray(ws.milestones) ? ws.milestones : [];
    for (const msInput of milestones) {
      const ms = safeRecord(msInput);
      if (hasTinyExplicitEstimate(ms)) return true;
      const tasks = Array.isArray(ms.tasks) ? ms.tasks : [];
      if (tasks.some((task) => hasTinyExplicitEstimate(safeRecord(task)))) {
        return true;
      }
    }
  }

  return false;
}

function withMinimalExecutionPolicy(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (
    metadata.execution_policy &&
    typeof metadata.execution_policy === 'object' &&
    !Array.isArray(metadata.execution_policy)
  ) {
    return metadata;
  }

  return {
    ...metadata,
    execution_policy: {
      profile: 'custom',
      slice_scope_preference: 'task',
      max_slice_tasks: 1,
      target_slice_minutes: 5,
      max_slice_minutes: 10,
      max_parallel_agents: 1,
      dependency_mode: 'strict',
      include_in_progress: false,
    },
    cost_control: {
      ...(safeRecord(metadata.cost_control)),
      source: 'mcp_scaffold_tiny_budget',
      demo_safe: true,
    },
  };
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
    },
    {
      title: `${title}: implementation`,
      description: `Execute core work for ${title}.`,
      type: 'implement',
    },
    {
      title: `${title}: validation`,
      description: `Validate outputs and handoff for ${title}.`,
      type: 'review',
    },
  ];
}

function defaultMilestoneList(
  workstream: Record<string, unknown>,
  index: number
): Record<string, unknown>[] {
  const title =
    typeof workstream.title === 'string' && workstream.title.trim().length > 0
      ? workstream.title.trim()
      : typeof workstream.name === 'string' && workstream.name.trim().length > 0
      ? workstream.name.trim()
      : `Workstream ${index + 1}`;

  return [
    {
      title: `${title}: plan, execute, and validate`,
      description: `Create the first executable checkpoint for ${title}.`,
      tasks: defaultTaskList(title),
    },
  ];
}

function estimateTaskHours(task: Record<string, unknown>): number {
  const explicitHours = toFiniteNumber(
    task.expected_duration_hours ??
      task.expectedDurationHours ??
      task.duration_hours ??
      task.durationHours
  );
  if (explicitHours && explicitHours > 0) return explicitHours;

  const type = taskTypeHint(task);
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
  const warnings: ScaffoldContractWarning[] = [];
  const materializedDependencies: MaterializedDependencyEdge[] = [];
  const workstreamRefByLabel = new Map<string, string>();
  for (let wsIdx = 0; wsIdx < workstreamsInput.length; wsIdx++) {
    const ws = safeRecord(workstreamsInput[wsIdx]);
    const wsRef = ensureRef(ws, `ws-${wsIdx + 1}`);
    for (const label of [ws.title, ws.name, wsRef]) {
      const normalized = normalizeDependencyLabel(label);
      if (normalized && !workstreamRefByLabel.has(normalized)) {
        workstreamRefByLabel.set(normalized, wsRef);
      }
    }
  }

  const initiativeEntity = withDefaultSequence(
    omitScaffoldInputKeys(
      withObjectiveAlias(safeRecord(args)),
      [
        'workstreams',
        'mode',
        'objective_ids',
        'launch_after_create',
        'continue_on_error',
        'concurrency',
        'external_sync',
        'externalSync',
        '_context',
        // owner_id intentionally NOT omitted — it must propagate into the
        // batch so the POST handler can set it on the initiative row.
        'user_id',
        'idempotencyKey',
        // command_center_id was renamed to workspace_id in the DB.
        // Strip it here so it never reaches the API entity payload.
        'command_center_id',
        // coordination_dependency is a planning hint (the single most
        // important cross-workstream dependency the agent identified).
        // The initiative validator rejects top-level unknown columns —
        // it arrived there before via args spread and failed every
        // scaffold. We preserve the field below under
        // metadata.coordination_dependency so downstream consumers can
        // read it and the validator accepts the payload.
        'coordination_dependency',
      ]
    ),
    1
  );
  const hasExplicitWorkstreams = workstreamsInput.length > 0;
  const minimalExecutionPolicy = shouldUseMinimalExecutionPolicy(
    args,
    workstreamsInput
  );
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
  const rawExistingMetadata = safeRecord(initiativeEntity.metadata);
  const hasExplicitModelTier =
    typeof rawExistingMetadata.model_tier === 'string' &&
    rawExistingMetadata.model_tier.trim().length > 0;
  const existingMetadata: Record<string, unknown> = {
    ...rawExistingMetadata,
    model_tier: hasExplicitModelTier
      ? rawExistingMetadata.model_tier
      : 'standard',
  };
  const existingLive = safeRecord(existingMetadata.live);
  let nextMetadata: Record<string, unknown> | null = hasExplicitModelTier
    ? null
    : existingMetadata;
  const scaffoldIdempotencyKey =
    typeof initiativeEntity.idempotency_key === 'string' &&
    initiativeEntity.idempotency_key.trim().length > 0
      ? initiativeEntity.idempotency_key.trim()
      : null;
  if (!existingLive.visibility) {
    nextMetadata = {
      ...existingMetadata,
      live: { ...existingLive, visibility: 'public' },
    };
  }
  if (scaffoldIdempotencyKey) {
    const base = nextMetadata ?? existingMetadata;
    const existingScaffold = safeRecord(base.scaffold);
    nextMetadata = {
      ...base,
      scaffold: {
        ...existingScaffold,
        idempotency_key: scaffoldIdempotencyKey,
      },
    };
  }
  if (minimalExecutionPolicy) {
    nextMetadata = withMinimalExecutionPolicy(nextMetadata ?? existingMetadata);
  }

  // coordination_dependency is a planning hint that arrives at the top
  // level of the scaffold args. Fold it into metadata so the initiative
  // validator (which rejects unknown top-level columns) accepts the
  // payload, and downstream consumers can still read the planning intent.
  const rawCoordination = safeRecord(args.coordination_dependency);
  const coordinationName =
    typeof rawCoordination.name === 'string'
      ? String(rawCoordination.name)
      : null;
  const fromWorkstreamName =
    typeof rawCoordination.fromWorkstreamName === 'string'
      ? rawCoordination.fromWorkstreamName
      : undefined;
  const toWorkstreamName =
    typeof rawCoordination.toWorkstreamName === 'string'
      ? rawCoordination.toWorkstreamName
      : undefined;
  const coordinationFromRef = fromWorkstreamName
    ? workstreamRefByLabel.get(normalizeDependencyLabel(fromWorkstreamName) ?? '')
    : undefined;
  const coordinationToRef = toWorkstreamName
    ? workstreamRefByLabel.get(normalizeDependencyLabel(toWorkstreamName) ?? '')
    : undefined;
  if (
    rawCoordination &&
    Object.keys(rawCoordination).length > 0 &&
    coordinationName
  ) {
    const base = nextMetadata ?? existingMetadata;
    nextMetadata = {
      ...base,
      coordination_dependency: {
        name: coordinationName,
        from_workstream_name: fromWorkstreamName,
        to_workstream_name: toWorkstreamName,
        from_workstream_ref: coordinationFromRef,
        to_workstream_ref: coordinationToRef,
        materialized: Boolean(coordinationFromRef && coordinationToRef),
      },
    };

    if ((fromWorkstreamName || toWorkstreamName) && !(coordinationFromRef && coordinationToRef)) {
      warnings.push({
        code: 'coordination_dependency_unresolved',
        message:
          'coordination_dependency could not be matched to both workstream refs, so no dependency edge was materialized.',
      });
    }
  }

  if (nextMetadata) {
    initiativeEntity.metadata = nextMetadata;
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
    const ws = withObjectiveAlias(safeRecord(workstreamsInput[wsIdx]));
    const wsRef = ensureRef(ws, `ws-${wsIdx + 1}`);
    wsRefs[wsIdx] = wsRef;

    const wsMilestonesRaw = Array.isArray(ws.milestones)
      ? (ws.milestones as unknown[])
      : null;
    const wsMilestones = wsMilestonesRaw ?? defaultMilestoneList(ws, wsIdx);
    msRefs[wsIdx] = [];
    taskRefs[wsIdx] = [];

    const wsEntity = withDefaultSequence(
      omitScaffoldInputKeys(
        ws,
        ['milestones', 'ownerAgent', 'primaryAgent', 'objective_ids']
      ),
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
    if (
      coordinationName &&
      coordinationFromRef &&
      coordinationToRef &&
      wsRef === coordinationToRef &&
      !hasDependsOn(wsWithEstimates)
    ) {
      wsWithEstimates.depends_on = [coordinationFromRef];
      materializedDependencies.push({
        type: 'workstream',
        name: coordinationName,
        from_ref: coordinationFromRef,
        to_ref: coordinationToRef,
      });
    }
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
      const ms = withObjectiveAlias(safeRecord(wsMilestones[msIdx]));
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
        omitScaffoldInputKeys(
          ms,
          ['tasks', 'ownerAgent', 'primaryAgent', 'objective_ids']
        ),
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
        const task = withObjectiveAlias(safeRecord(taskInput));
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
          withDefaultSequence(
            omitScaffoldInputKeys(
              task,
              [
                'ownerAgent',
                'primaryAgent',
                'objective_ids',
                'task_type',
                'taskType',
                'work_type',
                'workType',
              ]
            ),
            tIdx + 1
          ),
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
        const taskExecutionType = taskTypeHint(task);
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
          ...(taskExecutionType ? { task_type: taskExecutionType } : {}),
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

  return {
    batch,
    initiativeRef,
    wsRefs,
    msRefs,
    taskRefs,
    materializedDependencies,
    warnings,
  };
}

export function buildScaffoldHierarchy(params: {
  result: BatchCreateSummary;
  batch?: Array<Record<string, unknown>>;
  initiativeRef: string;
  wsRefs: string[];
  msRefs: string[][];
  taskRefs: string[][][];
}) {
  const { result, batch, initiativeRef, wsRefs, msRefs, taskRefs } = params;

  const byRef = new Map<
    string,
    { success: boolean; data?: Record<string, unknown> | null; error?: string }
  >();
  for (const item of result.results) {
    if (item.ref) {
      byRef.set(item.ref, {
        success: item.success,
        data: { ...(item.data ?? {}), ...(item.id ? { id: item.id } : {}) },
        error: item.error,
      });
    }
  }
  const inputByRef = new Map<string, Record<string, unknown>>();
  for (const item of batch ?? []) {
    const ref = typeof item.ref === 'string' ? item.ref : null;
    if (ref) {
      inputByRef.set(ref, item);
    }
  }

  const normalizeHierarchyNode = (node: Record<string, unknown>) => {
    const next = { ...node };
    const title =
      typeof next.title === 'string' && next.title.trim().length > 0
        ? next.title.trim()
        : null;
    const name =
      typeof next.name === 'string' && next.name.trim().length > 0
        ? next.name.trim()
        : null;

    if (!title && name) {
      next.title = name;
    }
    if (!name && title) {
      next.name = title;
    }

    return next;
  };

  const nodeForRef = (ref: string) => {
    const info = byRef.get(ref);
    return normalizeHierarchyNode({
      ...(inputByRef.get(ref) ?? {}),
      ref,
      success: info?.success ?? false,
      ...(info?.data ?? {}),
      ...(info?.success === false ? { error: info?.error } : {}),
    });
  };

  const firstNumber = (
    node: Record<string, unknown>,
    keys: string[]
  ): number | null => {
    for (const key of keys) {
      const value = toFiniteNumber(node[key]);
      if (value !== null && value >= 0) return value;
    }
    return null;
  };

  const sumNumbers = (values: Array<number | null | undefined>) => {
    let total = 0;
    let found = false;
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
    return found ? total : null;
  };

  const round = (value: number, precision = 2) =>
    Number(value.toFixed(precision));

  const estimateEconomics = (
    node: Record<string, unknown>,
    children: Array<Record<string, unknown>>
  ) => {
    const childHours = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_hours))
    );
    const childSpend = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_spend_usd))
    );
    const childRoi = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_roi_usd))
    );
    const childHumanEquivalentValue = sumNumbers(
      children.map((child) => toFiniteNumber(child.human_equivalent_value_usd))
    );

    const hours =
      firstNumber(node, [
        'estimated_hours',
        'estimatedHours',
        'expected_duration_hours',
        'expectedDurationHours',
        'duration_hours',
        'durationHours',
      ]) ??
      childHours ??
      0;
    const spend =
      firstNumber(node, [
        'estimated_spend_usd',
        'estimatedSpendUsd',
        'expected_budget_usd',
        'expectedBudgetUsd',
        'budget_usd',
        'budgetUsd',
      ]) ??
      childSpend ??
      0;
    const explicitRoi = firstNumber(node, [
      'estimated_roi_usd',
      'estimatedRoiUsd',
      'expected_roi_usd',
      'expectedRoiUsd',
      'projected_value_usd',
      'projectedValueUsd',
      'expected_value_usd',
      'expectedValueUsd',
      'value_usd',
      'valueUsd',
    ]);
    const fallbackHumanEquivalentValue =
      childHumanEquivalentValue ?? hours * humanEquivalentRateUsd(node);
    const humanEquivalentHourlyRate =
      hours > 0
        ? fallbackHumanEquivalentValue / hours
        : humanEquivalentRateUsd(node);
    const roi =
      explicitRoi ??
      childRoi ??
      Math.max(0, fallbackHumanEquivalentValue - spend);

    return {
      estimated_hours: round(hours, 1),
      estimated_spend_usd: round(spend, 2),
      estimated_roi_usd: round(roi, 0),
      human_equivalent_hourly_rate_usd: round(humanEquivalentHourlyRate, 0),
      human_equivalent_value_usd: round(fallbackHumanEquivalentValue, 0),
      value_basis: ECONOMICS_VALUE_BASIS,
    };
  };

  const workstreams = wsRefs.map((wsRef, wsIdx) => {
    const milestones = (msRefs[wsIdx] ?? []).map((msRef, msIdx) => {
      const tasks = (taskRefs[wsIdx]?.[msIdx] ?? []).map((tRef) => {
        const task = nodeForRef(tRef);
        return { ...task, ...estimateEconomics(task, []) };
      });
      const milestone = nodeForRef(msRef);
      return { ...milestone, tasks, ...estimateEconomics(milestone, tasks) };
    });
    const workstream = nodeForRef(wsRef);
    return {
      ...workstream,
      milestones,
      ...estimateEconomics(workstream, milestones),
    };
  });

  const initiativeBase = nodeForRef(initiativeRef);
  const initiativeEconomics = estimateEconomics(initiativeBase, workstreams);

  return {
    initiative: { ...initiativeBase, ...initiativeEconomics },
    workstreams,
    economics: {
      ...initiativeEconomics,
      currency: 'USD',
      source: 'derived',
      editable: true,
      value_basis: ECONOMICS_VALUE_BASIS,
      rate_card_usd: HUMAN_EQUIVALENT_RATE_BY_TASK_TYPE_USD,
    },
  };
}
