import type { OrgxApiEnv } from './orgxApi';
import {
  normalizeEntityCreatePayloadForAgents,
  type PayloadNormalizationWarning,
} from './agentErgonomics';

export type BatchCreateEntityInput = Record<string, unknown>;

export type BatchCreateEntityResult = {
  index: number;
  success: boolean;
  type: string | null;
  ref?: string;
  id?: string;
  title?: string | null;
  data?: Record<string, unknown> | null;
  error?: string;
  skipped?: boolean;
  warnings?: PayloadNormalizationWarning[];
};

export type BatchCreateSummary = {
  summary: string;
  total: number;
  created_count: number;
  failed_count: number;
  results: BatchCreateEntityResult[];
  created: Array<{
    index: number;
    type: string;
    id: string;
    title?: string | null;
    ref?: string;
  }>;
  failed: Array<{
    index: number;
    type: string | null;
    ref?: string;
    error: string;
  }>;
  warnings: PayloadNormalizationWarning[];
  ref_map: Record<string, string>;
};

export type BatchCreateApiCaller = (params: {
  env: OrgxApiEnv;
  path: string;
  init: RequestInit;
  userId?: string | null;
}) => Promise<Response>;

const REF_FIELD_MAPPINGS: Array<{ refKey: string; idKey: string }> = [
  { refKey: 'initiative_ref', idKey: 'initiative_id' },
  { refKey: 'workstream_ref', idKey: 'workstream_id' },
  { refKey: 'milestone_ref', idKey: 'milestone_id' },
  // workspace_ref / command_center_ref both resolve to workspace_id (renamed column)
  { refKey: 'workspace_ref', idKey: 'workspace_id' },
  { refKey: 'command_center_ref', idKey: 'workspace_id' },
  { refKey: 'project_ref', idKey: 'project_id' },
  { refKey: 'objective_ref', idKey: 'objective_id' },
  { refKey: 'run_ref', idKey: 'run_id' },
];

const DEPENDENCY_ARRAY_FIELDS = [
  'depends_on',
  'dependsOn',
  'dependencies',
  'dependency_ids',
  'dependencyIds',
] as const;

const TASK_PRIORITY_VALUES = ['low', 'medium', 'high'] as const;
const TASK_STATUS_VALUES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const MILESTONE_STATUS_VALUES = [
  'planned',
  'in_progress',
  'completed',
  'at_risk',
  'cancelled',
] as const;
const DECISION_STATUS_VALUES = ['pending', 'approved', 'rejected', 'superseded'] as const;
const BLOCKER_STATUS_VALUES = ['open', 'resolved', 'dismissed'] as const;
const ARTIFACT_STATUS_VALUES = [
  'draft',
  'in_review',
  'approved',
  'changes_requested',
  'superseded',
  'archived',
] as const;

function extractEntityLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const label = record.title ?? record.name;
  return typeof label === 'string' && label.trim().length > 0
    ? label.trim()
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getRefToken(value: unknown): string | null {
  const direct = getString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const token = (value as Record<string, unknown>).$ref;
  return getString(token);
}

function extractRef(entity: Record<string, unknown>): string | null {
  const raw = entity.ref;
  return getString(raw);
}

function formatValues(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function invalidEnumError(params: {
  type: string;
  path: string;
  value: unknown;
  label: string;
  validValues: readonly string[];
  hint?: string;
}): string {
  const hint = params.hint ? ` ${params.hint}` : '';
  return `${params.path}=${JSON.stringify(params.value)} is invalid for ${
    params.type
  }. Valid ${params.label}: ${formatValues(params.validValues)}.${hint}`;
}

export function validateEntityCreatePayloadContract(
  entity: Record<string, unknown>,
  pathPrefix: string
): string | null {
  const type = getString(entity.type);
  if (!type) return null;

  if (type === 'task') {
    if (
      typeof entity.priority === 'string' &&
      !includesString(TASK_PRIORITY_VALUES, entity.priority)
    ) {
      return invalidEnumError({
        type,
        path: `${pathPrefix}.priority`,
        value: entity.priority,
        label: 'task priorities',
        validValues: TASK_PRIORITY_VALUES,
        hint: 'Use "high" for urgent task work.',
      });
    }

    if (
      typeof entity.status === 'string' &&
      !includesString(TASK_STATUS_VALUES, entity.status)
    ) {
      return invalidEnumError({
        type,
        path: `${pathPrefix}.status`,
        value: entity.status,
        label: 'task statuses',
        validValues: TASK_STATUS_VALUES,
        hint: 'Use "in_progress" for active task execution.',
      });
    }
  }

  if (
    type === 'milestone' &&
    typeof entity.status === 'string' &&
    !includesString(MILESTONE_STATUS_VALUES, entity.status)
  ) {
    return invalidEnumError({
      type,
      path: `${pathPrefix}.status`,
      value: entity.status,
      label: 'milestone statuses',
      validValues: MILESTONE_STATUS_VALUES,
      hint: 'Use "in_progress" instead of "active" for milestones.',
    });
  }

  if (
    type === 'decision' &&
    typeof entity.status === 'string' &&
    !includesString(DECISION_STATUS_VALUES, entity.status)
  ) {
    return invalidEnumError({
      type,
      path: `${pathPrefix}.status`,
      value: entity.status,
      label: 'decision statuses',
      validValues: DECISION_STATUS_VALUES,
      hint: 'Use "pending" for unresolved decisions.',
    });
  }

  if (
    type === 'blocker' &&
    typeof entity.status === 'string' &&
    !includesString(BLOCKER_STATUS_VALUES, entity.status)
  ) {
    return invalidEnumError({
      type,
      path: `${pathPrefix}.status`,
      value: entity.status,
      label: 'blocker statuses',
      validValues: BLOCKER_STATUS_VALUES,
      hint: 'Use "open" for active blockers.',
    });
  }

  if (
    type === 'artifact' &&
    typeof entity.status === 'string' &&
    !includesString(ARTIFACT_STATUS_VALUES, entity.status)
  ) {
    return invalidEnumError({
      type,
      path: `${pathPrefix}.status`,
      value: entity.status,
      label: 'artifact statuses',
      validValues: ARTIFACT_STATUS_VALUES,
      hint: 'Use "draft" for newly attached artifacts.',
    });
  }

  return null;
}

function extractDependencies(
  entity: Record<string, unknown>,
  knownRefs?: ReadonlySet<string>
): string[] {
  const deps: string[] = [];

  for (const { refKey, idKey } of REF_FIELD_MAPPINGS) {
    const hasId = typeof entity[idKey] === 'string' && String(entity[idKey]);
    if (hasId) continue;
    const ref = getRefToken(entity[idKey]) ?? getRefToken(entity[refKey]);
    if (ref) deps.push(ref);
  }

  const context = entity.context;
  if (Array.isArray(context)) {
    for (const entry of context) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const hasEntityId =
        typeof record.entity_id === 'string' && String(record.entity_id);
      if (hasEntityId) continue;
      const ref = getRefToken(record.entity_id) ?? getRefToken(record.entity_ref);
      if (ref) deps.push(ref);
    }
  }

  for (const key of DEPENDENCY_ARRAY_FIELDS) {
    const value = entity[key];
    const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    for (const entry of entries) {
      const ref = getRefToken(entry);
      if (ref && (!knownRefs || knownRefs.has(ref))) deps.push(ref);
    }
  }

  // De-dupe while preserving order.
  return deps.filter((ref, idx) => deps.indexOf(ref) === idx);
}

function resolveRefs(params: {
  entity: Record<string, unknown>;
  resolvedRefMap: Record<string, string>;
  refAliases?: Map<string, string>;
}): { body: Record<string, unknown>; unresolved: string[] } {
  const { entity, resolvedRefMap, refAliases } = params;

  const lookupResolvedRef = (ref: string) => {
    const seen = new Set<string>();
    let current = ref;
    while (refAliases?.has(current) && !seen.has(current)) {
      seen.add(current);
      current = refAliases.get(current)!;
    }
    return resolvedRefMap[current] ?? resolvedRefMap[ref];
  };

  const body: Record<string, unknown> = { ...entity };
  const unresolved: string[] = [];

  delete body.ref;
  // command_center_id was renamed to workspace_id in the Apr-2026 DB migration.
  // Strip it so it never reaches the API payload (the column no longer exists).
  // workspace_id already carries the correct value from applySessionDefaults.
  if ('command_center_id' in body) {
    if (!body.workspace_id && body.command_center_id) {
      body.workspace_id = body.command_center_id;
    }
    delete body.command_center_id;
  }

  for (const { refKey, idKey } of REF_FIELD_MAPPINGS) {
    const hasId = typeof body[idKey] === 'string' && String(body[idKey]);
    if (hasId) {
      delete body[refKey];
      continue;
    }
    const idRef = getRefToken(body[idKey]);
    const ref = idRef ?? getRefToken(body[refKey]);
    if (!ref) continue;
    const resolved = lookupResolvedRef(ref);
    if (resolved) {
      body[idKey] = resolved;
      delete body[refKey];
    } else {
      unresolved.push(ref);
    }
  }

  if (Array.isArray(body.context)) {
    body.context = body.context.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return entry;
      }
      const record: Record<string, unknown> = { ...(entry as any) };
      const hasEntityId =
        typeof record.entity_id === 'string' && String(record.entity_id);
      if (hasEntityId) {
        delete record.entity_ref;
        return record;
      }
      const idRef = getRefToken(record.entity_id);
      const ref = idRef ?? getRefToken(record.entity_ref);
      if (!ref) return record;
      const resolved = lookupResolvedRef(ref);
      if (resolved) {
        record.entity_id = resolved;
        delete record.entity_ref;
      } else {
        unresolved.push(ref);
      }
      return record;
    });
  }

  for (const key of DEPENDENCY_ARRAY_FIELDS) {
    const value = body[key];
    if (!Array.isArray(value)) continue;
    body[key] = value.map((entry) => {
      const ref = getRefToken(entry);
      if (!ref) return entry;
      const resolved = lookupResolvedRef(ref);
      if (resolved) return resolved;
      return entry;
    });
  }

  return { body, unresolved };
}

function normalizeHierarchyLabel(value: unknown): string | null {
  const label = getString(value);
  if (!label) return null;
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

function refOrIdToken(
  entity: Record<string, unknown>,
  idKey: string,
  refKey: string
): string {
  const id = getString(entity[idKey]);
  if (id) return `id:${id}`;
  const ref = getRefToken(entity[idKey]) ?? getRefToken(entity[refKey]);
  if (ref) return `ref:${ref}`;
  return 'none';
}

function hierarchyDedupeKey(entity: Record<string, unknown>): string | null {
  const type = getString(entity.type);
  if (!type || !['workstream', 'milestone', 'task'].includes(type)) return null;
  const label = normalizeHierarchyLabel(entity.title ?? entity.name);
  if (!label) return null;
  const initiative = refOrIdToken(entity, 'initiative_id', 'initiative_ref');
  if (type === 'workstream') {
    return `${type}|${initiative}|${label}`;
  }
  const workstream = refOrIdToken(entity, 'workstream_id', 'workstream_ref');
  if (type === 'milestone') {
    return `${type}|${initiative}|${workstream}|${label}`;
  }
  const milestone = refOrIdToken(entity, 'milestone_id', 'milestone_ref');
  return `${type}|${initiative}|${workstream}|${milestone}|${label}`;
}

const METADATA_REF_SUPPORTED_TYPES = new Set([
  'initiative',
  'workstream',
  'milestone',
  'task',
  'decision',
  'objective',
  'playbook',
  'stream',
]);

function attachReferenceMetadata(body: Record<string, unknown>, ref: string | null) {
  if (!ref) return;
  const type = getString(body.type);
  if (!type || !METADATA_REF_SUPPORTED_TYPES.has(type)) return;

  const existingMetadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? ({ ...(body.metadata as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  if (typeof existingMetadata.ref !== 'string' || existingMetadata.ref.trim().length === 0) {
    existingMetadata.ref = ref;
  }
  body.metadata = existingMetadata;
}

export async function batchCreateEntities(params: {
  env: OrgxApiEnv;
  callApi: BatchCreateApiCaller;
  entities: Array<BatchCreateEntityInput>;
  ownerId?: string | null;
  continueOnError: boolean;
  concurrency: number;
}): Promise<BatchCreateSummary> {
  const {
    env,
    callApi,
    entities,
    ownerId = null,
    continueOnError,
    concurrency,
  } = params;

  const results: Array<BatchCreateEntityResult | null> = new Array(
    entities.length
  ).fill(null);
  const warnings: PayloadNormalizationWarning[] = [];

  // Validate payloads early and gather refs.
  const refOccurrences = new Map<string, number[]>();
  const hierarchyKeyToIndex = new Map<string, number>();
  const refAliases = new Map<string, string>();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
      results[i] = {
        index: i,
        success: false,
        type: null,
        error: 'Entity payload must be an object',
      };
      continue;
    }

    const normalized = normalizeEntityCreatePayloadForAgents(
      entity as Record<string, unknown>,
      `entities[${i}]`
    );
    if (normalized.warnings.length > 0) {
      warnings.push(...normalized.warnings);
      entities[i] = normalized.entity;
    }

    const normalizedEntity = entities[i] as Record<string, unknown>;
    const type = getString(normalizedEntity.type);
    if (!type) {
      results[i] = {
        index: i,
        success: false,
        type: null,
        error: "Entity payload must include a non-empty 'type' field",
      };
      continue;
    }

    const contractError = validateEntityCreatePayloadContract(
      normalizedEntity,
      `entities[${i}]`
    );
    if (contractError) {
      results[i] = {
        index: i,
        success: false,
        type,
        ref: extractRef(normalizedEntity) ?? undefined,
        error: contractError,
      };
      continue;
    }

    const ref = extractRef(normalizedEntity);
    if (ref) {
      const existing = refOccurrences.get(ref) ?? [];
      existing.push(i);
      refOccurrences.set(ref, existing);
    }

    const hierarchyKey = hierarchyDedupeKey(normalizedEntity);
    if (hierarchyKey) {
      const canonicalIndex = hierarchyKeyToIndex.get(hierarchyKey);
      if (typeof canonicalIndex === 'number') {
        const canonicalRef = extractRef(
          entities[canonicalIndex] as Record<string, unknown>
        );
        results[i] = {
          index: i,
          success: true,
          type,
          ref: ref ?? undefined,
          title: extractEntityLabel(normalizedEntity),
          skipped: true,
        };
        if (ref && canonicalRef) {
          refAliases.set(ref, canonicalRef);
        }
      } else {
        hierarchyKeyToIndex.set(hierarchyKey, i);
      }
    }
  }

  const refToIndex = new Map<string, number>();
  for (const [ref, indices] of refOccurrences.entries()) {
    if (indices.length === 1) {
      refToIndex.set(ref, indices[0]!);
      continue;
    }
    for (const index of indices) {
      results[index] = {
        index,
        success: false,
        type: getString((entities[index] as any)?.type),
        ref,
        error: `Duplicate ref '${ref}' used by multiple entities`,
      };
    }
  }

  const depsByIndex: Array<string[] | null> = new Array(entities.length).fill(
    null
  );

  for (let i = 0; i < entities.length; i++) {
    if (results[i]) continue; // already failed validation
    const entity = entities[i] as Record<string, unknown>;
    const deps = extractDependencies(entity, new Set(refToIndex.keys())).map((dep) => {
      const seen = new Set<string>();
      let current = dep;
      while (refAliases.has(current) && !seen.has(current)) {
        seen.add(current);
        current = refAliases.get(current)!;
      }
      return current;
    });
    const unknown = deps.filter((dep) => !refToIndex.has(dep));
    if (unknown.length > 0) {
      results[i] = {
        index: i,
        success: false,
        type: getString(entity.type),
        ref: extractRef(entity) ?? undefined,
        error: `Unknown ref(s): ${unknown.join(', ')}`,
      };
      continue;
    }
    depsByIndex[i] = deps;
  }

  const pending = new Set<number>();
  for (let i = 0; i < entities.length; i++) {
    if (!results[i]) pending.add(i);
  }

  const resolvedRefMap: Record<string, string> = {};
  const failedRefs = new Set<string>();

  const createOne = async (index: number): Promise<void> => {
    const entity = entities[index] as Record<string, unknown>;
    const type = getString(entity.type);
    const ref = extractRef(entity);

    const { body, unresolved } = resolveRefs({
      entity,
      resolvedRefMap,
      refAliases,
    });
    if (unresolved.length > 0) {
      results[index] = {
        index,
        success: false,
        type,
        ref: ref ?? undefined,
        error: `Unresolved ref(s): ${unresolved.join(', ')}`,
      };
      if (ref) failedRefs.add(ref);
      return;
    }

    attachReferenceMetadata(body, ref);

    if (!body.owner_id && ownerId) body.owner_id = ownerId;
    if (!body.user_id && ownerId) body.user_id = ownerId;

    // Create-only safety: don't let callers accidentally overwrite or forge
    // entity identity/timestamps when using batch_create_entities.
    delete (body as any).id;
    delete (body as any).created_at;
    delete (body as any).updated_at;

    try {
      const response = await callApi({
        env,
        path: '/api/entities',
        init: {
          method: 'POST',
          body: JSON.stringify(body),
        },
        userId: ownerId,
      });

      // Support both real fetch Responses and lightweight test/mocked responses.
      // In production we prefer `text()` so we can surface raw error bodies.
      const ok =
        typeof (response as any).ok === 'boolean' ? (response as any).ok : true;
      const status =
        typeof (response as any).status === 'number'
          ? (response as any).status
          : ok
          ? 200
          : 500;

      let rawText = '';
      let parsed: any = null;

      if (typeof (response as any).text === 'function') {
        rawText = await (response as any).text();
        parsed = (() => {
          try {
            return rawText ? (JSON.parse(rawText) as any) : null;
          } catch {
            return null;
          }
        })();
      } else if (typeof (response as any).json === 'function') {
        try {
          parsed = await (response as any).json();
          rawText = JSON.stringify(parsed);
        } catch {
          parsed = null;
        }
      }

      if (!ok) {
        const conflictData =
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          (parsed.data || parsed.existing || parsed.entity);
        const conflictRecord =
          conflictData &&
          typeof conflictData === 'object' &&
          !Array.isArray(conflictData)
            ? (conflictData as Record<string, unknown>)
            : null;
        const conflictId =
          typeof conflictRecord?.id === 'string' ? conflictRecord.id : null;
        if (status === 409 && conflictId) {
          const title = extractEntityLabel(conflictRecord) ?? extractEntityLabel(body);
          results[index] = {
            index,
            success: true,
            type,
            ref: ref ?? undefined,
            id: conflictId,
            title,
            data: conflictRecord,
            skipped: true,
          };
          if (ref) {
            resolvedRefMap[ref] = conflictId;
            for (const [alias, canonicalRef] of refAliases.entries()) {
              if (canonicalRef === ref) {
                resolvedRefMap[alias] = conflictId;
              }
            }
          }
          return;
        }

        const apiMessage =
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          (typeof parsed.error === 'string' ||
            typeof parsed.message === 'string')
            ? String(parsed.error ?? parsed.message)
            : rawText;

        results[index] = {
          index,
          success: false,
          type,
          ref: ref ?? undefined,
          error: `HTTP ${status}: ${String(apiMessage).slice(0, 400)}`,
        };
        if (ref) failedRefs.add(ref);
        return;
      }

      const payload = (parsed ?? {}) as {
        type?: string;
        data?: Record<string, unknown>;
      };

      const data = payload.data ?? null;
      const id = typeof data?.id === 'string' ? data.id : undefined;
      const title = extractEntityLabel(data) ?? extractEntityLabel(body);

      if (!id) {
        results[index] = {
          index,
          success: false,
          type: payload.type ?? type,
          ref: ref ?? undefined,
          error: `Create response missing id`,
          data,
        };
        if (ref) failedRefs.add(ref);
        return;
      }

      results[index] = {
        index,
        success: true,
        type: payload.type ?? type,
        ref: ref ?? undefined,
        id,
        title,
        data,
      };

      if (ref && id) {
        resolvedRefMap[ref] = id;
        for (const [alias, canonicalRef] of refAliases.entries()) {
          if (canonicalRef === ref) {
            resolvedRefMap[alias] = id;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[index] = {
        index,
        success: false,
        type: type ?? null,
        ref: ref ?? undefined,
        error: message,
      };
      if (ref) failedRefs.add(ref);
    }
  };

  // Iterate until all resolvable entities are processed.
  while (pending.size > 0) {
    const ready: number[] = [];

    for (const index of pending) {
      const entity = entities[index] as Record<string, unknown>;
      const ref = extractRef(entity);
      const deps = depsByIndex[index] ?? [];

      const failedDep = deps.find((dep) => failedRefs.has(dep));
      if (failedDep) {
        results[index] = {
          index,
          success: false,
          type: getString(entity.type),
          ref: ref ?? undefined,
          error: `Dependency failed: ${failedDep}`,
        };
        if (ref) failedRefs.add(ref);
        continue;
      }

      const allResolved = deps.every((dep) => Boolean(resolvedRefMap[dep]));
      if (allResolved) {
        ready.push(index);
      }
    }

    // Remove dependency-failed items from pending.
    for (const index of Array.from(pending)) {
      if (results[index] && results[index]!.success === false) {
        pending.delete(index);
      }
    }

    if (pending.size === 0) break;

    if (ready.length === 0) {
      // Cycle or logical deadlock (deps that will never resolve).
      for (const index of pending) {
        const entity = entities[index] as Record<string, unknown>;
        const deps = depsByIndex[index] ?? [];
        const missing = deps.filter((dep) => !resolvedRefMap[dep]);
        results[index] = {
          index,
          success: false,
          type: getString(entity.type),
          ref: extractRef(entity) ?? undefined,
          error:
            missing.length > 0
              ? `Unresolved ref dependency chain: ${missing.join(', ')}`
              : 'Unable to resolve entity dependencies (cycle?)',
        };
        const ref = extractRef(entity);
        if (ref) failedRefs.add(ref);
      }
      pending.clear();
      break;
    }

    let nextReady = 0;
    let shouldStop = false;

    const worker = async () => {
      while (true) {
        if (shouldStop && !continueOnError) return;
        const local = nextReady++;
        if (local >= ready.length) return;
        const index = ready[local]!;
        await createOne(index);
        if (results[index]?.success === false && !continueOnError) {
          shouldStop = true;
        }
      }
    };

    const workerCount = Math.min(Math.max(concurrency, 1), ready.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // If we stopped early, mark the rest as skipped.
    if (shouldStop && !continueOnError) {
      for (const index of ready) {
        if (!results[index]) {
          const entity = entities[index] as Record<string, unknown>;
          results[index] = {
            index,
            success: false,
            type: getString(entity.type),
            ref: extractRef(entity) ?? undefined,
            error: 'Skipped (continue_on_error=false)',
            skipped: true,
          };
          const ref = extractRef(entity);
          if (ref) failedRefs.add(ref);
        }
      }
      for (const index of pending) {
        if (!results[index]) {
          const entity = entities[index] as Record<string, unknown>;
          results[index] = {
            index,
            success: false,
            type: getString(entity.type),
            ref: extractRef(entity) ?? undefined,
            error: 'Skipped (continue_on_error=false)',
            skipped: true,
          };
          const ref = extractRef(entity);
          if (ref) failedRefs.add(ref);
        }
      }
      pending.clear();
      break;
    }

    // Remove processed ready items from pending.
    for (const index of ready) {
      pending.delete(index);
    }
  }

  const finalized: BatchCreateEntityResult[] = results.map((result, index) => {
    if (result) return result;
    const entity = entities[index] as Record<string, unknown> | undefined;
    return {
      index,
      success: false,
      type: getString(entity?.type) ?? null,
      ref: extractRef(entity ?? {}) ?? undefined,
      error: 'Unknown failure',
    };
  });

  const created = finalized
    .filter((result) => result.success === true)
    .map((result) => ({
      index: result.index,
      type: result.type ?? 'entity',
      id: result.id ?? '',
      title: result.title,
      ref: result.ref,
    }))
    .filter((item) => item.id.length > 0);

  const failed = finalized
    .filter((result) => result.success !== true)
    .map((result) => ({
      index: result.index,
      type: result.type ?? null,
      ref: result.ref,
      error: result.error ?? 'Failed',
    }));

  const summary = `Created ${created.length}/${entities.length} entities${
    failed.length > 0 ? ` (${failed.length} failed)` : ''
  }.`;

  return {
    summary,
    total: entities.length,
    created_count: created.length,
    failed_count: failed.length,
    results: finalized,
    created,
    failed,
    warnings,
    ref_map: resolvedRefMap,
  };
}
