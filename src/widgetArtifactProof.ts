import { buildEntityLink, buildLiveUrl } from './deepLinks';
import { compareArtifactTimestamps, mergeInitiativeArtifactRecords, normalizeArtifactContext, type ArtifactHierarchyContext } from './widgetArtifactHierarchy';

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

const SOURCE_CLIENT_LABELS: Record<string, string> = {
  api: 'API Client',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  mcp: 'MCP Client',
  openclaw: 'OpenClaw',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
};

type ArtifactCreatorIdentity = {
  type: string | null;
  id: string | null;
  name: string;
};

function formatSourceClientLabel(value: string | null): string | null {
  const slug = toSlug(value);
  if (!slug) return null;
  return (
    SOURCE_CLIENT_LABELS[slug] ??
    slug
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function resolveArtifactCreatorIdentity(
  record: Record<string, unknown>,
  metadata: Record<string, unknown>
): ArtifactCreatorIdentity {
  const producer = asRecord(metadata.producer) ?? {};
  const sourceClient = formatSourceClientLabel(
    firstString(metadata, ['source_client', 'sourceClient', 'client'])
  );
  const explicitName =
    firstString(record, ['created_by_name', 'createdByName', 'created_by']) ??
    firstString(producer, ['label', 'name']) ??
    firstString(metadata, [
      'created_by_name',
      'createdByName',
      'agent_name',
      'agentName',
      'author_name',
      'authorName',
      'owner_name',
      'ownerName',
    ]);
  const createdByType =
    firstString(record, ['created_by_type', 'createdByType']) ??
    firstString(metadata, ['created_by_type', 'createdByType']) ??
    (sourceClient ? 'agent' : null);
  const createdById =
    firstString(record, ['created_by_id', 'createdById']) ??
    firstString(metadata, [
      'created_by_id',
      'createdById',
      'agent_id',
      'agentId',
      'producer_id',
      'producerId',
    ]);

  return {
    type: createdByType,
    id: createdById,
    name:
      explicitName ??
      sourceClient ??
      (toSlug(createdByType) === 'agent'
        ? 'OrgX Agent'
        : toSlug(createdByType) === 'human' || createdById
        ? 'Workspace member'
        : 'OrgX'),
  };
}

export type NormalizedArtifact = {
  id: string | null;
  title: string;
  status: string;
  artifact_type: string | null;
  eval_score: number | null;
  preview_markdown: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  entity_id: string | null;
  entity_type: string | null;
  initiative_id: string | null;
  task_id: string | null;
  workstream_id: string | null;
  milestone_id: string | null;
  context: ArtifactHierarchyContext | null;
  description?: string | null;
  content?: unknown;
  verification?: Record<string, unknown> | null;
  version?: string | number | null;
  artifact_url: string | null;
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
  eval_score: number | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  primary_url: string | null;
  primary_label: string | null;
  task_url: string | null;
  live_url: string | null;
  needs_review: boolean;
  entity_id: string | null;
  entity_type: string | null;
  initiative_id: string | null;
  workstream_id: string | null;
  milestone_id: string | null;
  task_id: string | null;
  context: ArtifactHierarchyContext | null;
  description?: string | null;
  preview_markdown: string | null;
  content?: unknown;
  verification?: Record<string, unknown> | null;
  version?: string | number | null;
  artifact_url: string | null;
  metadata: Record<string, unknown>;
};

export type WidgetContinuationPrompt = {
  surface: SupportedWidgetSurface;
  prompt: string;
};

// Positioning spine: proof surfaces (receipts, proof cards, share cards) carry
// one quiet CTA, verbatim. Renderers place it once, as an unobtrusive footer.
export const PROOF_SURFACE_QUIET_CTA = 'Make your agent work resumable.';

export type WidgetProofHandoff = {
  source: 'orgx-mcp-widget-proof-cards';
  preserve_tool_results: true;
  live_url: string | null;
  proof_count: number;
  proof_count_scope: 'tracked_artifact' | 'available_artifact';
  visible_proof_count: number;
  review_count: number;
  visible_review_count: number;
  primary_prompt: string;
  surface_prompts: WidgetContinuationPrompt[];
  quiet_cta: typeof PROOF_SURFACE_QUIET_CTA;
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

// The independently-judged quality score (work_artifacts.verification.eval.score),
// surfaced so proof cards can show "AQ 0.86" instead of hiding the one number that
// proves the work was reviewed.
function extractEvalScore(
  record: Record<string, unknown>,
  metadata: Record<string, unknown>
): number | null {
  const verification =
    asRecord(record.verification) ?? asRecord(metadata.verification);
  const evalBlock = verification ? asRecord(verification.eval) : null;
  const raw =
    (evalBlock ? evalBlock.score : undefined) ??
    metadata.eval_score ??
    metadata.aq_score;
  if (raw === null || raw === undefined) return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

// Process / status artifacts that describe a run rather than deliver founder-facing
// work — they must not crowd the real, scored deliverables out of the proof cards.
const META_OR_PROCESS_SUFFIXES = [
  'structured_blocker',
  'code_review',
  'progress_update',
  'status_update',
  'retro',
  'retrospective',
  'reconciliation',
  'run_summary',
  'session_summary',
  'recommendation_memo',
  'synthesis_brief',
];

function isMetaOrProcessArtifact(artifact: NormalizedArtifact): boolean {
  const type = toSlug(artifact.artifact_type);
  if (!type) return false;
  const local = type.includes('.')
    ? type.slice(type.lastIndexOf('.') + 1)
    : type;
  return META_OR_PROCESS_SUFFIXES.some(
    (suffix) => local === suffix || local.endsWith(`_${suffix}`)
  );
}

// Rank artifacts for proof surfacing: real, scored domain deliverables first;
// archived rows and process/meta notes (blockers, code reviews, progress updates)
// last. Recency only breaks ties — so a fresh blocker never buries an older scored
// deliverable the way a pure created_at sort did.
function proofRank(artifact: NormalizedArtifact): number {
  let rank = 0;
  if (toSlug(artifact.status) === 'archived') rank -= 100;
  if (isMetaOrProcessArtifact(artifact)) rank -= 50;
  if (typeof artifact.eval_score === 'number') rank += 20;
  return rank;
}

function compareArtifactsForProof(
  a: NormalizedArtifact,
  b: NormalizedArtifact
): number {
  const rankDelta = proofRank(b) - proofRank(a);
  if (rankDelta !== 0) return rankDelta;
  return compareArtifactsByRecency(a, b);
}

function compareArtifactsByRecency(a: NormalizedArtifact, b: NormalizedArtifact): number {
  return compareArtifactTimestamps(
    { updated_at: b.updated_at, created_at: b.created_at }, { updated_at: a.updated_at, created_at: a.created_at })
    || (a.id ?? '').localeCompare(b.id ?? '');
}

export function normalizeArtifactRecord(input: unknown): NormalizedArtifact | null {
  const record = asRecord(input);
  if (!record) return null;
  const metadata = getMetadata(record);
  const creator = resolveArtifactCreatorIdentity(record, metadata);
  const entityId = firstString(record, ['entity_id', 'entityId']);
  const entityType = firstString(record, ['entity_type', 'entityType']);
  const taskId =
    firstString(record, ['task_id', 'taskId']) ??
    (entityType === 'task' ? entityId : null);

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
    eval_score: extractEvalScore(record, metadata),
    preview_markdown:
      firstString(record, ['preview_markdown', 'previewMarkdown']) ??
      firstString(metadata, ['preview_markdown', 'previewMarkdown']),
    summary:
      firstString(record, ['description', 'summary']) ??
      firstString(metadata, ['description', 'summary']),
    created_at:
      firstString(record, ['created_at', 'createdAt']) ??
      firstString(metadata, ['created_at', 'createdAt']),
    updated_at: firstString(record, ['updated_at', 'updatedAt']),
    created_by_type: creator.type,
    created_by_id: creator.id,
    created_by_name: creator.name,
    entity_id: entityId,
    entity_type: entityType,
    initiative_id: firstString(record, ['initiative_id', 'initiativeId']),
    task_id: taskId,
    workstream_id: firstString(record, ['workstream_id', 'workstreamId']),
    milestone_id: firstString(record, ['milestone_id', 'milestoneId']),
    context: normalizeArtifactContext(record.context),
    ...(record.description !== undefined ? { description: typeof record.description === 'string' ? record.description : null } : {}),
    ...(record.content !== undefined || metadata.content !== undefined || metadata.content_markdown !== undefined
      ? { content: record.content !== undefined ? record.content : metadata.content ?? metadata.content_markdown ?? null } : {}),
    ...(record.verification !== undefined || metadata.verification !== undefined
      ? { verification: record.verification !== undefined ? asRecord(record.verification) : asRecord(metadata.verification) } : {}),
    ...(record.version !== undefined ? { version: typeof record.version === 'string' || typeof record.version === 'number' ? record.version : null } : {}),
    artifact_url: firstString(record, ['artifact_url', 'artifactUrl']),
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
  const approved = artifacts.filter(
    (item) => toSlug(item.status) === 'approved'
  ).length;
  const inReview = artifacts.filter(
    (item) => toSlug(item.status) === 'in_review'
  ).length;
  return {
    total: artifacts.length,
    approved,
    in_review: inReview,
    needs_review: artifacts.filter((item) => isReviewableStatus(item.status))
      .length,
  };
}

function mergeArtifactSummary(
  upstreamSummary: unknown,
  displaySummary: Record<string, number>
): Record<string, unknown> {
  // Full-scope API counters may overlap (e.g. eval_passed and in_review).
  // Preserve them exactly; a bounded proof window cannot invent a full delivered count.
  return asRecord(upstreamSummary) ?? { ...displaySummary, unit: 'available_artifact' };
}

function countReviewableProofs(
  summary: Record<string, unknown>,
  proofCards: WidgetProofCard[]
): number {
  return Math.max(
    proofCards.filter((item) => item.needs_review).length,
    typeof summary.needs_review === 'number' ? summary.needs_review : 0,
    typeof summary.in_review === 'number' ? summary.in_review : 0
  );
}

function toWidgetProofCard(artifact: NormalizedArtifact): WidgetProofCard {
  return {
    id: artifact.id,
    title: artifact.title,
    status: artifact.status,
    artifact_type: artifact.artifact_type,
    eval_score: artifact.eval_score ?? null,
    summary: artifact.summary ?? artifact.preview_markdown,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    created_by_type: artifact.created_by_type,
    created_by_id: artifact.created_by_id,
    created_by_name: artifact.created_by_name,
    primary_url: artifact.primary_url ?? null,
    primary_label: artifact.primary_label ?? null,
    task_url: artifact.task_url ?? null,
    live_url: artifact.live_url ?? null,
    needs_review: isReviewableStatus(artifact.status),
    entity_id: artifact.entity_id,
    entity_type: artifact.entity_type,
    initiative_id: artifact.initiative_id,
    workstream_id: artifact.workstream_id,
    milestone_id: artifact.milestone_id,
    task_id: artifact.task_id,
    context: artifact.context,
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    preview_markdown: artifact.preview_markdown,
    ...(artifact.content !== undefined ? { content: artifact.content } : {}),
    ...(artifact.verification !== undefined ? { verification: artifact.verification } : {}),
    ...(artifact.version !== undefined ? { version: artifact.version } : {}),
    artifact_url: artifact.artifact_url,
    metadata: artifact.metadata,
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
    .sort(compareArtifactsForProof)
    .slice(0, limit)
    .map(toWidgetProofCard);
}

export function buildWidgetProofHandoff(options: {
  initiativeId?: string | null;
  initiativeTitle?: string | null;
  proofCount?: number;
  proofCountScope?: 'tracked_artifact' | 'available_artifact';
  visibleProofCount?: number;
  reviewCount?: number;
  visibleReviewCount?: number;
}): WidgetProofHandoff {
  const liveUrl = options.initiativeId ? buildLiveUrl(options.initiativeId) : null;
  const initiativeName = options.initiativeTitle?.trim() || 'this OrgX initiative';
  const proofCount = options.proofCount ?? 0;
  const proofCountScope = options.proofCountScope ?? 'tracked_artifact';
  const countLabel = proofCountScope === 'available_artifact' ? 'available' : 'tracked';
  const visibleProofCount = options.visibleProofCount ?? proofCount;
  const reviewCount = options.reviewCount ?? 0;
  const visibleReviewCount = options.visibleReviewCount ?? reviewCount;
  const proofPhrase =
    proofCount > visibleProofCount
      ? `${visibleProofCount} visible proof card${
          visibleProofCount === 1 ? '' : 's'
        } from ${proofCount} ${countLabel} artifact${
          proofCount === 1 ? '' : 's'
        }`
      : proofCountScope === 'available_artifact'
      ? `${visibleProofCount} visible proof card${visibleProofCount === 1 ? '' : 's'} from ${proofCount} available artifact${proofCount === 1 ? '' : 's'}`
      : `${proofCount} proof card${proofCount === 1 ? '' : 's'}`;
  const reviewPhrase =
    visibleReviewCount > 0
      ? `Start with the ${visibleReviewCount} visible proof card${
          visibleReviewCount === 1 ? '' : 's'
        } marked for review.`
      : reviewCount > 0
      ? `The summary shows ${reviewCount} ${countLabel} artifact${
          reviewCount === 1 ? '' : 's'
        } needing review; use the live link if the review card is not visible in this result.`
      : 'Start by inspecting the newest proof card and the live initiative link.';
  const basePrompt = `Continue ${initiativeName} from this OrgX handoff. Use the ${proofPhrase}, preserve the tool result links, cite the artifact or task link you used, then propose the next concrete action. ${reviewPhrase}${liveUrl ? ` Live view: ${liveUrl}` : ''}`;

  return {
    source: 'orgx-mcp-widget-proof-cards',
    preserve_tool_results: true,
    live_url: liveUrl,
    proof_count: proofCount,
    proof_count_scope: proofCountScope,
    visible_proof_count: visibleProofCount,
    review_count: reviewCount,
    visible_review_count: visibleReviewCount,
    primary_prompt: basePrompt,
    surface_prompts: SUPPORTED_WIDGET_SURFACES.map((surface) => ({
      surface,
      prompt: `Follow primary_prompt above. Continue in ${surface} using the OrgX tools already configured there.`,
    })),
    quiet_cta: PROOF_SURFACE_QUIET_CTA,
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
  const artifacts = mergeInitiativeArtifactRecords(data, artifactsInput)
    .map(normalizeArtifactRecord)
    .filter((item): item is NormalizedArtifact => Boolean(item));
  const linkedArtifacts = artifacts.map((artifact) =>
    attachArtifactLinks(artifact, initiativeId)
  );
  // Surface real, scored deliverables first — not whatever was created most
  // recently (which was reliably a blocker, a code review, or a mistyped image).
  const rankedArtifacts = [...linkedArtifacts].sort(compareArtifactsForProof);
  const visibleArtifacts = rankedArtifacts.slice(0, 5);
  const proofCards = visibleArtifacts.map(toWidgetProofCard);
  const artifactSummary = mergeArtifactSummary(
    data.artifact_summary,
    summarizeArtifacts(artifacts)
  );
  const visibleReviewCount = proofCards.filter((item) => item.needs_review).length;
  const reviewCount = countReviewableProofs(artifactSummary, proofCards);
  return {
    ...data,
    recent_artifacts: [...linkedArtifacts].sort(compareArtifactsByRecency).slice(0, 5),
    proof_cards: proofCards,
    review_items: proofCards.filter((item) => item.needs_review).slice(0, 4),
    artifact_summary: artifactSummary,
    visible_artifact_summary: { ...summarizeArtifacts(visibleArtifacts), unit: 'visible_proof_card' },
    proof_handoff: buildWidgetProofHandoff({
      initiativeId,
      initiativeTitle: firstString(data, ['name', 'title', 'initiative_title', 'initiativeTitle']),
      proofCount: typeof artifactSummary.total === 'number' ? artifactSummary.total : artifacts.length,
      proofCountScope: asRecord(data.artifact_summary) ? 'tracked_artifact' : 'available_artifact',
      visibleProofCount: proofCards.length,
      reviewCount,
      visibleReviewCount,
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
