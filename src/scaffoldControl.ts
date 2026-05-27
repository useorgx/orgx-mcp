export type ScaffoldMode = 'draft' | 'scaffold' | 'launch';

export type ScaffoldContractWarning = {
  code: string;
  message: string;
};

export type MaterializedDependencyEdge = {
  type: 'workstream';
  name: string;
  from_ref: string;
  to_ref: string;
};

export type ExternalSyncTarget = 'linear' | 'jira';

export type ExternalSyncRequest = {
  targets: ExternalSyncTarget[];
  mode: 'project_and_tasks' | 'tasks_only';
  linear_project_id?: string;
};

export type ScaffoldCredentialStatus = {
  checked?: boolean;
  has_credentials?: boolean;
  has_execution_credentials?: boolean;
  has_subscription_accounts?: boolean;
  can_execute?: boolean;
};

export type FirstAgentWorkState = {
  status:
    | 'not_requested'
    | 'blocked'
    | 'launch_requested'
    | 'work_started'
    | 'fallback_dispatched'
    | 'launch_failed';
  mode: ScaffoldMode;
  initiative_id?: string;
  first_stream_id?: string;
  stream_count?: number;
  current_job_id?: string | null;
  fallback_agent?: string;
  blocker_reason?: string;
  next_steps?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function resolveScaffoldMode(args: Record<string, unknown>): {
  mode: ScaffoldMode;
  launchAfterCreate: boolean;
  warnings: ScaffoldContractWarning[];
} {
  const warnings: ScaffoldContractWarning[] = [];
  const rawMode = typeof args.mode === 'string' ? args.mode.trim() : '';
  const legacyLaunch =
    typeof args.launch_after_create === 'boolean'
      ? args.launch_after_create
      : undefined;

  if (rawMode === 'draft' || rawMode === 'scaffold' || rawMode === 'launch') {
    const launchAfterCreate = rawMode === 'launch';
    if (
      typeof legacyLaunch === 'boolean' &&
      legacyLaunch !== launchAfterCreate
    ) {
      warnings.push({
        code: 'legacy_launch_after_create_ignored',
        message:
          'mode is authoritative when both mode and launch_after_create are supplied.',
      });
    }
    return { mode: rawMode, launchAfterCreate, warnings };
  }

  if (rawMode) {
    warnings.push({
      code: 'invalid_mode_defaulted',
      message: 'Unsupported mode ignored. Valid modes: draft, scaffold, launch.',
    });
  }

  const mode = legacyLaunch === false ? 'scaffold' : 'launch';
  return { mode, launchAfterCreate: mode === 'launch', warnings };
}

function normalizeObjectiveNode(
  value: unknown,
  warnings: ScaffoldContractWarning[],
  path: string
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const node: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const objectiveIds = stringArray(node.objective_ids);
  const goalIds = stringArray(node.goal_ids);

  if (objectiveIds.length > 0) {
    if (goalIds.length === 0) {
      node.goal_ids = objectiveIds;
    } else if (!arraysEqual(objectiveIds, goalIds)) {
      warnings.push({
        code: 'objective_ids_goal_ids_conflict',
        message: `${path}.goal_ids was kept because it differs from objective_ids.`,
      });
    }
    delete node.objective_ids;
  }

  if (Array.isArray(node.workstreams)) {
    node.workstreams = node.workstreams.map((child, index) =>
      normalizeObjectiveNode(child, warnings, `${path}.workstreams[${index}]`)
    );
  }
  if (Array.isArray(node.milestones)) {
    node.milestones = node.milestones.map((child, index) =>
      normalizeObjectiveNode(child, warnings, `${path}.milestones[${index}]`)
    );
  }
  if (Array.isArray(node.tasks)) {
    node.tasks = node.tasks.map((child, index) =>
      normalizeObjectiveNode(child, warnings, `${path}.tasks[${index}]`)
    );
  }

  return node;
}

export function normalizeScaffoldObjectiveAliases(
  args: Record<string, unknown>
): { args: Record<string, unknown>; warnings: ScaffoldContractWarning[] } {
  const warnings: ScaffoldContractWarning[] = [];
  const normalized = normalizeObjectiveNode(args, warnings, 'scaffold_initiative');
  return {
    args: (asRecord(normalized) ?? { ...args }) as Record<string, unknown>,
    warnings,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function deriveScaffoldIdempotencyKey(params: {
  args: Record<string, unknown>;
  workspaceId?: string | null;
  ownerId?: string | null;
}): string {
  const explicit =
    typeof params.args.idempotency_key === 'string' &&
    params.args.idempotency_key.trim().length > 0
      ? params.args.idempotency_key.trim()
      : typeof params.args.idempotencyKey === 'string' &&
        params.args.idempotencyKey.trim().length > 0
      ? params.args.idempotencyKey.trim()
      : null;
  if (explicit) return explicit.slice(0, 120);

  const canonical = stableSerialize({
    workspace_id: params.workspaceId ?? null,
    owner_id: params.ownerId ?? null,
    title: params.args.title ?? null,
    summary: params.args.summary ?? null,
    description: params.args.description ?? null,
    goal_ids: params.args.goal_ids ?? null,
    workstreams: params.args.workstreams ?? null,
  });
  return `scaffold:${stableHash(canonical)}`;
}

export function normalizeExternalSyncRequest(
  value: unknown
): ExternalSyncRequest | null {
  const record = asRecord(value);
  if (!record) return null;
  const rawTargets = stringArray(record.targets);
  const targets = rawTargets.filter(
    (target): target is ExternalSyncTarget =>
      target === 'linear' || target === 'jira'
  );
  if (targets.length === 0) return null;

  const rawMode = typeof record.mode === 'string' ? record.mode : '';
  const mode =
    rawMode === 'tasks_only' || rawMode === 'project_and_tasks'
      ? rawMode
      : 'project_and_tasks';
  const linearProjectId =
    typeof record.linear_project_id === 'string' &&
    record.linear_project_id.trim().length > 0
      ? record.linear_project_id.trim()
      : typeof record.linearProjectId === 'string' &&
        record.linearProjectId.trim().length > 0
      ? record.linearProjectId.trim()
      : undefined;

  return {
    targets: Array.from(new Set(targets)),
    mode,
    ...(linearProjectId ? { linear_project_id: linearProjectId } : {}),
  };
}

export function canLaunchWithCredentialStatus(
  status: ScaffoldCredentialStatus | null | undefined
): boolean {
  if (!status) return false;
  if (typeof status.can_execute === 'boolean') return status.can_execute;

  return Boolean(
    status.has_execution_credentials ||
      status.has_credentials ||
      status.has_subscription_accounts
  );
}

export function buildFirstAgentWorkState(params: {
  mode: ScaffoldMode;
  initiativeId?: string | null;
  launch?: Record<string, unknown> | null;
  streams?: Record<string, unknown> | null;
  fallbackAgentDispatch?: Record<string, unknown> | null;
}): FirstAgentWorkState {
  const base: FirstAgentWorkState = {
    status: params.mode === 'launch' ? 'launch_requested' : 'not_requested',
    mode: params.mode,
    ...(params.initiativeId ? { initiative_id: params.initiativeId } : {}),
  };
  if (params.mode !== 'launch') return base;

  const launch = params.launch ?? {};
  if (launch.needs_credentials) {
    return {
      ...base,
      status: 'blocked',
      blocker_reason:
        typeof launch.error_kind === 'string'
          ? launch.error_kind
          : 'credential_missing',
      next_steps: stringArray(launch.next_steps),
    };
  }
  if (launch.ok === false && launch.attempted) {
    return {
      ...base,
      status: 'launch_failed',
      blocker_reason:
        typeof launch.error_kind === 'string' ? launch.error_kind : 'launch_failed',
      next_steps: stringArray(launch.next_steps),
    };
  }

  const streamItems = Array.isArray(params.streams?.items)
    ? (params.streams?.items as unknown[])
    : [];
  const firstStream = streamItems
    .map(asRecord)
    .find((stream) => typeof stream?.id === 'string');
  if (firstStream) {
    return {
      ...base,
      status: 'work_started',
      first_stream_id: String(firstStream.id),
      stream_count:
        typeof params.streams?.total === 'number'
          ? params.streams.total
          : streamItems.length,
      current_job_id:
        typeof firstStream.current_job_id === 'string'
          ? firstStream.current_job_id
          : null,
    };
  }

  const fallback = params.fallbackAgentDispatch ?? {};
  if (fallback.ok === true) {
    return {
      ...base,
      status: 'fallback_dispatched',
      fallback_agent:
        typeof fallback.agent === 'string' ? fallback.agent : undefined,
    };
  }

  return base;
}
