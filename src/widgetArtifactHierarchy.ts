type RecordValue = Record<string, unknown>;
type EntityKind = 'initiative' | 'workstream' | 'milestone' | 'task' | 'decision';
export type ArtifactContextRef = { id: string; title: string };
export type ArtifactHierarchyContext = {
  initiative: ArtifactContextRef;
  workstream?: ArtifactContextRef;
  milestone?: ArtifactContextRef;
  task?: ArtifactContextRef;
};

function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function ref(value: RecordValue, kind: EntityKind): ArtifactContextRef | null {
  const id = string(value.id) ?? string(value[`${kind}_id`]);
  return id ? { id, title: string(value.title) ?? string(value.name) ?? kind } : null;
}
function items(value: RecordValue, key: string): RecordValue[] {
  return Array.isArray(value[key]) ? value[key].map(record).filter((v): v is RecordValue => Boolean(v)) : [];
}

function artifactTimestamp(value: RecordValue): { milliseconds: number; fraction: number } {
  for (const key of ['updated_at', 'updatedAt', 'created_at', 'createdAt']) {
    const stamp = string(value[key]) ?? '';
    const milliseconds = Date.parse(stamp);
    if (Number.isFinite(milliseconds)) {
      const fraction = stamp.match(/\.(\d{1,9})(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1] ?? '';
      return { milliseconds, fraction: Number(fraction.padEnd(9, '0')) };
    }
  }
  return { milliseconds: 0, fraction: 0 };
}

export function artifactRevisionTime(value: RecordValue): number {
  return artifactTimestamp(value).milliseconds;
}

/** Compare the full timestamp even when Date.parse truncates native fractions. */
export function compareArtifactTimestamps(a: RecordValue, b: RecordValue): number {
  const left = artifactTimestamp(a), right = artifactTimestamp(b);
  return left.milliseconds - right.milliseconds || left.fraction - right.fraction;
}

export function normalizeArtifactContext(value: unknown): ArtifactHierarchyContext | null {
  const input = record(value);
  const normalizeRef = (value: unknown): ArtifactContextRef | null => {
    const input = record(value), id = string(input?.id), title = string(input?.title);
    return id && title ? { id, title } : null;
  };
  const initiative = normalizeRef(input?.initiative);
  if (!initiative) return null;
  const context: ArtifactHierarchyContext = { initiative };
  for (const kind of ['workstream', 'milestone', 'task'] as const) {
    const child = normalizeRef(input?.[kind]);
    if (child) context[kind] = child;
  }
  return context;
}

/** Only the API's persisted hierarchy establishes membership. Artifact metadata
 * is descriptive and cannot admit a task from another initiative. */
function hierarchy(data: RecordValue, initiativeId: string) {
  const initiative = { id: initiativeId, title: string(data.name) ?? string(data.title) ?? 'Initiative' };
  const contexts = new Map<string, ArtifactHierarchyContext>([
    [`initiative:${initiativeId}`, { initiative }],
  ]);
  const admitted = (value: RecordValue) => !string(value.initiative_id) || value.initiative_id === initiativeId;
  const add = (kind: EntityKind, value: RecordValue, parent: ArtifactHierarchyContext) => {
    if (!admitted(value)) return null;
    const entity = ref(value, kind);
    if (!entity) return null;
    const context = kind === 'decision' ? parent : { ...parent, [kind]: entity };
    contexts.set(`${kind}:${entity.id}`, context);
    return context;
  };
  const task = (value: RecordValue, parent: ArtifactHierarchyContext) => {
    const milestoneId = string(value.milestone_id);
    const workstreamId = string(value.workstream_id);
    const milestone = milestoneId ? contexts.get(`milestone:${milestoneId}`) : null;
    const workstream = workstreamId ? contexts.get(`workstream:${workstreamId}`) : null;
    if ((milestoneId && !milestone) || (workstreamId && !workstream)) return;
    if (milestone?.workstream && workstream?.workstream && milestone.workstream.id !== workstream.workstream.id) return;
    add('task', value, milestone ?? workstream ?? parent);
  };
  const milestone = (value: RecordValue, parent: ArtifactHierarchyContext) => {
    const workstreamId = string(value.workstream_id);
    const workstream = workstreamId ? contexts.get(`workstream:${workstreamId}`) : null;
    if (workstreamId && !workstream) return;
    const context = add('milestone', value, workstream ?? parent);
    if (context) items(value, 'tasks').forEach((entry) => task(entry, context));
  };
  const roots = [data, record(data.hierarchy)].filter((v): v is RecordValue => Boolean(v) && admitted(v!));
  for (const root of roots) {
    for (const entry of [...items(root, 'workstreams'), ...items(root, 'workStreams')]) {
      const context = add('workstream', entry, { initiative });
      if (!context) continue;
      items(entry, 'milestones').forEach((value) => milestone(value, context));
      items(entry, 'tasks').forEach((value) => task(value, context));
    }
  }
  for (const root of roots) {
    items(root, 'milestones').forEach((value) => milestone(value, { initiative }));
    items(root, 'tasks').forEach((value) => task(value, { initiative }));
    items(root, 'decisions').forEach((value) => add('decision', value, { initiative }));
    for (const agent of items(root, 'agents')) {
      if (!admitted(agent)) continue;
      for (const key of ['current_tasks', 'currentTasks', 'active_tasks', 'activeTasks', 'tasks', 'items']) {
        items(agent, key).forEach((value) => task(value, { initiative }));
      }
      const nested = record(agent.task);
      if (nested) task(nested, { initiative });
    }
  }
  return { initiative, contexts };
}

function artifactVersion(value: RecordValue): string | null {
  return typeof value.version === 'number' && Number.isFinite(value.version)
    ? String(value.version) : string(value.version);
}

function sameArtifactRevision(a: RecordValue, b: RecordValue): boolean {
  const left = string(a.updated_at) ?? string(a.updatedAt);
  const right = string(b.updated_at) ?? string(b.updatedAt);
  const av = artifactVersion(a), bv = artifactVersion(b);
  return Boolean(left && left === right && Number.isFinite(Date.parse(left))
    && !(av !== null && bv !== null && av !== bv));
}

function isNewerArtifact(a: RecordValue, b: RecordValue): boolean {
  const timeDelta = compareArtifactTimestamps(a, b);
  if (timeDelta !== 0) return timeDelta > 0;
  const av = artifactVersion(a), bv = artifactVersion(b);
  return av !== null && bv !== null && Number.isFinite(Number(av))
    && Number.isFinite(Number(bv)) && Number(av) > Number(bv);
}

function mergeRevision(preferred: RecordValue, supplemental: RecordValue): RecordValue {
  // Mutable version numbers and metadata digests cannot prove review currency.
  // Supplement only an identical authoritative update with compatible versions.
  if (!sameArtifactRevision(preferred, supplemental)) return { ...preferred };
  const merged = { ...supplemental, ...preferred };
  if (record(supplemental.metadata) && record(preferred.metadata)) {
    merged.metadata = { ...record(supplemental.metadata), ...record(preferred.metadata) };
  }
  const currentMetadata = record(preferred.metadata);
  if (preferred.content === undefined && currentMetadata?.content !== undefined) merged.content = currentMetadata.content;
  else if (preferred.content === undefined && currentMetadata?.content_markdown !== undefined) merged.content = currentMetadata.content_markdown;
  return merged;
}

/** Preserve the authenticated pulse's current rows, union descendant fetches,
 * and choose the newest revision before normalization can discard fields. */
export function mergeInitiativeArtifactRecords(data: RecordValue, fetched: unknown[]): RecordValue[] {
  const initiativeId = string(data.initiative_id) ?? string(data.initiativeId) ?? string(data.id);
  if (!initiativeId) return [];
  const scope = hierarchy(data, initiativeId);
  const merged = new Map<string, RecordValue>();
  const append = (value: unknown, trustedPulse: boolean, index: number) => {
    const artifact = record(value);
    if (!artifact) return;
    const suppliedInitiative = string(artifact.initiative_id) ?? string(artifact.initiativeId);
    if (suppliedInitiative && suppliedInitiative !== initiativeId) return;
    const entityType = string(artifact.entity_type) ?? string(artifact.entityType);
    const entityId = string(artifact.entity_id) ?? string(artifact.entityId);
    const context = entityType && entityId ? scope.contexts.get(`${entityType}:${entityId}`) : null;
    const authenticatedDecision = trustedPulse && entityType === 'decision' && entityId
      && normalizeArtifactContext(artifact.context)?.initiative.id === initiativeId;
    // Older authenticated pulse projections lack native ownership fields. Keep
    // those rows, but never grant the same exception to the independent fetch.
    if (!context && !authenticatedDecision && (!trustedPulse || entityType || entityId)) return;
    const id = string(artifact.id) ?? string(artifact.artifact_id) ?? string(artifact.artifactId);
    const key = id ?? `${trustedPulse ? 'pulse' : 'fetch'}:${index}`;
    const previous = merged.get(key);
    const next = previous
      ? isNewerArtifact(artifact, previous)
        ? mergeRevision(artifact, previous) : mergeRevision(previous, artifact)
      : artifact;
    const nextType = string(next.entity_type) ?? string(next.entityType);
    const nextId = string(next.entity_id) ?? string(next.entityId);
    const nativeContext = nextType && nextId ? scope.contexts.get(`${nextType}:${nextId}`) : null;
    const suppliedContext = normalizeArtifactContext(next.context);
    // Direct initiative rows can carry a server-resolved legacy child context;
    // validate every child against the persisted hierarchy before retaining it.
    const projectedContext = (trustedPulse || nextType === 'initiative') && (!suppliedContext || suppliedContext.initiative.id === initiativeId)
      ? (['task', 'milestone', 'workstream'] as const).map((kind) => {
          const id = string(next[`${kind}_id`]) ?? suppliedContext?.[kind]?.id;
          return id ? scope.contexts.get(`${kind}:${id}`) : null;
        }).find(Boolean) : null;
    const canonicalContext = (nextType === 'initiative'
      ? projectedContext ?? nativeContext : nativeContext ?? projectedContext)
      ?? (authenticatedDecision ? { initiative: scope.initiative } : null);
    const output: RecordValue = { ...next, initiative_id: initiativeId };
    output.context = canonicalContext ?? null;
    for (const kind of ['workstream', 'milestone', 'task'] as const) {
      output[`${kind}_id`] = canonicalContext?.[kind]?.id ?? null;
    }
    merged.set(key, output);
  };
  // The recent projection wins equal-revision ties over a clipped proof card.
  [...items(data, 'recent_artifacts'), ...items(data, 'proof_cards')].forEach((value, index) => append(value, true, index));
  fetched.forEach((value, index) => append(value, false, index));
  return [...merged.values()];
}
