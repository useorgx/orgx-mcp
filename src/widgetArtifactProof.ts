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

export type SupportedWidgetSurface =
  | 'ChatGPT'
  | 'Cursor'
  | 'Codex'
  | 'Claude'
  | 'VS Code'
  | 'Windsurf'
  | 'Zed';

export type WidgetProofCard = {
  id: string | null;
  title: string;
  status: string;
  artifact_type: string | null;
  summary: string | null;
  created_at: string | null;
  created_by_name: string | null;
  primary_url: string | null;
  primary_label: string | null;
  task_url: string | null;
  live_url: string | null;
  needs_review: boolean;
};

export type WidgetContinuationPrompt = {
  surface: SupportedWidgetSurface;
  prompt: string;
};

export type WidgetProofHandoff = {
  source: 'orgx-mcp-widget-proof-cards';
  preserve_tool_results: true;
  live_url: string | null;
  proof_count: number;
  review_count: number;
  primary_prompt: string;
  surface_prompts: WidgetContinuationPrompt[];
};

export const SUPPORTED_WIDGET_SURFACES: SupportedWidgetSurface[] = [
  'ChatGPT',
  'Cursor',
  'Codex',
  'Claude',
  'VS Code',
  'Windsurf',
  'Zed',
];

export const WIDGET_PROOF_STATE_CONTRACT = {
  source: 'orgx-mcp-widget-proof-cards',
  tool_result_mode: 'preserve',
  states: {
    loading:
      'Render skeleton rows and keep the previous tool result visible until proof cards arrive.',
    full:
      'Show proof cards, artifact summary, review items, task links, artifact links, and live links.',
    empty:
      'Explain that no artifacts have landed yet and route the user to create or run the next task.',
    error:
      'Keep the raw tool result visible, show a concise recovery message, and preserve links that were available.',
    partial:
      'Render available proof cards and mark missing links or review metadata as pending instead of hiding the section.',
  },
  visual: {
    loading_skeleton: true,
    fade_in: true,
    domain_avatars: true,
    domain_dots: true,
    prefers_border: true,
  },
  constraints: {
    csp: 'Use widgetConfig.ts CSP allowlists for resource/connect/base-uri domains.',
    border: 'Honor OpenAI and MCP Apps border preferences; do not create a nested preview frame.',
    continuation:
      'Every surface prompt must tell the user how to continue with the proof cards in their configured AI tool.',
  },
} as const;

function isReviewableStatus(status: string | null): boolean {
  return ['in_review', 'review', 'draft', 'changes_requested'].includes(
    toSlug(status)
  );
}

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
    primary_url: firstString(record, [
      'primary_url',
      'primaryUrl',
      'url',
      'external_url',
      'externalUrl',
      'artifact_url',
      'artifactUrl',
    ]),
    primary_label: firstString(record, [
      'primary_label',
      'primaryLabel',
      'url_label',
      'urlLabel',
    ]),
    task_url: firstString(record, ['task_url', 'taskUrl']),
    live_url: firstString(record, ['live_url', 'liveUrl']),
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
    artifact.task_url ??
    (artifact.task_id && initiativeId
      ? buildEntityLink('task', artifact.task_id, {
          initiativeId,
          label: 'Open task',
        }).url
      : artifact.task_id
      ? buildEntityLink('task', artifact.task_id, {
          label: 'Open task',
        }).url
      : null);
  const liveUrl = artifact.live_url ?? (initiativeId ? buildLiveUrl(initiativeId) : null);

  let primaryUrl: string | null = artifact.primary_url ?? null;
  let primaryLabel: string | null = artifact.primary_label ?? null;

  if (primaryUrl) {
    primaryLabel = primaryLabel ?? 'Open artifact';
  } else if (artifact.id) {
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

function summarizeArtifacts(artifacts: NormalizedArtifact[]) {
  return {
    total: artifacts.length,
    approved: artifacts.filter((item) => toSlug(item.status) === 'approved').length,
    in_review: artifacts.filter((item) => toSlug(item.status) === 'in_review').length,
    needs_review: artifacts.filter((item) => isReviewableStatus(item.status)).length,
  };
}

function toWidgetProofCard(artifact: NormalizedArtifact): WidgetProofCard {
  return {
    id: artifact.id,
    title: artifact.title,
    status: artifact.status,
    artifact_type: artifact.artifact_type,
    summary: artifact.summary ?? artifact.preview_markdown,
    created_at: artifact.created_at,
    created_by_name: artifact.created_by_name,
    primary_url: artifact.primary_url ?? null,
    primary_label: artifact.primary_label ?? null,
    task_url: artifact.task_url ?? null,
    live_url: artifact.live_url ?? null,
    needs_review: isReviewableStatus(artifact.status),
  };
}

export function buildWidgetProofCards(
  artifactsInput: unknown[],
  options: { initiativeId?: string | null; limit?: number } = {}
): WidgetProofCard[] {
  const limit = options.limit ?? 6;
  return artifactsInput
    .map(normalizeArtifactRecord)
    .filter((item): item is NormalizedArtifact => Boolean(item))
    .map((artifact) => attachArtifactLinks(artifact, options.initiativeId ?? null))
    .slice(0, limit)
    .map(toWidgetProofCard);
}

export function buildWidgetProofHandoff(options: {
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  proofCount?: number;
  reviewCount?: number;
}): WidgetProofHandoff {
  const liveUrl = options.initiativeId ? buildLiveUrl(options.initiativeId) : null;
  const initiativeName = options.initiativeTitle?.trim() || 'this OrgX initiative';
  const proofCount = options.proofCount ?? 0;
  const reviewCount = options.reviewCount ?? 0;
  const reviewPhrase =
    reviewCount > 0
      ? `Start with the ${reviewCount} proof card${reviewCount === 1 ? '' : 's'} marked for review.`
      : 'Start by inspecting the newest proof card and the live initiative link.';
  const basePrompt = `Continue ${initiativeName} from this OrgX handoff. Use the ${proofCount} proof card${proofCount === 1 ? '' : 's'}, preserve the tool result links, cite the artifact or task link you used, then propose the next concrete action. ${reviewPhrase}${liveUrl ? ` Live view: ${liveUrl}` : ''}`;

  return {
    source: 'orgx-mcp-widget-proof-cards',
    preserve_tool_results: true,
    live_url: liveUrl,
    proof_count: proofCount,
    review_count: reviewCount,
    primary_prompt: basePrompt,
    surface_prompts: SUPPORTED_WIDGET_SURFACES.map((surface) => ({
      surface,
      prompt: `${basePrompt} Continue in ${surface} using the OrgX tools already configured there.`,
    })),
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
    const proofCards = matchedArtifacts.slice(0, 3).map(toWidgetProofCard);

    const totalTasks = collectTaskEntries(agent).length;
    const blockedCount = Array.isArray(agent.blockers) ? agent.blockers.length : 0;
    const streamCount = firstArray(agent, ['streams', 'active_streams', 'activeStreams']).length;

    return {
      ...agent,
      artifacts: matchedArtifacts.slice(0, 3),
      proof_cards: proofCards,
      artifact_count: matchedArtifacts.length,
      proof_handoff: buildWidgetProofHandoff({
        initiativeId: firstString(agent, ['initiative_id', 'initiativeId']),
        initiativeTitle: firstString(agent, ['initiative_title', 'initiativeTitle']),
        proofCount: matchedArtifacts.length,
        reviewCount: proofCards.filter((item) => item.needs_review).length,
      }),
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
  const linkedArtifacts = artifacts.map((artifact) =>
    attachArtifactLinks(artifact, initiativeId)
  );
  const proofCards = linkedArtifacts.slice(0, 5).map(toWidgetProofCard);
  return {
    ...data,
    recent_artifacts: linkedArtifacts.slice(0, 5),
    proof_cards: proofCards,
    review_items: proofCards.filter((item) => item.needs_review).slice(0, 4),
    artifact_summary: summarizeArtifacts(artifacts),
    proof_handoff: buildWidgetProofHandoff({
      initiativeId,
      initiativeTitle: firstString(data, ['name', 'title', 'initiative_title', 'initiativeTitle']),
      proofCount: artifacts.length,
      reviewCount: proofCards.filter((item) => item.needs_review).length,
    }),
    widget_state_contract: WIDGET_PROOF_STATE_CONTRACT,
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
  const linkedArtifacts = artifacts.map((artifact) =>
    attachArtifactLinks(artifact, initiativeId)
  );
  const proofCards = linkedArtifacts.slice(0, 6).map(toWidgetProofCard);
  const reviewItems = linkedArtifacts.filter((artifact) =>
    isReviewableStatus(artifact.status)
  );
  const approvedItems = artifacts.filter(
    (artifact) => toSlug(artifact.status) === 'approved'
  );

  return {
    ...data,
    artifacts_produced: linkedArtifacts.slice(0, 6),
    review_items: reviewItems.slice(0, 4),
    proof_cards: proofCards,
    artifact_summary: {
      total: artifacts.length,
      approved: approvedItems.length,
      in_review: artifacts.filter((artifact) => toSlug(artifact.status) === 'in_review').length,
      needs_review: reviewItems.length,
    },
    proof_handoff: buildWidgetProofHandoff({
      initiativeId,
      initiativeTitle: firstString(data, ['name', 'title', 'initiative_title', 'initiativeTitle']),
      proofCount: artifacts.length,
      reviewCount: reviewItems.length,
    }),
    widget_state_contract: WIDGET_PROOF_STATE_CONTRACT,
  };
}
