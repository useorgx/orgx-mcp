/**
 * Cross-Pollination Layer for OrgX MCP
 *
 * Implements the AI Memory Layer architecture:
 * 1. Auto-Capture: Detects and persists valuable outputs from MCP sessions
 * 2. Context Injection: Proactively includes relevant prior work in responses
 * 3. Session-to-Entity: Converts Claude work into structured OrgX entities
 *
 * See: docs/architecture/cross-pollination-system.md
 */

import { z } from 'zod';

// =============================================================================
// TYPES
// =============================================================================

export interface McpClientInfo {
  name: string;
  version?: string;
}

export type SourceClient =
  | 'cursor'
  | 'claude'
  | 'chatgpt'
  | 'vscode'
  | 'goose'
  | 'api'
  | 'webapp'
  | 'other';

export type Domain =
  | 'product'
  | 'engineering'
  | 'marketing'
  | 'sales'
  | 'operations'
  | 'design'
  | 'general';

export type ArtifactCategory =
  | 'spec'
  | 'brief'
  | 'analysis'
  | 'draft'
  | 'decision'
  | 'process'
  | 'code'
  | 'research'
  | 'other';

export interface ArtifactClassification {
  primaryDomain: Domain;
  secondaryDomains: Domain[];
  artifactCategory: ArtifactCategory;
  keywords: string[];
}

export interface CapturedArtifact {
  id: string;
  title: string;
  summary: string;
  type: string;
  content?: string;
  primaryDomain: Domain;
  secondaryDomains: Domain[];
  artifactCategory: ArtifactCategory;
  keywords: string[];
  runId: string;
  createdAt: string;
}

export interface RelatedContext {
  artifacts: Array<{
    id: string;
    title: string;
    summary: string;
    domain: Domain;
    category: ArtifactCategory;
    sourceClient: SourceClient | null;
    createdAt: string;
    relevanceScore: number;
  }>;
  decisions: Array<{
    id: string;
    title: string;
    summary: string;
    status: string;
    decisionType: string;
    createdAt: string;
  }>;
  memories: Array<{
    id: string;
    agentId: string;
    memoryType: string;
    memoryKey: string;
    memoryValue: unknown;
    confidence: number;
    applyCount: number;
  }>;
  _meta: {
    userId: string;
    domain: Domain | null;
    query: string | null;
    initiativeId: string | null;
    retrievedAt: string;
  };
}

export interface ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  // Cross-pollination enrichments
  _relatedContext?: {
    message: string;
    items: Array<{
      title: string;
      domain: string;
      preview: string;
      link: string;
    }>;
  };
  _workspaceInfluence?: {
    sourcedFrom: Array<{
      type: 'artifact' | 'decision' | 'initiative';
      id: string;
      title: string;
      domain: string;
      createdAt: string;
      relevanceScore: number;
    }>;
    message: string;
  };
}

// =============================================================================
// CAPTURE SIGNALS
// =============================================================================

export type CaptureSignal =
  | 'tool_output_substantial' // Tool returned >500 chars structured output
  | 'explicit_save_request' // User asked to "save this" or "remember this"
  | 'entity_created' // Created initiative, task, milestone
  | 'decision_made' // Approved/rejected a decision
  | 'session_ended'; // Session completed (batch capture)

/**
 * Determine if a tool output should trigger auto-capture
 */
export function shouldCapture(
  toolId: string,
  output: Record<string, unknown>,
  signal?: CaptureSignal
): boolean {
  // Explicit signal takes precedence
  if (signal === 'explicit_save_request') return true;
  if (signal === 'entity_created') return true;
  if (signal === 'decision_made') return true;

  // Skip read-only tools
  const readOnlyTools = [
    'get_pending_decisions',
    'get_agent_status',
    'query_org_memory',
    'get_initiative_pulse',
    'get_decision_history',
    'get_active_sessions',
    'list_entities',
    'configure_org',
    'stats',
  ];
  if (readOnlyTools.includes(toolId)) return false;

  // Check for substantial output
  const outputStr = JSON.stringify(output);
  if (outputStr.length < 500) return false;

  // Check for artifact-like fields
  const hasArtifactFields =
    'title' in output ||
    'summary' in output ||
    'content' in output ||
    'data' in output ||
    'artifact' in output;

  return hasArtifactFields;
}

// =============================================================================
// DOMAIN CLASSIFICATION (LLM-POWERED)
// =============================================================================

/**
 * LLM-based classification of artifact domain and category
 * Falls back to heuristics only if LLM call fails
 */
export async function classifyArtifactWithLLM(
  title: string,
  content: string,
  toolId: string | undefined,
  apiBaseUrl: string
): Promise<ArtifactClassification> {
  try {
    // Call the LLM classification API
    const response = await fetch(
      `${apiBaseUrl}/api/cross-pollination/classify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          content: content.slice(0, 4000), // Limit content for token efficiency
          tool_id: toolId,
        }),
      }
    );

    if (!response.ok) {
      console.warn(
        '[cross-pollination] LLM classification failed, using heuristic fallback'
      );
      return classifyArtifactHeuristic(title, content, toolId);
    }

    const result = (await response.json()) as {
      ok: boolean;
      data?: ArtifactClassification;
      error?: string;
    };

    if (!result.ok || !result.data) {
      console.warn(
        '[cross-pollination] LLM classification returned error:',
        result.error
      );
      return classifyArtifactHeuristic(title, content, toolId);
    }

    return result.data;
  } catch (error) {
    console.warn(
      '[cross-pollination] LLM classification error, using heuristic fallback:',
      error
    );
    return classifyArtifactHeuristic(title, content, toolId);
  }
}

/**
 * Synchronous heuristic classification (fallback only)
 * Used when LLM classification is unavailable or fails
 */
export function classifyArtifactHeuristic(
  title: string,
  content: string,
  toolId?: string
): ArtifactClassification {
  const text = `${title} ${content}`.toLowerCase();

  // Domain signals
  const domainSignals: Record<Domain, RegExp> = {
    product:
      /feature|roadmap|priorit|backlog|requirement|spec|user\s*stor|product\s*brief|prd/i,
    engineering:
      /technical|architecture|api|database|code|implement|deploy|infrastructure|schema|endpoint/i,
    marketing:
      /launch|campaign|messaging|audience|content|brand|marketing|copy|landing\s*page|seo/i,
    sales:
      /pipeline|deal|prospect|revenue|pricing|proposal|sales|customer|lead|crm/i,
    operations:
      /process|sop|workflow|budget|schedule|vendor|operations|procedure|policy/i,
    design:
      /component|ui|ux|token|accessibility|visual|design|wireframe|prototype|figma/i,
    general: /.*/,
  };

  // Score each domain
  const scores: Array<{ domain: Domain; score: number }> = [];
  for (const [domain, regex] of Object.entries(domainSignals)) {
    if (domain === 'general') continue;
    const matches = text.match(new RegExp(regex.source, 'gi')) || [];
    if (matches.length > 0) {
      scores.push({ domain: domain as Domain, score: matches.length });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // Get primary and secondary domains
  const primaryDomain: Domain =
    scores.length > 0 ? scores[0].domain : 'general';
  const secondaryDomains: Domain[] = scores.slice(1, 3).map((s) => s.domain);

  // Determine category
  let artifactCategory: ArtifactCategory = 'other';
  if (/spec|specification|requirement|prd/i.test(text)) {
    artifactCategory = 'spec';
  } else if (/brief|overview|summary/i.test(text)) {
    artifactCategory = 'brief';
  } else if (/analysis|research|study|report/i.test(text)) {
    artifactCategory = 'analysis';
  } else if (/draft|outline|proposal/i.test(text)) {
    artifactCategory = 'draft';
  } else if (/decision|approve|reject|choose/i.test(text)) {
    artifactCategory = 'decision';
  } else if (/process|workflow|procedure|sop/i.test(text)) {
    artifactCategory = 'process';
  } else if (/code|function|class|api|endpoint/i.test(text)) {
    artifactCategory = 'code';
  } else if (/research|finding|insight|competitive/i.test(text)) {
    artifactCategory = 'research';
  }

  // Extract keywords
  const keywords = extractKeywords(text);

  return {
    primaryDomain,
    secondaryDomains,
    artifactCategory,
    keywords,
  };
}

/**
 * Legacy sync wrapper - use classifyArtifactWithLLM in async contexts
 * @deprecated Use classifyArtifactWithLLM for better accuracy
 */
export function classifyArtifact(
  title: string,
  content: string,
  toolId?: string
): ArtifactClassification {
  return classifyArtifactHeuristic(title, content, toolId);
}

/**
 * Extract keywords from text
 */
function extractKeywords(text: string, maxKeywords = 20): string[] {
  // Common stop words to filter out
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'this',
    'that',
    'have',
    'will',
    'been',
    'were',
    'they',
    'your',
    'what',
    'when',
    'where',
    'which',
    'their',
    'about',
    'would',
    'could',
    'should',
    'there',
    'these',
    'those',
    'other',
    'after',
    'before',
    'being',
    'between',
    'during',
    'through',
    'against',
    'without',
  ]);

  // Split into words, filter, dedupe
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word))
    .filter((word) => /^[a-z]+$/.test(word)); // Only alphabetic

  // Get unique words
  const uniqueWords = [...new Set(words)];

  return uniqueWords.slice(0, maxKeywords);
}

// =============================================================================
// SOURCE CLIENT DETECTION
// =============================================================================

/**
 * Detect MCP client type from client info
 */
export function detectSourceClient(clientInfo?: McpClientInfo): SourceClient {
  if (!clientInfo?.name) return 'other';

  const name = clientInfo.name.toLowerCase();

  if (name.includes('cursor')) return 'cursor';
  if (name.includes('claude')) return 'claude';
  if (name.includes('chatgpt') || name.includes('openai')) return 'chatgpt';
  if (name.includes('vscode') || name.includes('visual studio code'))
    return 'vscode';
  if (name.includes('goose')) return 'goose';
  if (name.includes('api')) return 'api';
  if (name.includes('webapp') || name.includes('web')) return 'webapp';

  return 'other';
}

// =============================================================================
// CONTEXT INJECTION
// =============================================================================

/**
 * Tools that should trigger context injection
 */
export const INJECTION_TRIGGERS: Record<
  string,
  'always' | 'suggest_related' | 'inject_relevant' | 'show_prior_decisions'
> = {
  // Query-based: User is searching/asking
  query_org_memory: 'always',
  get_initiative_pulse: 'always',

  // Creation: User is making something new
  create_entity: 'suggest_related',
  spawn_agent_task: 'inject_relevant',

  // Decision: User is choosing
  approve_decision: 'show_prior_decisions',
  reject_decision: 'show_prior_decisions',

  // Planning: User is planning
  start_plan_session: 'inject_relevant',
  improve_plan: 'always',
};

/**
 * Infer domain from tool ID
 */
export function inferDomainFromTool(toolId: string): Domain | null {
  const toolDomains: Record<string, Domain> = {
    // Product tools
    create_entity: 'product', // Default, will be overridden by args
    get_initiative_pulse: 'product',

    // Decision tools
    approve_decision: 'general',
    reject_decision: 'general',
    get_pending_decisions: 'general',

    // Agent tools
    spawn_agent_task: 'general',
    get_agent_status: 'engineering',

    // Planning tools
    start_plan_session: 'engineering',
    improve_plan: 'engineering',
  };

  return toolDomains[toolId] || null;
}

/**
 * Build enriched result with related context
 */
export function enrichResultWithContext(
  result: ToolResult,
  relatedContext: RelatedContext | null,
  baseUrl = 'https://useorgx.com'
): ToolResult {
  if (!relatedContext || relatedContext.artifacts.length === 0) {
    return result;
  }

  // Add _relatedContext
  result._relatedContext = {
    message: `Found ${relatedContext.artifacts.length} related item${
      relatedContext.artifacts.length === 1 ? '' : 's'
    } from your previous work.`,
    items: relatedContext.artifacts.slice(0, 5).map((a) => ({
      title: a.title,
      domain: a.domain,
      preview: a.summary?.slice(0, 200) || '',
      link: `${baseUrl}/artifacts/${a.id}`,
    })),
  };

  // Add _workspaceInfluence if we used memories
  if (
    relatedContext.memories.length > 0 ||
    relatedContext.decisions.length > 0
  ) {
    const sources: Array<{
      type: 'artifact' | 'decision' | 'initiative';
      id: string;
      title: string;
      domain: string;
      createdAt: string;
      relevanceScore: number;
    }> = [];

    // Add decisions
    for (const d of relatedContext.decisions.slice(0, 3)) {
      sources.push({
        type: 'decision',
        id: d.id,
        title: d.title,
        domain: 'general',
        createdAt: d.createdAt,
        relevanceScore: 0.8,
      });
    }

    // Add top artifacts
    for (const a of relatedContext.artifacts.slice(0, 3)) {
      sources.push({
        type: 'artifact',
        id: a.id,
        title: a.title,
        domain: a.domain,
        createdAt: a.createdAt,
        relevanceScore: a.relevanceScore,
      });
    }

    result._workspaceInfluence = {
      sourcedFrom: sources,
      message: `This response was informed by ${sources.length} prior item${
        sources.length === 1 ? '' : 's'
      } from your workspace.`,
    };
  }

  return result;
}

// =============================================================================
// CONSOLIDATE SESSION TOOL
// =============================================================================

export const consolidateSessionSchema = {
  title: z.string().min(1).describe('Initiative title'),
  include_artifacts: z
    .boolean()
    .optional()
    .describe('Include artifacts from this session'),
  create_milestones: z
    .boolean()
    .optional()
    .describe('Auto-generate milestones from discussion'),
  create_tasks: z.boolean().optional().describe('Extract tasks mentioned'),
  session_id: z
    .string()
    .optional()
    .describe('MCP session ID (auto-detected if not provided)'),
};

export interface ConsolidationResult {
  initiative: {
    id: string;
    title: string;
    summary: string;
  };
  artifactsLinked: number;
  milestonesCreated: number;
  tasksCreated: number;
  link: string;
}

// =============================================================================
// CONTENT HASH
// =============================================================================

/**
 * Generate a simple hash for content deduplication
 * Uses a basic string hash - in production would use SHA256
 */
export function generateContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// =============================================================================
// API PAYLOADS
// =============================================================================

/**
 * Build payload for creating an agent run with cross-pollination metadata
 */
export function buildAgentRunPayload(params: {
  userId: string;
  title: string;
  projectId?: string;
  initiativeId?: string;
  commandCenterId?: string;
  sourceClient: SourceClient;
  mcpSessionId?: string;
  autoCaptured?: boolean;
  conversationContext?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    requester_id: params.userId,
    title: params.title,
    project_id: params.projectId,
    initiative_id: params.initiativeId,
    command_center_id: params.commandCenterId,
    metadata: {
      sourceClient: params.sourceClient,
      mcpSessionId: params.mcpSessionId ?? null,
      autoCaptured: params.autoCaptured ?? false,
      conversationContext: params.conversationContext ?? {},
      origin: 'cross_pollination',
    },
    status: 'completed', // Auto-captured runs are immediately complete
  };
}

/**
 * Build payload for creating an artifact with classification
 */
export function buildArtifactPayload(params: {
  runId: string;
  title: string;
  summary?: string;
  content?: string;
  type: string;
  classification: ArtifactClassification;
}): Record<string, unknown> {
  return {
    run_id: params.runId,
    title: params.title,
    summary: params.summary,
    content: params.content,
    type: params.type,
    primary_domain: params.classification.primaryDomain,
    secondary_domains: params.classification.secondaryDomains,
    artifact_category: params.classification.artifactCategory,
    keywords: params.classification.keywords,
    auto_classified: true,
    content_hash: params.content ? generateContentHash(params.content) : null,
  };
}
