import { buildEntityLink, buildLiveUrl } from './deepLinks';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function toSlug(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function getMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.metadata) ?? {};
}

export type NormalizedArtifact = {
  id: string | null;
  title: string;
  status: string;
  artifact_type: string | null;
  preview_markdown: string | null;
  summary: string | null;
  created_at: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  entity_id: string | null;
  entity_type: string | null;
  initiative_id: string | null;
  task_id: string | null;
  metadata: Record<string, unknown>;
  primary_url?: string | null;
  primary_label?: string | null;
  task_url?: string | null;
  live_url?: string | null;
};

export function normalizeArtifactRecord(input: unknown): NormalizedArtifact | null {
  const record = asRecord(input);
  if (!record) return null;
  const metadata = getMetadata(record);
  const entityId =
    firstString(record, ['entity_id', 'entityId']) ??
    firstString(metadata, ['entity_id', 'entityId', 'task_id', 'taskId']);
  const entityType =
    firstString(record, ['entity_type', 'entityType']) ??
    firstString(metadata, ['entity_type', 'entityType']);
  const taskId =
    firstString(record, ['task_id', 'taskId']) ??
    (entityType === 'task' ? entityId : null) ??
    firstString(metadata, ['task_id', 'taskId']);

  return {
    id: firstString(record, ['id', 'artifact_id', 'artifactId']),
    title:
      firstString(record, ['title', 'name', 'label']) ??
      firstString(metadata, ['title', 'name']) ??
      'Untitled artifact',
    status:
      firstString(record, ['status', 'state']) ??
      firstString(metadata, ['status', 'state']) ??
      'draft',
    artifact_type:
      firstString(record, ['artifact_type', 'artifactType']) ??
      firstString(metadata, ['artifact_type', 'artifactType']),
    preview_markdown:
      firstString(record, ['preview_markdown', 'previewMarkdown']) ??
      firstString(metadata, ['preview_markdown', 'previewMarkdown']),
    summary:
      firstString(record, ['description', 'summary']) ??
      firstString(metadata, ['description', 'summary']),
    created_at:
      firstString(record, ['created_at', 'createdAt', 'updated_at', 'updatedAt']) ??
      firstString(metadata, ['created_at', 'createdAt']),
    created_by_type:
      firstString(record, ['created_by_type', 'createdByType']) ??
      firstString(metadata, ['created_by_type', 'createdByType']),
    created_by_id:
      firstString(record, ['created_by_id', 'createdById']) ??
      firstString(metadata, ['created_by_id', 'createdById', 'agent_id', 'agentId']),
    created_by_name:
      firstString(record, ['created_by_name', 'createdByName', 'created_by']) ??
      firstString(metadata, ['created_by_name', 'createdByName', 'agent_name', 'agentName']),
    entity_id: entityId,
    entity_type: entityType,
    initiative_id:
      firstString(record, ['initiative_id', 'initiativeId']) ??
      firstString(metadata, ['initiative_id', 'initiativeId']),
    task_id: taskId,
    metadata,
  };
}

function collectTaskEntries(agent: Record<string, unknown>): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const arrays = [
    ...firstArray(agent, ['current_tasks', 'currentTasks']),
    ...firstArray(agent, ['active_tasks', 'activeTasks']),
    ...firstArray(agent, ['tasks', 'items']),
  ];
  for (const item of arrays) {
    const record = asRecord(item);
    if (record) entries.push(record);
  }
  const nestedTask = asRecord(agent.task);
  if (nestedTask) entries.push(nestedTask);
  return entries;
}

function collectAgentTaskIds(agent: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const entry of collectTaskEntries(agent)) {
    const id =
      firstString(entry, ['id', 'task_id', 'taskId', 'entity_id', 'entityId']) ??
      firstString(getMetadata(entry), ['task_id', 'taskId', 'entity_id', 'entityId']);
    if (id) ids.add(id);
  }
  return ids;
}

function collectAgentIdentityTokens(agent: Record<string, unknown>): Set<string> {
  const tokens = new Set<string>();
  const values = [
    firstString(agent, ['agent_id', 'agentId', 'id']),
    firstString(agent, ['agent_name', 'agentName', 'name', 'title', 'label']),
    firstString(agent, ['agent_type', 'agentType', 'type']),
    firstString(agent, ['role', 'persona']),
    firstString(agent, ['domain', 'agent_domain', 'agentDomain']),
  ];
  for (const value of values) {
    const slug = toSlug(value);
    if (slug) tokens.add(slug);
  }
  return tokens;
}

function artifactMatchesAgent(
  artifact: NormalizedArtifact,
  taskIds: Set<string>,
  identityTokens: Set<string>
): boolean {
  if (artifact.task_id && taskIds.has(artifact.task_id)) return true;
  if (
    artifact.entity_type === 'task' &&
    artifact.entity_id &&
    taskIds.has(artifact.entity_id)
  ) {
    return true;
  }

  const artifactTokens = new Set(
    [
      artifact.created_by_id,
      artifact.created_by_name,
      firstString(artifact.metadata, ['agent_id', 'agentId']),
      firstString(artifact.metadata, ['agent_name', 'agentName']),
      firstString(artifact.metadata, ['domain', 'agent_domain', 'agentDomain']),
    ]
      .map((value) => toSlug(value))
      .filter(Boolean)
  );

  for (const token of identityTokens) {
    if (artifactTokens.has(token)) return true;
  }
  return false;
}

function attachArtifactLinks(
  artifact: NormalizedArtifact,
  fallbackInitiativeId: string | null = null
): NormalizedArtifact {
  const initiativeId = artifact.initiative_id ?? fallbackInitiativeId ?? null;
  const taskUrl =
    artifact.task_id && initiativeId
      ? buildEntityLink('task', artifact.task_id, {
          initiativeId,
          label: 'Open task',
        }).url
      : artifact.task_id
      ? buildEntityLink('task', artifact.task_id, {
          label: 'Open task',
        }).url
      : null;
  const liveUrl = initiativeId ? buildLiveUrl(initiativeId) : null;

  let primaryUrl: string | null = null;
  let primaryLabel: string | null = null;

  if (artifact.id) {
    primaryUrl = buildEntityLink('artifact', artifact.id, {
      initiativeId: initiativeId ?? undefined,
      label: 'Open artifact',
    }).url;
    primaryLabel = 'Open artifact';
  } else if (taskUrl) {
    primaryUrl = taskUrl;
    primaryLabel = 'Open task';
  } else if (liveUrl) {
    primaryUrl = liveUrl;
    primaryLabel = 'Open live view';
  }

  return {
    ...artifact,
    primary_url: primaryUrl,
    primary_label: primaryLabel,
    task_url: taskUrl,
    live_url: liveUrl,
  };
}

export function enrichAgentStatusWithArtifacts(
  data: Record<string, unknown>,
  artifactsInput: unknown[]
): Record<string, unknown> {
  if (!Array.isArray(data.agents) || !Array.isArray(artifactsInput)) return data;
  const artifacts = artifactsInput
    .map(normalizeArtifactRecord)
    .filter((item): item is NormalizedArtifact => Boolean(item));

  const nextAgents = data.agents.map((rawAgent) => {
    const agent = asRecord(rawAgent);
    if (!agent) return rawAgent;
    const taskIds = collectAgentTaskIds(agent);
    const identityTokens = collectAgentIdentityTokens(agent);
    const matchedArtifacts = artifacts
      .filter((artifact) => artifactMatchesAgent(artifact, taskIds, identityTokens))
      .map((artifact) =>
        attachArtifactLinks(
          artifact,
          firstString(agent, ['initiative_id', 'initiativeId'])
        )
      );

    const totalTasks = collectTaskEntries(agent).length;
    const blockedCount = Array.isArray(agent.blockers) ? agent.blockers.length : 0;
    const streamCount = firstArray(agent, ['streams', 'active_streams', 'activeStreams']).length;

    return {
      ...agent,
      artifacts: matchedArtifacts.slice(0, 3),
      artifact_count: matchedArtifacts.length,
      workload: {
        tasks_in_progress: totalTasks,
        blocked_count: blockedCount,
        stream_count: streamCount,
      },
    };
  });

  return {
    ...data,
    agents: nextAgents,
  };
}

export function enrichInitiativePulseWithArtifacts(
  data: Record<string, unknown>,
  artifactsInput: unknown[]
): Record<string, unknown> {
  const initiativeId =
    firstString(data, ['initiative_id', 'initiativeId', 'id']) ?? null;
  const artifacts = artifactsInput
    .map(normalizeArtifactRecord)
    .filter((item): item is NormalizedArtifact => Boolean(item));
  return {
    ...data,
    recent_artifacts: artifacts
      .map((artifact) => attachArtifactLinks(artifact, initiativeId))
      .slice(0, 5),
    artifact_summary: {
      total: artifacts.length,
      approved: artifacts.filter((item) => toSlug(item.status) === 'approved').length,
      in_review: artifacts.filter((item) => toSlug(item.status) === 'in_review').length,
    },
  };
}

export function enrichMorningBriefWithArtifacts(
  data: Record<string, unknown>,
  artifactsInput: unknown[]
): Record<string, unknown> {
  const initiativeId =
    firstString(data, ['initiative_id', 'initiativeId']) ?? null;
  const artifacts = artifactsInput
    .map(normalizeArtifactRecord)
    .filter((item): item is NormalizedArtifact => Boolean(item));
  if (artifacts.length === 0) return data;

  const reviewItems = artifacts.filter((artifact) =>
    ['in_review', 'draft', 'changes_requested'].includes(toSlug(artifact.status))
  );
  const approvedItems = artifacts.filter(
    (artifact) => toSlug(artifact.status) === 'approved'
  );

  return {
    ...data,
    artifacts_produced: artifacts
      .map((artifact) => attachArtifactLinks(artifact, initiativeId))
      .slice(0, 6),
    review_items: reviewItems
      .map((artifact) => attachArtifactLinks(artifact, initiativeId))
      .slice(0, 4),
    artifact_summary: {
      total: artifacts.length,
      approved: approvedItems.length,
      in_review: artifacts.filter((artifact) => toSlug(artifact.status) === 'in_review').length,
    },
  };
}
