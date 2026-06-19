import { McpAgent } from 'agents/mcp';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

import OAuthProvider from '@cloudflare/workers-oauth-provider';

// Keep OAuthState DO export for wrangler migration compatibility
import { OAuthState, type OAuthEnv } from './oauth';

// Auth handler for OAuthProvider's defaultHandler
import { authHandler } from './authHandler';

// Per-run, user-scoped bearer verification (detached agent runtimes)
import {
  isRunMcpToken,
  runMcpTokenSecret,
  verifyRunMcpToken,
} from './runMcpToken';

// Import extracted modules for DRY code
import {
  buildAuthRequiredResponse,
  toolError as authToolError,
  type SecurityScheme,
} from './authHelpers';
import { buildEntityLink, entityLinkMarkdown, buildLiveUrl } from './deepLinks';
import { formatInitiativeMarkdown, type OrgXInitiative } from './formatters';
import { formatForLLM } from './responseSummarizer';
import { resolveProfileToolSet } from './toolProfiles';
import { withCorsAndHeaders, withSseKeepAlive } from './mcpTransport';
import { withSecurityHeaders } from './securityHeaders';
import { callOrgxApiJson, callOrgxApiRaw, OrgXApiError } from './orgxApi';
import {
  batchCreateEntities as runBatchCreateEntities,
  validateEntityCreatePayloadContract,
} from './batchCreate';
import {
  buildFailureDetails,
  buildJsonFirstContentBlocks,
  diagnoseToolFailure,
  normalizeEntityCreatePayloadForAgents,
  normalizeRecordOutcomeArgs,
  normalizeRecordQualityScoreArgs,
} from './agentErgonomics';
import { evaluateLoopReliabilityReceipt } from './loopReliabilityValidation';
import { buildBillingSettingsUrl, buildPricingUrl } from './shared/billingLinks';
import {
  buildRouteTaskEstimateSummary,
  formatRouteTaskEstimateSummary,
} from './routeTaskEstimate';
import {
  buildSpawnBudgetPreflightArgs,
  buildSpawnGateArgs,
  evaluateSpawnBudgetPreflightResult,
  evaluateSpawnGateResult,
  type SpawnBudgetPreflight,
  type SpawnBudgetPreflightEvaluation,
} from './spawnBudgetPreflight';
import {
  captureWorkerPosthogEvent,
  resolveAnonymousDistinctId,
} from './posthogTelemetry';
import {
  isZodFlavoredErrorMessage,
  extractZodErrorPath,
  classifyErrorKind,
} from './zodErrorMatcher';
import {
  buildAgentCreditCheckoutResult,
  buildAccountStatusResult,
  buildAccountUsageReportResult,
  buildEnterpriseUpgradeResult,
  getAgentCreditPacks,
  resolveCheckoutUrl,
} from './accountTools';
import {
  autonomousSessionInputShape,
  normalizeAutonomousSessionArgs,
} from './autonomousSessionBudget';
import {
  buildScaffoldHierarchy,
  buildScaffoldInitiativeBatch,
} from './scaffoldInitiative';
import {
  buildCompactScaffoldResult,
  buildScaffoldDraftResult,
} from './scaffoldResponse';
import {
  buildFirstAgentWorkState,
  deriveScaffoldIdempotencyKey,
  normalizeExternalSyncRequest,
  normalizeScaffoldObjectiveAliases,
  resolveScaffoldMode,
  resolveScaffoldResponseMode,
  type ExternalSyncRequest,
  type ScaffoldContractWarning,
} from './scaffoldControl';
import {
  buildQueuedScaffoldFollowups,
  runScaffoldPostCreateFollowups,
} from './scaffoldFollowups';
import {
  createScaffoldTelemetryTrace,
  recordDurableMcpToolInvocation,
} from './mcpInvocationTelemetry';
import { extractRunCostTelemetry } from './runCostTelemetry';
import { detectProviderPinning } from './providerPinning';
import { validateSpawnContract } from './spawnContract';
import { validateWriteCreateContract } from './writeContract';
import { buildLiveFeedWidget } from './liveFeedWidget';
import { signStreamToken } from './streamToken';
import { hydrateTaskContext } from './taskContextHydrator';
import { buildWorkspaceCreateBody } from './workspaceTool';
import {
  CONFIGURE_ORG_POLICY_TYPES,
  describeAppliedPolicy,
  resolveConfigureOrgWorkspaceId,
} from './configureOrgPolicy';
import {
  BOOTSTRAP_RECOMMENDED_WORKFLOWS,
  getBootstrapSafeFirstCalls,
  resolveBootstrapSessionContext,
} from './bootstrapPayload';
import {
  buildClientSkillOnboarding,
  formatClientSkillOnboarding,
  resolveSourceClientFromContext,
} from './clientSkillOnboarding';
import {
  buildClientActivationExperience,
  formatClientActivationExperience,
} from './clientActivationExperience';
import { buildSkillCatalogView } from './skillCatalogView';
import {
  INJECTION_TRIGGERS,
  enrichResultWithContext,
  inferDomainFromTool,
  type SourceClient,
  type RelatedContext,
} from './cross-pollination';
import {
  applyMcpActivationObservation,
  createEmptyMcpActivationState,
  MCP_ACTIVATION_STORAGE_KEY,
  parseStoredMcpActivationState,
  type McpActivationTelemetryEvent,
  type McpActivationState,
} from './mcpActivationTracker';
import {
  compatibilityAliasDescription,
  preferredToolCallout,
} from './preferredToolGuidance';
import {
  buildMorningBriefValueDashboard,
  formatMorningBriefSummary,
} from './morningBriefValue';
import {
  buildOperatorChroniclePath,
  formatOperatorChronicleBrief,
} from './operatorChronicleFallback';
import {
  entityMatchesIdempotencyKey,
  readEntityIdempotencyKey,
} from './idempotentReplay';
import {
  buildOrgxFreeAudit,
  formatOrgxFreeAuditSummary,
  type OrgxFreeAuditPeriod,
} from './freeAudit';
import { buildInitiativeListWidgetPayload } from './initiativeWidgetPayload';
import { normalizeAgentDispatchPayload } from './agentDispatchPayload';
import { normalizeAgentStatusPayload } from './agentStatusPayload';
import {
  enrichAgentStatusWithArtifacts,
  enrichInitiativePulseWithArtifacts,
  enrichMorningBriefWithArtifacts,
} from './widgetArtifactProof';
import {
  buildWelcomeBackNextActions,
  createEmptyMcpSessionReentryState,
  formatWelcomeBackDigest,
  MCP_SESSION_REENTRY_STORAGE_KEY,
  parseStoredMcpSessionReentryState,
  recordSuccessfulSessionTool,
  recordWelcomeBackShown,
  shouldShowWelcomeBack,
  type McpSessionReentryState,
} from './welcomeBackContext';
import {
  buildNewSessionWelcomeStorageKey,
  buildNewSessionWelcomeText,
  NEW_SESSION_WELCOME_STORAGE_TTL_SECONDS,
} from './sessionMessaging';
import {
  WIDGET_URIS,
  OUTPUT_TEMPLATE_URIS,
  WIDGET_RESOURCES,
  SCAFFOLD_INITIATIVE_WIDGET_META,
  OAUTH_SCOPES_SUPPORTED,
  SECURITY_SCHEMES,
  PLAN_SESSION_TOOLS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_CONTEXT_SCHEMA,
  STANDARD_TOOL_OUTPUT_SCHEMA,
  ensureStructuredContent,
  STREAM_TOOL_DEFINITIONS,
  ENTITY_TYPES,
  entityTypeEnum,
  LIFECYCLE_ENTITY_TYPES,
  lifecycleEntityTypeEnum,
  resolveLifecycleActionAlias,
  summarizeChatGPTToolResult,
  summarizePlanSessionResult,
  summarizeStreamToolResult,
  expandConsolidatedTool,
} from './toolDefinitions';
import { VERIFIABLE_COMPLETION_ENTITY_TYPES } from './shared/entity';
import { FLYWHEEL_TOOL_DEFINITIONS } from './flywheelTools';
import {
  buildMcpAppsMeta,
  MCP_APPS_SHARED_COMPONENT_PATHS,
  buildWidgetMeta,
  parseWidgetResourceUri,
  rewriteWidgetHtmlAssetUrls,
  sanitizeMcpAppsHtml,
  resolveWidgetBaseUrl,
  SKYBRIDGE_MIME_TYPE,
  toSkybridgeResourceUri,
  toVersionTolerantWidgetResourceUri,
  toWidgetHtmlResourceUri,
} from './widgetConfig';
import { checkEdgeRateLimit } from './edgeRateLimit';
import { DEFAULT_SKILL_CATALOG } from './skillCatalog';
import {
  SKILL_PROMPT_TEMPLATE_SAFETY_DESCRIPTION,
  validateSkillPromptTemplate,
} from './promptTemplatePolicy';
import { buildEntityActionAttachPayload } from './entityActionAttach';
import { buildEntityActionShipBatchPayload } from './entityActionShipBatch';
import { buildSmitheryConfigSchema } from './smitheryConfig';
import {
  applyHydrationAccessTier,
  resolveHydrationAccessContext,
  resolveHydrationMaxChars,
} from './contextAccessTier';
import { buildRateLimitedResponse } from './rateLimitResponse';
import {
  parseStoredSessionAuth,
  parseStoredSessionContext,
  SESSION_AUTH_STORAGE_KEY,
  SESSION_CONTEXT_STORAGE_KEY,
  toStoredSessionAuth,
  toStoredSessionContext,
} from './sessionStorage';
import { checkToolPlanAccess } from './toolAccessGating';
import {
  CONTRACT_TOOL_DEFINITIONS,
  V2_ORGX_TOOL_ID_SET,
  getKnownToolContract,
  getKnownToolContracts,
} from './contractTools';
import { describeInputShape } from './schemaIntrospection';
import {
  PLAN_SESSION_ACCEPTED_ID_FORMS,
  enrichPlanSessionResult,
  normalizePlanSessionId,
} from './planSessionContract';

// Re-export OAuthState Durable Object
export { OAuthState };

// Re-export ScaffoldSessionDO so wrangler can bind it as a Durable Object class
export { ScaffoldSessionDO } from './scaffoldSessionDO';
// Re-export LiveFeedDO so wrangler can bind it as a Durable Object class
export { LiveFeedDO } from './liveFeedDO';

// Export configSchema directly from the entry file so Smithery's source scanner
// can detect session configuration without following a re-export.
export const configSchema = buildSmitheryConfigSchema();

/**
 * Compute MCP server version from tool catalog.
 * Uses a simple hash since Cloudflare Workers lack Node crypto.
 */
function computeServerVersion(): string {
  const toolNames = [
    ...CHATGPT_TOOL_DEFINITIONS,
    ...PLAN_SESSION_TOOLS,
    ...CLIENT_INTEGRATION_TOOL_DEFINITIONS,
    ...STREAM_TOOL_DEFINITIONS,
    ...CONTRACT_TOOL_DEFINITIONS,
    ...FLYWHEEL_TOOL_DEFINITIONS,
  ]
    .map((t) => t.id)
    .sort()
    .join('|');
  // Simple djb2 hash for deterministic version suffix
  let hash = 5381;
  for (let i = 0; i < toolNames.length; i++) {
    hash = ((hash << 5) + hash + toolNames.charCodeAt(i)) >>> 0;
  }
  const suffix = hash.toString(16).slice(0, 8);
  return `0.3.0-${suffix}`;
}

const MCP_SERVER_VERSION = computeServerVersion();

interface Env extends OAuthEnv {
  ORGX_API_URL: string;
  ORGX_SERVICE_KEY: string;
  MCP_JWT_SECRET: string;
  MCP_SERVER_URL: string;
  AUTH_SERVER_URL: string;
  ASSETS?: Fetcher;
  ORGX_WEB_URL: string;
  // PostHog telemetry (optional). In production, set via `wrangler secret put`.
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  OAUTH_STATE: DurableObjectNamespace;
  // OAuth provider KV storage for tokens, grants, and client registrations
  OAUTH_KV: KVNamespace;
  // Cookie encryption key for OAuth provider auth state cookies
  COOKIE_ENCRYPTION_KEY: string;
  // OAuth provider helpers (injected by OAuthProvider at runtime)
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  // Development mode: set this to auto-inject a user ID for local testing
  // This allows write tools like spawn_agent_task to work without OAuth
  DEV_USER_ID?: string;
  // MCP Registry authentication - Ed25519 public key for domain verification
  // Set this to enable publishing to the official MCP Registry
  // Format: base64-encoded 32-byte Ed25519 public key
  MCP_REGISTRY_PUBKEY?: string;
  // Optional Upstash Redis REST credentials for distributed edge rate limiting
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Server-to-server shared secret for internal endpoints (e.g. /session-tokens)
  ORGX_INTERNAL_SECRET?: string;
  // Optional dedicated secret for per-run MCP bearer tokens (falls back to ORGX_SERVICE_KEY)
  ORGX_RUN_MCP_TOKEN_SECRET?: string;
  // Scaffold streaming: Durable Object namespace for per-session SSE fan-out
  SCAFFOLD_SESSION: DurableObjectNamespace;
  // Live feed: Durable Object namespace for polling SSE (agent-status, initiative-pulse)
  LIVE_FEED: DurableObjectNamespace;
}

// =============================================================================
// CHATGPT APP TOOLS CONFIGURATION
//
// Tool definitions are now imported from ./toolDefinitions.ts
// This keeps the worker slim while maintaining sync with the main configs.
// =============================================================================

interface OrgXMcpProps extends Record<string, unknown> {
  userId?: string;
  scope?: string;
  email?: string;
  profile?: string;
  workspace_id?: string;
  initiative_id?: string;
}

type WidgetDebugEventPhase =
  | 'tool_call'
  | 'tool_result'
  | 'resource_read_start'
  | 'resource_read_complete'
  | 'resource_read_error';

interface WidgetDebugEvent {
  timestamp: string;
  phase: WidgetDebugEventPhase;
  toolId?: string;
  resourceUri?: string;
  mimeType?: string;
  outputTemplate?: string;
  details?: Record<string, unknown>;
}

export class OrgXMcp extends McpAgent<
  Env,
  Record<string, never>,
  OrgXMcpProps
> {
  // Initial McpServer — recreated in init() on each DO wake cycle
  // because MCP SDK 1.26+ prevents reconnecting an already-connected instance.
  server = new McpServer({
    name: 'orgx-mcp',
    title: 'OrgX MCP',
    version: MCP_SERVER_VERSION,
    websiteUrl: 'https://useorgx.com',
    icons: [
      {
        src: 'https://mcp.useorgx.com/orgx-logo.png',
        mimeType: 'image/png',
        sizes: ['64x64', '128x128', 'any'],
      },
    ],
  });

  // SQLite storage for persistent session auth (survives DO resets/deployments)
  // Note: Named sessionSql to avoid shadowing the base class's sql() tagged template method
  private sessionSql!: SqlStorage;
  private sessionSqlInitialized = false;

  // Session context for workspace scoping
  sessionContext: {
    workspaceId?: string;
    workspaceName?: string;
    initiativeId?: string;
  } = {};

  // Persisted auth from OAuth flow - stored in DO SQLite
  // This ensures authenticated users stay authenticated across DO resets
  sessionAuth: {
    userId?: string;
    scope?: string;
    email?: string;
    authenticatedAt?: number;
  } = {};

  // Session-scoped activation funnel state for MCP onboarding telemetry.
  private mcpActivationState: McpActivationState =
    createEmptyMcpActivationState();
  private mcpSessionReentryState: McpSessionReentryState =
    createEmptyMcpSessionReentryState();

  // Set to true when a user authenticates for the first time in this session.
  // Used to prepend a welcome message to the first tool call response.
  private _isNewSession = false;

  // Guard against concurrent init() calls.
  // When two requests arrive simultaneously, both may call init() before
  // the first completes. Without this guard, the second call would try to
  // registerTools() on a server that already has them, causing
  // "Tool X is already registered" errors from the MCP SDK.
  private _initPromise: Promise<void> | null = null;

  // In-memory rolling widget diagnostics for the current DO instance.
  private widgetDebugEvents: WidgetDebugEvent[] = [];
  private readonly maxWidgetDebugEvents = 300;

  private appendWidgetDebugEvent(
    event: Omit<WidgetDebugEvent, 'timestamp'>
  ): void {
    const entry: WidgetDebugEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.widgetDebugEvents.push(entry);
    if (this.widgetDebugEvents.length > this.maxWidgetDebugEvents) {
      this.widgetDebugEvents.splice(
        0,
        this.widgetDebugEvents.length - this.maxWidgetDebugEvents
      );
    }
    console.info('[mcp:widget-debug]', entry);
  }

  private getWidgetDebugEvents(limit = 50): WidgetDebugEvent[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(200, Math.max(1, Math.floor(limit)))
      : 50;
    return this.widgetDebugEvents.slice(-normalizedLimit).reverse();
  }

  /**
   * Initialize SQLite storage for session persistence.
   * This is called lazily on first use to avoid issues with DO initialization.
   */
  private initSessionSql() {
    if (this.sessionSqlInitialized) return;
    try {
      // Check if SQLite storage is available on this Durable Object
      // It may not be available if the DO wasn't created with sqlite_classes migration
      const sqlStorage = this.ctx?.storage?.sql;
      if (!sqlStorage || typeof sqlStorage.exec !== 'function') {
        console.warn('[mcp:session] SQLite storage not available on this DO');
        return;
      }
      this.sessionSql = sqlStorage;
      this.sessionSql.exec(`
        CREATE TABLE IF NOT EXISTS session_auth (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          user_id TEXT NOT NULL,
          scope TEXT,
          email TEXT,
          authenticated_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Persist non-auth session context (workspace + initiative scoping).
      // This improves "context survival" across DO resets/deployments.
      this.sessionSql.exec(`
        CREATE TABLE IF NOT EXISTS session_context (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          workspace_id TEXT,
          workspace_name TEXT,
          initiative_id TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
      this.sessionSqlInitialized = true;
    } catch (error) {
      console.error('[mcp:session] Failed to initialize SQLite', { error });
    }
  }

  /**
   * Load session auth from SQLite storage.
   * Called on init to restore auth after DO resets.
   */
  private async loadSessionAuth() {
    try {
      this.initSessionSql();
      if (this.sessionSqlInitialized) {
        const result = this.sessionSql.exec(
          `SELECT * FROM session_auth WHERE id = 1`
        );
        const rows = [...result];
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          this.sessionAuth = {
            userId: row.user_id as string,
            scope: row.scope as string | undefined,
            email: row.email as string | undefined,
            authenticatedAt: row.authenticated_at as number,
          };
          console.info('[mcp:session] Restored session auth from SQLite', {
            userId: this.sessionAuth.userId,
            authenticatedAt: this.sessionAuth.authenticatedAt,
          });

          // Mirror to DO storage so future loads work even if SQLite is unavailable.
          try {
            const now = Date.now();
            await this.ctx.storage.put(
              SESSION_AUTH_STORAGE_KEY,
              toStoredSessionAuth(
                {
                  userId: this.sessionAuth.userId!,
                  scope: this.sessionAuth.scope,
                  email: this.sessionAuth.email,
                  authenticatedAt: this.sessionAuth.authenticatedAt,
                },
                now
              )
            );
          } catch (mirrorError) {
            console.warn('[mcp:session] Failed to mirror auth to DO storage', {
              error:
                mirrorError instanceof Error
                  ? mirrorError.message
                  : String(mirrorError),
            });
          }
          return;
        }
      }

      // Fallback: Durable Object key-value storage (always available).
      const stored = await this.ctx.storage.get<Record<string, unknown>>(
        SESSION_AUTH_STORAGE_KEY
      );

      const parsed = parseStoredSessionAuth(stored);
      if (!parsed) return;

      this.sessionAuth = parsed;
      console.info('[mcp:session] Restored session auth from DO storage', {
        userId: this.sessionAuth.userId,
        authenticatedAt: this.sessionAuth.authenticatedAt ?? null,
      });
    } catch (error) {
      console.warn('[mcp:session] Failed to load session auth', { error });
    }
  }

  /**
   * Save session auth to SQLite storage.
   * Called when user authenticates to persist across DO resets.
   */
  private async saveSessionAuth() {
    try {
      this.initSessionSql();
      if (!this.sessionAuth.userId) return;

      const now = Date.now();

      // Always persist to DO storage (survives deploys/resets even without SQLite).
      await this.ctx.storage.put(
        SESSION_AUTH_STORAGE_KEY,
        toStoredSessionAuth(
          {
            userId: this.sessionAuth.userId,
            scope: this.sessionAuth.scope,
            email: this.sessionAuth.email,
            authenticatedAt: this.sessionAuth.authenticatedAt,
          },
          now
        )
      );

      if (this.sessionSqlInitialized) {
        this.sessionSql.exec(
          `INSERT OR REPLACE INTO session_auth (id, user_id, scope, email, authenticated_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
          this.sessionAuth.userId,
          this.sessionAuth.scope ?? null,
          this.sessionAuth.email ?? null,
          this.sessionAuth.authenticatedAt ?? now,
          now
        );
      }

      console.info('[mcp:session] Saved session auth to durable storage', {
        userId: this.sessionAuth.userId,
        sqlite: this.sessionSqlInitialized,
      });
    } catch (error) {
      console.warn('[mcp:session] Failed to save session auth', { error });
    }
  }

  /**
   * Load session context (workspace/initiative scoping) from SQLite storage.
   * Keeps "current workspace" and last initiative alive across DO resets.
   */
  private async loadSessionContext() {
    try {
      this.initSessionSql();
      if (this.sessionSqlInitialized) {
        const result = this.sessionSql.exec(
          `SELECT * FROM session_context WHERE id = 1`
        );
        const rows = [...result];
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          const workspaceId =
            typeof row.workspace_id === 'string' ? row.workspace_id : undefined;
          const workspaceName =
            typeof row.workspace_name === 'string'
              ? row.workspace_name
              : undefined;
          const initiativeId =
            typeof row.initiative_id === 'string' ? row.initiative_id : undefined;

          this.sessionContext = {
            ...this.sessionContext,
            workspaceId: workspaceId ?? this.sessionContext.workspaceId,
            workspaceName: workspaceName ?? this.sessionContext.workspaceName,
            initiativeId: initiativeId ?? this.sessionContext.initiativeId,
          };

          console.info('[mcp:session] Restored session context from SQLite', {
            workspaceId: this.sessionContext.workspaceId ?? null,
            initiativeId: this.sessionContext.initiativeId ?? null,
          });

          // Mirror to DO storage.
          try {
            const now = Date.now();
            await this.ctx.storage.put(
              SESSION_CONTEXT_STORAGE_KEY,
              toStoredSessionContext(this.sessionContext, now)
            );
          } catch (mirrorError) {
            console.warn(
              '[mcp:session] Failed to mirror context to DO storage',
              {
                error:
                  mirrorError instanceof Error
                    ? mirrorError.message
                    : String(mirrorError),
              }
            );
          }
          return;
        }
      }

      // Fallback: Durable Object key-value storage.
      const stored = await this.ctx.storage.get<Record<string, unknown>>(
        SESSION_CONTEXT_STORAGE_KEY
      );
      const parsed = parseStoredSessionContext(stored);
      if (!parsed) return;

      this.sessionContext = { ...this.sessionContext, ...parsed };

      console.info('[mcp:session] Restored session context from DO storage', {
        workspaceId: this.sessionContext.workspaceId ?? null,
        initiativeId: this.sessionContext.initiativeId ?? null,
      });
    } catch (error) {
      console.warn('[mcp:session] Failed to load session context', { error });
    }
  }

  /**
   * Save session context (workspace/initiative scoping) to SQLite storage.
   * Called when the session context changes.
   */
  private async saveSessionContext() {
    try {
      this.initSessionSql();
      const now = Date.now();
      await this.ctx.storage.put(
        SESSION_CONTEXT_STORAGE_KEY,
        toStoredSessionContext(this.sessionContext, now)
      );

      if (this.sessionSqlInitialized) {
        this.sessionSql.exec(
          `INSERT OR REPLACE INTO session_context (id, workspace_id, workspace_name, initiative_id, updated_at)
           VALUES (1, ?, ?, ?, ?)`,
          this.sessionContext.workspaceId ?? null,
          this.sessionContext.workspaceName ?? null,
          this.sessionContext.initiativeId ?? null,
          now
        );
      }
    } catch (error) {
      console.warn('[mcp:session] Failed to save session context', { error });
    }
  }

  private async loadMcpActivationState() {
    try {
      const stored = await this.ctx.storage.get<Record<string, unknown>>(
        MCP_ACTIVATION_STORAGE_KEY
      );
      const parsed = parseStoredMcpActivationState(stored);
      if (!parsed) return;
      this.mcpActivationState = parsed;
    } catch (error) {
      console.warn('[mcp:activation] Failed to load activation state', {
        error,
      });
    }
  }

  private async saveMcpActivationState() {
    try {
      await this.ctx.storage.put(
        MCP_ACTIVATION_STORAGE_KEY,
        this.mcpActivationState
      );
    } catch (error) {
      console.warn('[mcp:activation] Failed to save activation state', {
        error,
      });
    }
  }

  private async loadMcpSessionReentryState() {
    try {
      const stored = await this.ctx.storage.get<Record<string, unknown>>(
        MCP_SESSION_REENTRY_STORAGE_KEY
      );
      const parsed = parseStoredMcpSessionReentryState(stored);
      if (!parsed) return;
      this.mcpSessionReentryState = parsed;
    } catch (error) {
      console.warn('[mcp:session] Failed to load reentry state', { error });
    }
  }

  private async saveMcpSessionReentryState() {
    try {
      await this.ctx.storage.put(
        MCP_SESSION_REENTRY_STORAGE_KEY,
        this.mcpSessionReentryState
      );
    } catch (error) {
      console.warn('[mcp:session] Failed to save reentry state', { error });
    }
  }

  private async shouldShowNewSessionWelcome(userId: string): Promise<boolean> {
    const key = buildNewSessionWelcomeStorageKey(userId);
    if (!key) return false;

    try {
      const existing = await this.env.OAUTH_KV.get(key);
      if (existing) {
        console.info('[mcp:session] Suppressed first-run welcome', {
          userId,
        });
        return false;
      }

      await this.env.OAUTH_KV.put(
        key,
        JSON.stringify({
          user_id: userId,
          first_seen_at: new Date().toISOString(),
          version: 1,
        }),
        { expirationTtl: NEW_SESSION_WELCOME_STORAGE_TTL_SECONDS }
      );

      console.info('[mcp:session] First-run welcome marked shown', {
        userId,
      });
      return true;
    } catch (error) {
      console.warn('[mcp:session] Failed to check first-run welcome state', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async init() {
    // Deduplicate concurrent init() calls. When two requests arrive
    // simultaneously (e.g. onStart + handleMcpMessage), both call init().
    // Without this guard, both would register tools on the same McpServer
    // instance, triggering "Tool X is already registered" from the MCP SDK.
    if (this._initPromise) {
      return this._initPromise;
    }
    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _doInit() {
    // Recreate the McpServer on each DO wake cycle.
    // The MCP SDK 1.26+ guard prevents connecting an already-connected server
    // instance, so we must create a fresh one before onStart() calls connect().
    this.server = new McpServer({
      name: 'orgx-mcp',
      title: 'OrgX MCP',
      version: MCP_SERVER_VERSION,
      websiteUrl: 'https://useorgx.com',
      icons: [
        {
          src: 'https://mcp.useorgx.com/orgx-logo.png',
          mimeType: 'image/png',
          sizes: ['64x64', '128x128', 'any'],
        },
      ],
    });

    // First, try to restore session auth from persistent storage
    // This handles DO resets after deployments
    await this.loadSessionAuth();
    await this.loadSessionContext();
    await this.loadMcpActivationState();
    await this.loadMcpSessionReentryState();

    // Diagnostic: log what the DO received from the provider
    console.info('[mcp:init] DO initialized', {
      hasProps: !!this.props,
      propsUserId: this.props?.userId ?? null,
      propsScope: this.props?.scope ?? null,
      propsWorkspaceId: this.props?.workspace_id ?? null,
      propsInitiativeId: this.props?.initiative_id ?? null,
      sessionUserId: this.sessionAuth.userId ?? null,
    });

    const propsWorkspaceId =
      typeof this.props?.workspace_id === 'string'
        ? this.props.workspace_id
        : undefined;
    const propsInitiativeId =
      typeof this.props?.initiative_id === 'string'
        ? this.props.initiative_id
        : undefined;

    if (propsWorkspaceId && propsWorkspaceId !== this.sessionContext.workspaceId) {
      this.sessionContext = {
        ...this.sessionContext,
        workspaceId: propsWorkspaceId,
      };
      await this.saveSessionContext();
    }

    if (
      propsInitiativeId &&
      propsInitiativeId !== this.sessionContext.initiativeId
    ) {
      this.sessionContext = {
        ...this.sessionContext,
        initiativeId: propsInitiativeId,
      };
      await this.saveSessionContext();
    }

    // Then, update from props if user authenticated with a new token
    if (this.props?.userId) {
      const isNewAuth = this.props.userId !== this.sessionAuth.userId;
      if (isNewAuth || !this.sessionAuth.userId) {
        this._isNewSession = await this.shouldShowNewSessionWelcome(
          this.props.userId
        );
        this.sessionAuth = {
          userId: this.props.userId,
          scope: this.props.scope,
          email: this.props.email ?? this.sessionAuth.email, // prefer props email, preserve existing
          authenticatedAt: Date.now(),
        };
        await this.saveSessionAuth();
        console.info('[mcp:session] User authenticated, stored in session', {
          userId: this.props.userId,
          scope: this.props.scope,
        });
      }
    }

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  /**
   * Optional Cloudflare Durable Object RPC hook.
   *
   * Some clients/frameworks call `stub.destroy()` as a best-effort teardown signal.
   * If unimplemented, Cloudflare logs an exception with trigger `default.destroy`.
   *
   * We treat this as a no-op cleanup and never throw.
   */
  async destroy(): Promise<void> {
    try {
      this.sessionContext = {};
      this.sessionAuth = {};
      this.widgetDebugEvents = [];
      // Intentionally do not clear persisted session_auth/session_context here.
      // destroy() can be triggered during transport teardown and deploy cycles;
      // deleting persisted state forces unnecessary re-authentication.
    } catch (error) {
      console.warn('[mcp:session] destroy cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

  }

  /**
   * Resolve userId with priority:
   * 1. Explicit argument
   * 2. Current request props (per-request auth token)
   * 3. Persisted session auth (from initial OAuth)
   * 4. null (will fall back to service user in requestAuth.ts)
   */
  private resolveUserId(explicit?: string | null) {
    return explicit ?? this.props?.userId ?? this.sessionAuth.userId ?? null;
  }

  private resolveUserEmail() {
    return this.props?.email ?? this.sessionAuth.email ?? null;
  }

  private assertUserId(explicit?: string | null) {
    const userId = this.resolveUserId(explicit);
    if (!userId) {
      throw new Error('owner_id or user_id is required for this tool');
    }
    return userId;
  }

  private toolError(
    message: string,
    options: {
      code?: string;
      status?: number;
      details?: Record<string, unknown>;
    } = {}
  ): CallToolResult {
    return authToolError(message, options);
  }

  private parseGrantedScopes(): string[] {
    const rawScope = this.props?.scope ?? this.sessionAuth.scope ?? '';
    return rawScope
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  private widgetToolError(
    toolId: string,
    message: string,
    outputTemplate?: string,
    details: Record<string, unknown> = {}
  ): CallToolResult {
    const payload = {
      ...details,
      ok: false,
      tool_id: toolId,
      error: message,
      error_type: 'tool_execution_failed',
    };

    this.appendWidgetDebugEvent({
      phase: 'tool_result',
      toolId,
      outputTemplate,
      details: {
        widgetError: true,
        message,
        payloadKeys: Object.keys(payload),
      },
    });

    return {
      content: [
        { type: 'text', text: message },
      ],
      structuredContent: payload,
    };
  }

  private resolveAnonymousDistinctId(): string {
    return resolveAnonymousDistinctId(this.ctx);
  }

  private capturePosthogEvent(
    event: string,
    {
      distinctId,
      properties,
    }: { distinctId: string; properties?: Record<string, unknown> }
  ): void {
    captureWorkerPosthogEvent({
      env: this.env,
      ctx: this.ctx as any,
      event,
      distinctId,
      properties,
      serverVersion: MCP_SERVER_VERSION,
    });
  }

  private captureMcpToolEvent(
    event:
      | 'mcp_tool_called'
      | 'mcp_tool_succeeded'
      | 'mcp_tool_failed'
      | 'mcp_tool_invalid_input',
    params: {
      toolId: string;
      toolFamily: 'chatgpt' | 'stream' | 'plan_session' | 'client_integration';
      userId?: string | null;
      authSource?: 'request' | 'session' | 'none';
      ok?: boolean;
      latencyMs?: number;
      error?: string;
      isWidgetTool?: boolean;
      /**
       * Optional structured tag for the error category. When set to
       * 'invalid_input' (or detected automatically from the error
       * message via Zod-pattern matching), an additional
       * `mcp_tool_invalid_input` event fires alongside the primary
       * event so the telemetry dashboard can rank "most common ways
       * agents fail to call X" without substring-matching arbitrary
       * error text.
       */
      errorKind?: string;
      // A6/A7: realized per-run token/cost telemetry, when the tool-execute
      // response carried it (see runCostTelemetry.extractRunCostTelemetry).
      tokensUsed?: number;
      costUsd?: number;
      estimatedCostUsd?: number;
      // A1: provider-pinning verification — whether a requested provider/model
      // was honored end-to-end (see providerPinning.detectProviderPinning).
      providerRequested?: string;
      providerUsed?: string;
      providerMismatch?: boolean;
    }
  ): void {
    const distinctId = params.userId ?? this.resolveAnonymousDistinctId();
    // When the caller didn't tag errorKind explicitly, classify from the
    // error message so the dashboard always has a coarse category to
    // group on. classifyErrorKind returns 'unknown' for failed events
    // it can't pattern-match — better than null because saved queries
    // can `coalesce(error_kind, '<no_kind>')` consistently.
    const resolvedErrorKind =
      params.errorKind ??
      (event === 'mcp_tool_failed'
        ? classifyErrorKind(params.error) ?? undefined
        : undefined);
    this.capturePosthogEvent(event, {
      distinctId,
      properties: {
        tool_id: params.toolId,
        tool_family: params.toolFamily,
        auth_source: params.authSource,
        has_user_id: Boolean(params.userId),
        ok: params.ok,
        latency_ms: params.latencyMs,
        error: params.error,
        error_kind: resolvedErrorKind,
        is_widget_tool: params.isWidgetTool,
        tokens_used: params.tokensUsed,
        cost_usd: params.costUsd,
        estimated_cost_usd: params.estimatedCostUsd,
        provider_requested: params.providerRequested,
        provider_used: params.providerUsed,
        provider_mismatch: params.providerMismatch,
      },
    });

    // Pass 4: input-validation counter. Fires alongside any
    // mcp_tool_failed where the error category is invalid_input —
    // either explicitly tagged by the caller or detected via Zod
    // patterns in the error text. The PRIMARY event is never
    // suppressed; this is purely additive so the dashboard can rank
    // input-shape failures without arbitrary substring matching.
    if (event !== 'mcp_tool_failed') return;
    const isInvalidInput =
      resolvedErrorKind === 'invalid_input' ||
      isZodFlavoredErrorMessage(params.error);
    if (!isInvalidInput) return;
    this.capturePosthogEvent('mcp_tool_invalid_input', {
      distinctId,
      properties: {
        tool_id: params.toolId,
        tool_family: params.toolFamily,
        auth_source: params.authSource,
        has_user_id: Boolean(params.userId),
        error: params.error,
        error_kind: resolvedErrorKind ?? 'invalid_input',
        error_path: extractZodErrorPath(params.error),
        is_widget_tool: params.isWidgetTool,
      },
    });
  }

  private async fetchOrgxJsonOrNull<T extends Record<string, unknown>>(
    path: string,
    userId?: string | null
  ): Promise<T | null> {
    try {
      const response = await callOrgxApiJson(
        this.env,
        path,
        undefined,
        { userId: userId ?? undefined }
      );
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch (error) {
      console.warn('[mcp:orgx] Failed to fetch JSON payload', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async fetchClientBootstrapWorkspace(
    userId?: string | null
  ): Promise<{ id: string; name: string | null } | null> {
    const payload = await this.fetchOrgxJsonOrNull<{
      data?: {
        workspace?: {
          id?: unknown;
          name?: unknown;
        };
      };
    }>('/api/client/bootstrap?source_client=mcp', userId);
    const workspace = payload?.data?.workspace;
    const id = typeof workspace?.id === 'string' ? workspace.id.trim() : '';
    if (!id) return null;
    const name =
      typeof workspace?.name === 'string' && workspace.name.trim()
        ? workspace.name.trim()
        : null;
    return { id, name };
  }

  private async recordMcpActivationObservation(params: {
    toolId: string;
    args?: Record<string, unknown> | null;
    data?: Record<string, unknown> | null;
    userId?: string | null;
    sourceClient?: SourceClient | null;
    workspaceId?: string | null;
    initiativeId?: string | null;
  }): Promise<McpActivationTelemetryEvent[]> {
    try {
      const { state, events } = applyMcpActivationObservation(
        this.mcpActivationState,
        {
          toolId: params.toolId,
          args: params.args ?? undefined,
          data: params.data ?? undefined,
          sourceClient: params.sourceClient ?? undefined,
          workspaceId: params.workspaceId ?? undefined,
          initiativeId: params.initiativeId ?? undefined,
        }
      );

      this.mcpActivationState = state;
      await this.saveMcpActivationState();

      if (events.length === 0) return [];
      const distinctId = params.userId ?? this.resolveAnonymousDistinctId();
      for (const event of events) {
        this.capturePosthogEvent(event.event, {
          distinctId,
          properties: event.properties,
        });
      }
      return events;
    } catch (error) {
      console.warn('[mcp:activation] Failed to record activation event', {
        toolId: params.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async buildWelcomeBackBlock(
    userId?: string | null
  ): Promise<{ type: 'text'; text: string } | null> {
    const lastSeenAt = this.mcpSessionReentryState.last_success_at;
    if (!lastSeenAt) return null;

    const workspaceId = this.sessionContext.workspaceId ?? null;
    const workspaceName = this.sessionContext.workspaceName ?? null;

    let stats = {
      active_initiatives: 0,
      pending_decisions: 0,
      running_agents: 0,
    };
    let recentActivity: Array<{
      title: string;
      timestamp: string;
      actor_name: string | null;
    }> = [];
    let pendingDecisions: Array<{
      title: string;
      waiting_for: string;
      priority: string | null;
    }> = [];

    if (workspaceId) {
      const pulse = await this.fetchOrgxJsonOrNull<{
        stats?: {
          activeInitiatives?: number;
          pendingDecisions?: number;
          runningAgents?: number;
        };
        activity?: Array<{
          title?: string;
          timestamp?: string;
          actor?: { name?: string | null };
        }>;
        decisions?: Array<{
          title?: string;
          waitingFor?: string;
          priority?: string | null;
        }>;
      }>(`/api/v1/workspaces/${workspaceId}/dashboard/pulse`, userId);

      if (pulse) {
        stats = {
          active_initiatives: pulse.stats?.activeInitiatives ?? 0,
          pending_decisions: pulse.stats?.pendingDecisions ?? 0,
          running_agents: pulse.stats?.runningAgents ?? 0,
        };
        recentActivity = Array.isArray(pulse.activity)
          ? pulse.activity
              .filter(
                (item) =>
                  typeof item?.timestamp === 'string' &&
                  item.timestamp > lastSeenAt
              )
              .map((item) => ({
                title:
                  typeof item?.title === 'string'
                    ? item.title
                    : 'Workspace updated',
                timestamp: item.timestamp as string,
                actor_name:
                  typeof item?.actor?.name === 'string'
                    ? item.actor.name
                    : null,
              }))
          : [];
        pendingDecisions = Array.isArray(pulse.decisions)
          ? pulse.decisions.map((item) => ({
              title:
                typeof item?.title === 'string'
                  ? item.title
                  : 'Pending decision',
              waiting_for:
                typeof item?.waitingFor === 'string'
                  ? item.waitingFor
                  : 'for review',
              priority:
                typeof item?.priority === 'string' ? item.priority : null,
            }))
          : [];
      }
    }

    const digest = {
      workspace_id: workspaceId,
      workspace_name: workspaceName,
      last_seen_at: lastSeenAt,
      live_url: workspaceId
        ? buildLiveUrl(undefined, undefined, { workspace: workspaceId })
        : null,
      stats,
      recent_activity: recentActivity,
      pending_decisions: pendingDecisions,
      next_actions: buildWelcomeBackNextActions({
        pendingDecisionCount: pendingDecisions.length,
        recentActivityCount: recentActivity.length,
        hasWorkspace: Boolean(workspaceId),
      }),
    };

    return {
      type: 'text',
      text: formatWelcomeBackDigest(digest),
    };
  }

  private buildClientActivationPayload(params: {
    sourceClient?: SourceClient | null;
    events?: McpActivationTelemetryEvent[];
  }): {
    experience: ReturnType<typeof buildClientActivationExperience>;
    text: string;
  } {
    const experience = buildClientActivationExperience({
      state: this.mcpActivationState,
      sourceClient: params.sourceClient,
      events: params.events,
    });
    return {
      experience,
      text: formatClientActivationExperience(experience),
    };
  }

  private async withOrgx(
    runner: () => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    try {
      const result = await runner();
      const now = new Date().toISOString();
      const shouldShowReentry = shouldShowWelcomeBack({
        state: this.mcpSessionReentryState,
        now,
      });
      let leadingBlock:
        | {
            type: 'text';
            text: string;
          }
        | null = null;

      if (shouldShowReentry) {
        leadingBlock = await this.buildWelcomeBackBlock(this.resolveUserId());
        this.mcpSessionReentryState = recordWelcomeBackShown(
          this.mcpSessionReentryState,
          now
        );
      }

      // On the very first tool call after a new authentication, prepend a
      // welcome message so the user knows what OrgX can do for them.
      if (!leadingBlock && this._isNewSession) {
        leadingBlock = {
          type: 'text' as const,
          text: buildNewSessionWelcomeText(),
        };
      }

      if (this._isNewSession) {
        this._isNewSession = false;
      }

      this.mcpSessionReentryState = recordSuccessfulSessionTool(
        this.mcpSessionReentryState,
        now
      );
      await this.saveMcpSessionReentryState();

      if (leadingBlock) {
        const existingContent = Array.isArray(result.content)
          ? result.content
          : [];
        return { ...result, content: [leadingBlock, ...existingContent] };
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof OrgXApiError) {
        return this.toolError(message, {
          code:
            error.statusCode === 401 || error.statusCode === 403
              ? 'permission_denied'
              : error.statusCode === 404
              ? 'entity_not_found'
              : error.statusCode === 400
              ? 'invalid_input'
              : error.statusCode && error.statusCode >= 500
              ? 'upstream_unavailable'
              : 'tool_execution_failed',
          status: error.statusCode,
          details: {
            retryable: Boolean(error.statusCode && error.statusCode >= 500),
            suggested_next_calls: [{ tool: 'orgx_bootstrap', args: {} }],
          },
        });
      }
      return this.toolError(message);
    }
  }

  /**
   * Route tools to optimal endpoints.
   * Direct endpoints for high-traffic tools, generic executor for others.
   *
   * NOTE: chatgpt.spawn_agent_task ultimately delegates via router.spawnChild which
   * requires a parentRunId. /api/tools/execute will generate a synthetic `api-...`
   * run ID when none is provided so MCP calls can spawn safely.
   */
  private getToolEndpoint(
    toolId: string,
    args: Record<string, unknown>
  ): {
    endpoint: string;
    body: Record<string, unknown>;
  } {
    // Generic tool executor (protocol-agnostic).
    // approve_decision and all other tools route through /api/tools/execute,
    // which handles MCP context, stream continuation, and agent resumption.
    // Use resolved userId (props > session auth)
    return {
      endpoint: '/api/tools/execute',
      body: {
        tool_id: toolId, // No chatgpt. prefix needed
        args,
        user_id: this.props?.userId ?? this.sessionAuth.userId,
      },
    };
  }

  private async runSpawnBudgetPreflight(
    args: Record<string, unknown>,
    userId: string | null
  ): Promise<SpawnBudgetPreflightEvaluation> {
    const routeArgs = buildSpawnBudgetPreflightArgs(args);
    try {
      const response = await callOrgxApiJson(
        this.env,
        '/api/client/route-task',
        {
          method: 'POST',
          body: JSON.stringify({
            ...routeArgs,
            user_id: userId,
          }),
        },
        { userId }
      );
      const result = (await response.json()) as Record<string, unknown>;
      const routeEval = evaluateSpawnBudgetPreflightResult(result, routeArgs);
      if (!routeEval.ok) return routeEval;

      // Per-task ceiling passed. Now enforce WORKSPACE daily/monthly spend caps
      // via /api/client/spawn-gate (policy lives in orgx: enforceBudget). Skip
      // when no workspace is resolvable — caps can't be enforced without one.
      const gateArgs = buildSpawnGateArgs(routeArgs, userId);
      if (gateArgs) {
        const gateResponse = await callOrgxApiJson(
          this.env,
          '/api/client/spawn-gate',
          { method: 'POST', body: JSON.stringify(gateArgs) },
          { userId }
        );
        const gateResult = (await gateResponse.json()) as Record<string, unknown>;
        const gateEval = evaluateSpawnGateResult(gateResult);
        if (!gateEval.ok) return gateEval;
      }

      return routeEval;
    } catch (error) {
      return {
        ok: false,
        message: 'Budget preflight failed before dispatch.',
        details: {
          code: 'budget_preflight_failed',
          route_task: routeArgs,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private getRelatedContextQuery(
    args: Record<string, unknown>,
    data: Record<string, unknown>
  ): string | null {
    const candidates = [
      args.query,
      args.task,
      args.title,
      args.name,
      args.summary,
      args.description,
      data.title,
      data.name,
      data.summary,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  private async fetchEntityRecord(
    type: string,
    id: string,
    userId: string | null
  ): Promise<Record<string, unknown> | null> {
    const params = new URLSearchParams();
    params.set('type', type);
    params.set('id', id);
    params.set('limit', '1');

    const response = await callOrgxApiJson(
      this.env,
      `/api/entities?${params.toString()}`,
      undefined,
      userId ? { userId } : undefined
    );
    const payload = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    return payload.data?.[0] ?? null;
  }

  private async fetchEntityCollection(params: {
    type: string;
    userId: string | null;
    limit?: number;
    initiativeId?: string | null;
    workspaceId?: string | null;
    status?: string | null;
    query?: string | null;
    fields?: string[] | null;
  }): Promise<Array<Record<string, unknown>>> {
    const search = new URLSearchParams();
    search.set('type', params.type);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.initiativeId) search.set('initiative_id', params.initiativeId);
    if (params.workspaceId) search.set('workspace_id', params.workspaceId);
    if (params.status) search.set('status', params.status);
    if (params.query) search.set('query', params.query);
    if (params.fields?.length) search.set('fields', params.fields.join(','));

    const response = await callOrgxApiJson(
      this.env,
      `/api/entities?${search.toString()}`,
      undefined,
      params.userId ? { userId: params.userId } : undefined
    );
    const payload = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    return Array.isArray(payload.data) ? payload.data : [];
  }

  private async findExistingEntityByIdempotencyKey(params: {
    body: Record<string, unknown>;
    idempotencyKey: string | null;
    userId: string | null;
  }): Promise<Record<string, unknown> | null> {
    const type =
      typeof params.body.type === 'string' && params.body.type.trim().length > 0
        ? params.body.type.trim()
        : null;
    const idempotencyKey =
      typeof params.idempotencyKey === 'string' &&
      params.idempotencyKey.trim().length > 0
        ? params.idempotencyKey.trim()
        : null;
    if (!type || !idempotencyKey) return null;

    const title =
      typeof params.body.title === 'string' && params.body.title.trim().length > 0
        ? params.body.title.trim()
        : typeof params.body.name === 'string' && params.body.name.trim().length > 0
        ? params.body.name.trim()
        : null;

    const baseSearch = {
      type,
      userId: params.userId,
      limit: 100,
      workspaceId:
        typeof params.body.workspace_id === 'string'
          ? params.body.workspace_id
          : this.sessionContext?.workspaceId ?? null,
      initiativeId:
        typeof params.body.initiative_id === 'string'
          ? params.body.initiative_id
          : null,
    };

    const records = await this.fetchEntityCollection({
      ...baseSearch,
      query: title,
    });

    const exactMatch = records.find((record) =>
      entityMatchesIdempotencyKey(record, idempotencyKey)
    );
    if (exactMatch) return exactMatch;
    if (!title) return null;

    const fallbackRecords = await this.fetchEntityCollection({
      ...baseSearch,
      query: null,
    });
    return (
      fallbackRecords.find((record) =>
        entityMatchesIdempotencyKey(record, idempotencyKey)
      ) ?? null
    );
  }

  private stripContractRuntimeFields(
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const {
      _context: _context,
      session_id: _sessionId,
      operation: _operation,
      fields: _fields,
      ...body
    } = args;
    return body;
  }

  private async maybeEnrichWithArtifactProof(params: {
    toolId: string;
    args: Record<string, unknown>;
    data: Record<string, unknown>;
    userId: string | null;
  }): Promise<Record<string, unknown>> {
    if (
      params.toolId !== 'get_initiative_pulse' &&
      params.toolId !== 'get_agent_status' &&
      params.toolId !== 'get_morning_brief'
    ) {
      return params.data;
    }

    try {
      const initiativeIds = new Set<string>();
      const workspaceId =
        (typeof params.args.workspace_id === 'string' &&
          params.args.workspace_id.trim().length > 0 &&
          params.args.workspace_id.trim()) ||
        this.sessionContext?.workspaceId ||
        null;

      const directInitiativeId =
        (typeof params.data.initiative_id === 'string' &&
          params.data.initiative_id.trim().length > 0 &&
          params.data.initiative_id.trim()) ||
        (typeof params.data.id === 'string' &&
          params.toolId === 'get_initiative_pulse' &&
          params.data.id.trim().length > 0 &&
          params.data.id.trim()) ||
        (typeof params.args.initiative_id === 'string' &&
          params.args.initiative_id.trim().length > 0 &&
          params.args.initiative_id.trim()) ||
        this.sessionContext?.initiativeId ||
        null;
      if (directInitiativeId) initiativeIds.add(directInitiativeId);

      if (Array.isArray(params.data.agents)) {
        for (const rawAgent of params.data.agents) {
          if (!rawAgent || typeof rawAgent !== 'object') continue;
          const record = rawAgent as Record<string, unknown>;
          const candidateIds = [
            record.initiative_id,
            record.initiativeId,
            record.workspace_initiative_id,
          ];
          for (const candidate of candidateIds) {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
              initiativeIds.add(candidate.trim());
            }
          }
          const taskArrays = [
            record.current_tasks,
            record.currentTasks,
            record.active_tasks,
            record.activeTasks,
            record.tasks,
            record.items,
          ];
          for (const candidateArray of taskArrays) {
            if (!Array.isArray(candidateArray)) continue;
            for (const item of candidateArray) {
              if (!item || typeof item !== 'object') continue;
              const task = item as Record<string, unknown>;
              const taskInitiativeId =
                (typeof task.initiative_id === 'string' && task.initiative_id.trim()) ||
                (typeof task.initiativeId === 'string' && task.initiativeId.trim()) ||
                null;
              if (taskInitiativeId) initiativeIds.add(taskInitiativeId);
            }
          }
        }
      }

      const artifactMap = new Map<string, Record<string, unknown>>();
      if (initiativeIds.size > 0) {
        for (const initiativeId of initiativeIds) {
          const records = await this.fetchEntityCollection({
            type: 'artifact',
            userId: params.userId,
            initiativeId,
            limit: params.toolId === 'get_agent_status' ? 24 : 8,
          });
          for (const record of records) {
            const key =
              (typeof record.id === 'string' && record.id.trim()) ||
              `${record.title ?? record.name ?? 'artifact'}:${record.status ?? 'draft'}`;
            artifactMap.set(String(key), record);
          }
        }
      } else if (workspaceId && params.toolId === 'get_morning_brief') {
        const records = await this.fetchEntityCollection({
          type: 'artifact',
          userId: params.userId,
          workspaceId,
          limit: 8,
        });
        for (const record of records) {
          const key =
            (typeof record.id === 'string' && record.id.trim()) ||
            `${record.title ?? record.name ?? 'artifact'}:${record.status ?? 'draft'}`;
          artifactMap.set(String(key), record);
        }
      }

      const artifacts = Array.from(artifactMap.values());
      if (artifacts.length === 0) return params.data;

      if (params.toolId === 'get_initiative_pulse') {
        return enrichInitiativePulseWithArtifacts(params.data, artifacts);
      }
      if (params.toolId === 'get_agent_status') {
        return enrichAgentStatusWithArtifacts(params.data, artifacts);
      }
      if (params.toolId === 'get_morning_brief') {
        return enrichMorningBriefWithArtifacts(params.data, artifacts);
      }
      return params.data;
    } catch (error) {
      console.warn('[mcp:artifact-proof] enrichment skipped', {
        toolId: params.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return params.data;
    }
  }

  private async maybeNormalizeAgentDispatchData(params: {
    toolId: string;
    args: Record<string, unknown>;
    data: Record<string, unknown>;
    userId: string | null;
  }): Promise<Record<string, unknown>> {
    if (
      params.toolId !== 'spawn_agent_task' &&
      params.toolId !== 'handoff_task'
    ) {
      return params.data;
    }

    return normalizeAgentDispatchPayload({
      toolId: params.toolId,
      args: params.args,
      data: params.data,
      sessionContext: this.sessionContext,
      lookupEntity: (type, id) => this.fetchEntityRecord(type, id, params.userId),
    });
  }

  /**
   * Apply session-scoped defaults to tool args.
   *
   * This is a pragmatic "context survival" layer: if a client drops IDs between
   * calls (or the model forgets), we can still route work to the last-known
   * initiative/workspace for this MCP session.
   */
  private applySessionDefaults(
    toolId: string,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const nextArgs = { ...args };
    const workspaceScopedChatgptTools = new Set([
      'get_pending_decisions',
      'recommend_next_action',
      'get_agent_status',
      'score_next_up_queue',
      'scoring_config',   // replaces get_scoring_config, set_scoring_config, set_scoring_weights
      'queue_action',     // replaces pin_queue_item, unpin_queue_item, skip_workstream
    ]);

    const workspaceId =
      typeof nextArgs.workspace_id === 'string' &&
      nextArgs.workspace_id.trim().length > 0
        ? nextArgs.workspace_id.trim()
        : null;
    const commandCenterId =
      typeof nextArgs.command_center_id === 'string' &&
      nextArgs.command_center_id.trim().length > 0
        ? nextArgs.command_center_id.trim()
        : null;

    // Canonicalize: always use workspace_id; strip command_center_id so it
    // never reaches DB inserts (the column was renamed in the 2026-04 migration).
    const effectiveId = workspaceId ?? commandCenterId;
    if (effectiveId) {
      nextArgs.workspace_id = effectiveId;
    }
    delete nextArgs.command_center_id;

    const hasWorkspaceScope =
      typeof nextArgs.workspace_id === 'string' &&
      nextArgs.workspace_id.trim().length > 0;
    if (
      !hasWorkspaceScope &&
      this.sessionContext?.workspaceId &&
      workspaceScopedChatgptTools.has(toolId)
    ) {
      nextArgs.workspace_id = this.sessionContext.workspaceId;
    }

    const hasInitiativeId =
      typeof nextArgs.initiative_id === 'string' &&
      nextArgs.initiative_id.trim().length > 0;
    if (!hasInitiativeId && this.sessionContext?.initiativeId) {
      // Only inject initiative_id for tools where it is clearly beneficial.
      // Avoid implicitly narrowing list/browse operations.
      if (toolId === 'spawn_agent_task' || toolId === 'get_initiative_pulse') {
        nextArgs.initiative_id = this.sessionContext.initiativeId;
      }
    }

    return nextArgs;
  }

  private maybeUpdateSessionInitiativeContext(params: {
    toolId: string;
    args: Record<string, unknown>;
    data: Record<string, unknown>;
  }) {
    try {
      const initiativeId =
        (typeof params.data.initiative_id === 'string' &&
          params.data.initiative_id.trim().length > 0 &&
          params.data.initiative_id.trim()) ||
        (typeof params.args.initiative_id === 'string' &&
          params.args.initiative_id.trim().length > 0 &&
          params.args.initiative_id.trim()) ||
        null;

      if (!initiativeId) return;
      if (initiativeId === this.sessionContext.initiativeId) return;

      this.sessionContext = { ...this.sessionContext, initiativeId };
      // Fire-and-forget here; do not block tool responses on context survival.
      void this.saveSessionContext();
    } catch {
      // Non-fatal: never block tool execution on session context updates.
    }
  }

  private async maybeEnrichWithRelatedContext(params: {
    toolId: string;
    args: Record<string, unknown>;
    userId: string | null;
    data: Record<string, unknown>;
    message: string;
  }): Promise<{ data: Record<string, unknown>; message: string }> {
    const trigger = INJECTION_TRIGGERS[params.toolId];
    if (!trigger || !params.userId) {
      return { data: params.data, message: params.message };
    }

    try {
      const domain =
        typeof params.args.domain === 'string'
          ? params.args.domain
          : inferDomainFromTool(params.toolId);
      const query = this.getRelatedContextQuery(params.args, params.data);
      const initiativeId =
        (params.args.initiative_id as string | undefined) ??
        (params.data.initiative_id as string | undefined) ??
        null;

      const search = new URLSearchParams({
        user_id: params.userId,
        limit: trigger === 'always' ? '5' : '3',
      });
      if (domain) search.set('domain', domain);
      if (query) search.set('query', query);
      if (initiativeId) search.set('initiative_id', initiativeId);

      const contextResponse = await callOrgxApiJson(
        this.env,
        `/api/cross-pollination/context?${search.toString()}`,
        undefined,
        { userId: params.userId }
      );
      const relatedContext = (await contextResponse.json()) as RelatedContext;

      const wrapper = enrichResultWithContext(
        { ok: true, data: { ...params.data } },
        relatedContext,
        this.env.ORGX_WEB_URL || 'https://useorgx.com'
      );

      const enrichedData = (wrapper.data ?? params.data) as Record<
        string,
        unknown
      >;
      if (wrapper._relatedContext) {
        enrichedData._relatedContext = wrapper._relatedContext;
      }
      if (wrapper._workspaceInfluence) {
        enrichedData._workspaceInfluence = wrapper._workspaceInfluence;
      }

      let enrichedMessage = params.message;
      const relatedItems = wrapper._relatedContext?.items ?? [];
      if (relatedItems.length > 0) {
        const relatedLines = relatedItems
          .slice(0, 3)
          .map((item) => `• ${item.title} (${item.domain})`)
          .join('\n');
        enrichedMessage += `\n\n🔎 Related context:\n${relatedLines}`;
      }

      return { data: enrichedData, message: enrichedMessage };
    } catch (error) {
      console.warn('[mcp] related context enrichment skipped', {
        toolId: params.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { data: params.data, message: params.message };
    }
  }

  /**
   * Execute a ChatGPT tool via the unified API endpoint.
   * This keeps the worker thin - all business logic lives in the main app.
   * Returns both text content and structuredContent for widget rendering.
   *
   * Per MCP Authorization Spec:
   * - Check if tool requires auth via securitySchemes
   * - Return _meta["mcp/www_authenticate"] if auth required but missing
   */
  private async executeChatGPTTool(
    toolId: string,
    args: Record<string, unknown>,
    securitySchemes?: readonly { type: string; scopes?: readonly string[] }[]
  ): Promise<CallToolResult> {
    const startTime = Date.now();

    // Resolve userId from props (current request), session auth (OAuth), or explicit args (service-key MCP)
    const resolvedUserId = this.props?.userId ?? this.sessionAuth.userId;
    const authSource: 'request' | 'session' | 'none' = this.props?.userId
      ? 'request'
      : this.sessionAuth.userId
      ? 'session'
      : 'none';
    const effectiveArgs = this.applySessionDefaults(toolId, args);
    const toolDefinition = CHATGPT_TOOL_DEFINITIONS.find((tool) => tool.id === toolId);
    const outputTemplate = (toolDefinition?._meta as Record<string, unknown> | undefined)?.[
      'openai/outputTemplate'
    ];
    const isWidgetTool = typeof outputTemplate === 'string';

    this.captureMcpToolEvent('mcp_tool_called', {
      toolId,
      toolFamily: 'chatgpt',
      userId: resolvedUserId,
      authSource,
      isWidgetTool,
    });

    // Use extracted auth helper (DRY)
    const authResponse = buildAuthRequiredResponse({
      toolId,
      securitySchemes,
      userId: resolvedUserId,
      serverUrl: this.env.MCP_SERVER_URL,
      featureDescription: `use ${toolId.replace(/_/g, ' ')}`,
    });
    if (authResponse) {
      this.captureMcpToolEvent('mcp_tool_failed', {
        toolId,
        toolFamily: 'chatgpt',
        userId: resolvedUserId,
        authSource,
        ok: false,
        latencyMs: Date.now() - startTime,
        error: 'auth_required',
        isWidgetTool,
      });
      if (isWidgetTool) {
        this.appendWidgetDebugEvent({
          phase: 'tool_call',
          toolId,
          outputTemplate:
            typeof outputTemplate === 'string' ? outputTemplate : undefined,
          details: { authBlocked: true, hasUserId: !!resolvedUserId },
        });
      }
      // Auth blocked - already logged in buildAuthRequiredResponse
      return authResponse;
    }

    if (toolId === 'spawn_agent_task') {
      const planResponse = await checkToolPlanAccess({
        env: this.env,
        userId: resolvedUserId ?? null,
        feature: 'spawn_agent_task',
      });
      if (planResponse) {
        this.captureMcpToolEvent('mcp_tool_failed', {
          toolId,
          toolFamily: 'chatgpt',
          userId: resolvedUserId,
          authSource,
          ok: false,
          latencyMs: Date.now() - startTime,
          error: 'plan_restricted',
          isWidgetTool,
        });
        return planResponse;
      }
    }

    if (isWidgetTool) {
      this.appendWidgetDebugEvent({
        phase: 'tool_call',
        toolId,
        outputTemplate:
          typeof outputTemplate === 'string' ? outputTemplate : undefined,
        details: {
          hasUserId: !!resolvedUserId,
          authSource: this.props?.userId
            ? 'request'
            : this.sessionAuth.userId
            ? 'session'
            : 'none',
          argsKeys: Object.keys(effectiveArgs ?? {}),
        },
      });
    }

    console.info('[mcp] Executing tool', {
      toolId,
      hasUserId: !!resolvedUserId,
      authSource,
    });

    // Expand consolidated tools (scoring_config, queue_action, stats)
    // into their legacy backend tool_id before dispatching
    const { resolvedToolId, resolvedArgs: expandedArgs } =
      expandConsolidatedTool(toolId, effectiveArgs);

    return this.withOrgx(async () => {
      try {
        let budgetPreflight: SpawnBudgetPreflight | null = null;
        if (
          resolvedToolId === 'spawn_agent_task' ||
          resolvedToolId === 'handoff_task'
        ) {
          const preflight = await this.runSpawnBudgetPreflight(
            expandedArgs,
            resolvedUserId ?? null
          );
          if (!preflight.ok) {
            this.captureMcpToolEvent('mcp_tool_failed', {
              toolId,
              toolFamily: 'chatgpt',
              userId: resolvedUserId,
              authSource,
              ok: false,
              latencyMs: Date.now() - startTime,
              error: String(preflight.details.code ?? 'budget_preflight_failed'),
              isWidgetTool,
            });
            return this.toolError(preflight.message, {
              code: String(preflight.details.code ?? 'budget_preflight_failed'),
              status:
                preflight.details.code === 'budget_cap_exceeded' ? 402 : 424,
              details: preflight.details,
            });
          }
          budgetPreflight = preflight.preflight;
        }

        // Use direct endpoints for high-traffic tools (lower latency)
        // Fall back to generic /api/tools/execute for others
        // Use resolvedToolId/expandedArgs from expandConsolidatedTool
        const { endpoint, body } = this.getToolEndpoint(resolvedToolId, expandedArgs);
        if (resolvedUserId) {
          body.user_id = resolvedUserId;
        }

        const response = await callOrgxApiJson(
          this.env,
          endpoint,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          { userId: resolvedUserId }
        );

        const result = (await response.json()) as {
          ok: boolean;
          data?: Record<string, unknown>;
          error?: string;
          execution_time_ms?: number;
        };

        const latencyMs = Date.now() - startTime;

        if (!result.ok) {
          console.error('[mcp] Tool execution failed', {
            toolId,
            error: result.error,
            latencyMs,
            hasUserId: !!resolvedUserId,
          });
          this.captureMcpToolEvent('mcp_tool_failed', {
            toolId,
            toolFamily: 'chatgpt',
            userId: resolvedUserId,
            authSource,
            ok: false,
            latencyMs,
            error: result.error ?? 'tool_execution_failed',
            isWidgetTool,
          });
          const errorMessage = result.error ?? 'Tool execution failed';
          if (isWidgetTool) {
            return this.widgetToolError(
              toolId,
              errorMessage,
              typeof outputTemplate === 'string' ? outputTemplate : undefined,
              result.data ?? {}
            );
          }
          return this.toolError(errorMessage);
        }

        console.info('[mcp] Tool executed successfully', { toolId, latencyMs });

        // Extract message if present, otherwise use imported summarizer
        let data = result.data ?? {};
        if (budgetPreflight) {
          data = {
            ...data,
            budget_preflight: budgetPreflight,
          };
        }
        let message =
          typeof data.message === 'string'
            ? data.message
            : summarizeChatGPTToolResult(toolId, data);

        const enrichment = await this.maybeEnrichWithRelatedContext({
          toolId,
          args: effectiveArgs,
          userId: resolvedUserId ?? null,
          data,
          message,
        });
        data = enrichment.data;
        message = enrichment.message;
        data = await this.maybeNormalizeAgentDispatchData({
          toolId,
          args: effectiveArgs,
          data,
          userId: resolvedUserId ?? null,
        });
        data = await this.maybeEnrichWithArtifactProof({
          toolId,
          args: effectiveArgs,
          data,
          userId: resolvedUserId ?? null,
        });
        if (toolId === 'get_agent_status') {
          data = normalizeAgentStatusPayload(data);
        }

        this.maybeUpdateSessionInitiativeContext({
          toolId,
          args: effectiveArgs,
          data,
        });

        // Add live_url for initiative-related tools
        const initiativeId = data.initiative_id as string | undefined;
        const hasInitiativeContext =
          initiativeId ||
          toolId === 'get_initiative_pulse' ||
          toolId === 'spawn_agent_task';
        const effectiveInitiativeId =
          initiativeId || (data.id as string | undefined);

        let finalMessage = message;
        if (hasInitiativeContext && effectiveInitiativeId) {
          const liveUrl = buildLiveUrl(effectiveInitiativeId);
          finalMessage += `\n\n📺 **Live view:** ${liveUrl}`;
          // Also add to structured content
          data.live_url = liveUrl;
        }

        this.captureMcpToolEvent('mcp_tool_succeeded', {
          toolId,
          toolFamily: 'chatgpt',
          userId: resolvedUserId,
          authSource,
          ok: true,
          latencyMs,
          isWidgetTool,
          // A6/A7: capture realized token/cost spend when the response carried it.
          ...extractRunCostTelemetry(result.data),
          // A1: verify a requested provider/model pin was honored end-to-end.
          ...(() => {
            const pinning = detectProviderPinning(
              { provider: expandedArgs.provider, model: expandedArgs.model },
              result.data
            );
            return pinning
              ? {
                  providerRequested: pinning.requested_provider,
                  providerUsed: pinning.used_provider,
                  providerMismatch: pinning.provider_mismatch || pinning.model_mismatch,
                }
              : {};
          })(),
        });

        // Dual-protocol return:
        // - Widget tools: JSON in content[0] for MCP Apps widget parsing
        // - Non-widget tools: concise summary only (saves 80-95% tokens)
        // structuredContent always carries the full payload for widgets.
        // Live-feed SSE widget: inject for agent-status + initiative-pulse tools
        let _liveFeedWidgetHtml: string | null = null;
        if (
          (toolId === 'get_agent_status' || toolId === 'get_initiative_pulse') &&
          effectiveInitiativeId &&
          this.env.LIVE_FEED &&
          this.env.MCP_JWT_SECRET
        ) {
          try {
            const _feedType = toolId === 'get_agent_status' ? 'agent-status' : 'initiative-pulse';
            const _streamToken = await signStreamToken({
              feedType: _feedType,
              feedId: effectiveInitiativeId,
              userId: resolvedUserId ?? undefined,
              secret: this.env.MCP_JWT_SECRET,
            });
            const _liveUrl = hasInitiativeContext && effectiveInitiativeId
              ? buildLiveUrl(effectiveInitiativeId)
              : undefined;
            _liveFeedWidgetHtml = buildLiveFeedWidget({
              feedType: _feedType,
              feedId: effectiveInitiativeId,
              streamBaseUrl: this.env.MCP_SERVER_URL,
              streamToken: _streamToken,
              liveUrl: _liveUrl,
              title: typeof (data.initiative as Record<string, unknown> | undefined)?.title === 'string'
                ? (data.initiative as Record<string, unknown>).title as string
                : undefined,
            });
          } catch (_err) {
            console.warn('[live-feed-widget] token/widget build failed', { error: _err });
          }
        }

        if (isWidgetTool) {
          this.appendWidgetDebugEvent({
            phase: 'tool_result',
            toolId,
            outputTemplate:
              typeof outputTemplate === 'string' ? outputTemplate : undefined,
            details: {
              contentBlocks: _liveFeedWidgetHtml ? 3 : 2,
              hasStructuredContent: true,
              dataKeys: Object.keys(data),
            },
          });
          return {
            content: buildJsonFirstContentBlocks({
              data,
              summary: finalMessage,
              widgetHtml: _liveFeedWidgetHtml,
            }),
            structuredContent: data,
          } as CallToolResult;
        }

        // Non-widget tools: summary only in content
        return {
          content: [{ type: 'text', text: finalMessage }],
          structuredContent: data,
        } as CallToolResult;
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        this.captureMcpToolEvent('mcp_tool_failed', {
          toolId,
          toolFamily: 'chatgpt',
          userId: resolvedUserId,
          authSource,
          ok: false,
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
          isWidgetTool,
        });
        if (isWidgetTool) {
          return this.widgetToolError(
            toolId,
            error instanceof Error ? error.message : String(error),
            typeof outputTemplate === 'string' ? outputTemplate : undefined
          );
        }
        throw error;
      }
    });
  }

  /**
   * Injects the _context parameter into a tool's inputSchema.
   * This enables conversation tracking across MCP clients.
   */
  private withClientContext<T extends Record<string, unknown>>(
    inputSchema: T
  ): T & { _context: typeof CLIENT_CONTEXT_SCHEMA } {
    return {
      ...inputSchema,
      _context: CLIENT_CONTEXT_SCHEMA,
    };
  }

  /**
   * Register all ChatGPT App tools using data-driven definitions.
   * Tools are thin wrappers that delegate to the unified API.
   * Includes _meta annotations for widget rendering per OpenAI Apps SDK.
   * Includes securitySchemes per MCP Authorization Spec (via _meta).
   */
  private registerChatGPTTools(allowedTools: Set<string> | null) {
    // Tools that use output templates must be visible, otherwise ChatGPT disables the template.
    // These tools are still protected by OAuth scopes, but we mark them public so their widgets work.
    // The generic rule below force-publics ANY template-bearing tool; this set is kept for
    // template-less tools that must still be public for ChatGPT to expose them.
    const FORCE_PUBLIC_TEMPLATE_TOOLS = new Set([
      'approve_decision',
      'reject_decision',
      'spawn_agent_task',
    ]);

    // These tools are registered inline in registerTools() with custom handlers.
    // Skip them here to avoid "Tool X is already registered" errors from the SDK.
    const INLINE_HANDLED_TOOLS = new Set([
      'workspace',
      'configure_org',
      'stats',
    ]);

    for (const tool of CHATGPT_TOOL_DEFINITIONS) {
      if (INLINE_HANDLED_TOOLS.has(tool.id)) continue;
      if (allowedTools && !allowedTools.has(tool.id)) continue;
      const metaObj = tool._meta as unknown as
        | Record<string, unknown>
        | undefined;
      const isReadOnly = metaObj?.['openai/readOnlyHint'] === true;
      const hasOutputTemplate = Boolean(metaObj?.['openai/outputTemplate']);
      const visibility =
        isReadOnly || hasOutputTemplate || FORCE_PUBLIC_TEMPLATE_TOOLS.has(tool.id)
          ? 'public'
          : 'private';

      const meta: Record<string, unknown> = {
        ...tool._meta,
        // Control ChatGPT connector visibility (Apps SDK convention)
        'openai/visibility': visibility,
        // Per MCP auth spec, declare security requirements
        'mcp/securitySchemes': tool.securitySchemes,
      };

      // registerAppTool normalizes ui.resourceUri ↔ ui/resourceUri for host compat
      registerAppTool(
        this.server,
        tool.id,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: this.withClientContext(tool.inputSchema),
          annotations: (tool as { annotations?: Record<string, boolean> }).annotations,
          _meta: meta,
        } as Parameters<typeof registerAppTool>[2],
        async (args: Record<string, unknown>) =>
          this.executeChatGPTTool(tool.id, args, tool.securitySchemes)
      );
    }
  }

  /**
   * Register plan session tools for CLI-native planning workflow.
   * These tools enable:
   * - Starting/tracking plan sessions
   * - Recording edits for pattern learning
   * - Applying learned skills to improve plans
   * - Completing plans and extracting skills
   */
  private registerPlanSessionTools(allowedTools: Set<string> | null) {
    for (const tool of PLAN_SESSION_TOOLS) {
      if (allowedTools && !allowedTools.has(tool.id)) continue;
      // Plan session tools modify state / learn from edits; keep them private by default.
      const meta = {
        ...tool._meta,
        'openai/visibility': 'private',
        'mcp/securitySchemes': tool.securitySchemes,
      };

      this.server.registerTool(
        tool.id,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: V2_ORGX_TOOL_ID_SET.has(tool.id)
            ? tool.inputSchema
            : this.withClientContext(tool.inputSchema),
          annotations: tool.annotations,
          _meta: meta,
        },
        async (args: Record<string, unknown>) =>
          this.executePlanSessionTool(tool.id, args, tool.securitySchemes)
      );
    }
  }

  /**
   * Register Stream Coordination tools for autonomous work tracking.
   * These are unique tools not covered by generic entity operations:
   * - update_stream_progress: Velocity tracking for ETA calculation
   * - get_initiative_stream_state: Aggregate metrics and computed state
   */
  private registerStreamTools(allowedTools: Set<string> | null) {
    for (const tool of STREAM_TOOL_DEFINITIONS) {
      if (allowedTools && !allowedTools.has(tool.id)) continue;
      const metaObj = tool._meta as Record<string, unknown> | undefined;
      const isReadOnly = metaObj?.['openai/readOnlyHint'] === true;

      const meta = {
        ...tool._meta,
        'openai/visibility': isReadOnly ? 'public' : 'private',
        'mcp/securitySchemes': tool.securitySchemes,
      };

      this.server.registerTool(
        tool.id,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: this.withClientContext(tool.inputSchema),
          annotations: tool.annotations,
          _meta: meta,
        },
        async (args: Record<string, unknown>) =>
          this.executeStreamTool(tool.id, args, tool.securitySchemes)
      );
    }
  }

  /**
   * Execute a stream coordination tool via the API.
   */
  private async executeStreamTool(
    toolId: string,
    args: Record<string, unknown>,
    securitySchemes?: readonly { type: string; scopes?: readonly string[] }[]
  ): Promise<CallToolResult> {
    const startTime = Date.now();
    const resolvedUserId = this.props?.userId ?? this.sessionAuth.userId;
    const authSource: 'request' | 'session' | 'none' = this.props?.userId
      ? 'request'
      : this.sessionAuth.userId
      ? 'session'
      : 'none';

    this.captureMcpToolEvent('mcp_tool_called', {
      toolId,
      toolFamily: 'stream',
      userId: resolvedUserId,
      authSource,
    });

    const authResponse = buildAuthRequiredResponse({
      toolId,
      securitySchemes,
      userId: resolvedUserId,
      serverUrl: this.env.MCP_SERVER_URL,
      featureDescription: 'use stream coordination',
    });
    if (authResponse) {
      this.captureMcpToolEvent('mcp_tool_failed', {
        toolId,
        toolFamily: 'stream',
        userId: resolvedUserId,
        authSource,
        ok: false,
        latencyMs: Date.now() - startTime,
        error: 'auth_required',
      });
      return authResponse;
    }

    return this.withOrgx(async () => {
      try {
        // Route to the appropriate endpoint
        const isLifecycle = toolId === 'manage_lifecycle';
        const endpoint = isLifecycle
          ? '/api/internal/lifecycle'
          : toolId === 'update_stream_progress'
          ? '/api/streams/progress'
          : '/api/streams/initiative-state';

        const method =
          toolId === 'update_stream_progress' || isLifecycle ? 'POST' : 'GET';

        let response;
        if (method === 'GET') {
          const url = new URL(endpoint, 'https://placeholder.com');
          if (args.initiative_id) {
            url.searchParams.set('initiative_id', String(args.initiative_id));
          }
          response = await callOrgxApiJson(
            this.env,
            `${endpoint}?${url.searchParams.toString()}`
          );
        } else {
          const body = isLifecycle
            ? {
                level: args.level,
                id: args.id,
                action: args.action,
                userId: resolvedUserId,
              }
            : { ...args, user_id: resolvedUserId };
          response = await callOrgxApiJson(this.env, endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
          });
        }

        const result = (await response.json()) as {
          ok: boolean;
          data?: Record<string, unknown>;
          error?: string;
        };

        const latencyMs = Date.now() - startTime;

        if (!result.ok || result.error) {
          this.captureMcpToolEvent('mcp_tool_failed', {
            toolId,
            toolFamily: 'stream',
            userId: resolvedUserId,
            authSource,
            ok: false,
            latencyMs,
            error: result.error || 'stream_operation_failed',
          });
          return this.toolError(result.error || 'Stream operation failed');
        }

        this.captureMcpToolEvent('mcp_tool_succeeded', {
          toolId,
          toolFamily: 'stream',
          userId: resolvedUserId,
          authSource,
          ok: true,
          latencyMs,
        });

        const summary = summarizeStreamToolResult(toolId, result.data || {});
        return {
          content: [{ type: 'text', text: summary }],
        };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        this.captureMcpToolEvent('mcp_tool_failed', {
          toolId,
          toolFamily: 'stream',
          userId: resolvedUserId,
          authSource,
          ok: false,
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Execute a plan session tool via the API.
   */
  private async executePlanSessionTool(
    toolId: string,
    args: Record<string, unknown>,
    securitySchemes?: readonly { type: string; scopes?: readonly string[] }[]
  ): Promise<CallToolResult> {
    const startTime = Date.now();
    // Resolve userId from props (current request) or session auth (persisted from OAuth)
    const resolvedUserId = this.props?.userId ?? this.sessionAuth.userId;
    const authSource: 'request' | 'session' | 'none' = this.props?.userId
      ? 'request'
      : this.sessionAuth.userId
      ? 'session'
      : 'none';

    this.captureMcpToolEvent('mcp_tool_called', {
      toolId,
      toolFamily: 'plan_session',
      userId: resolvedUserId,
      authSource,
    });

    // Use extracted auth helper (DRY)
    const authResponse = buildAuthRequiredResponse({
      toolId,
      securitySchemes,
      userId: resolvedUserId,
      serverUrl: this.env.MCP_SERVER_URL,
      featureDescription: 'use planning features',
    });
    if (authResponse) {
      this.captureMcpToolEvent('mcp_tool_failed', {
        toolId,
        toolFamily: 'plan_session',
        userId: resolvedUserId,
        authSource,
        ok: false,
        latencyMs: Date.now() - startTime,
        error: 'auth_required',
      });
      return authResponse;
    }

    return this.withOrgx(async () => {
      try {
        // Map tool IDs to API endpoints
        const apiMapping: Record<string, { path: string; method: string }> = {
          start_plan_session: { path: '/api/plan-sessions', method: 'POST' },
          get_active_sessions: {
            path: '/api/plan-sessions?status=active',
            method: 'GET',
          },
          improve_plan: { path: '/api/plan-sessions/improve', method: 'POST' },
          record_plan_edit: { path: '/api/plan-sessions/edit', method: 'POST' },
          complete_plan: { path: '/api/plan-sessions/complete', method: 'POST' },
        };

        const mapping = apiMapping[toolId];
        if (!mapping) {
          const latencyMs = Date.now() - startTime;
          this.captureMcpToolEvent('mcp_tool_failed', {
            toolId,
            toolFamily: 'plan_session',
            userId: resolvedUserId,
            authSource,
            ok: false,
            latencyMs,
            error: 'unknown_plan_session_tool',
          });
          return this.toolError(`Unknown plan session tool: ${toolId}`);
        }

        // Build request
        const normalizedArgs = Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== '_context')
        ) as Record<string, unknown>;

        if (
          toolId === 'improve_plan' ||
          toolId === 'record_plan_edit' ||
          toolId === 'complete_plan'
        ) {
          const normalizedSessionId = normalizePlanSessionId(normalizedArgs.session_id);
          if (!normalizedSessionId) {
            return this.toolError(
              'session_id must be a plan session UUID or orgx://plan_session/<uuid>',
              {
                code: 'invalid_input',
                status: 400,
                details: {
                  field: 'session_id',
                  accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
                  suggested_next_calls: [
                    { tool: 'get_active_sessions', args: {} },
                    { tool: 'resume_plan_session', args: {} },
                  ],
                },
              }
            );
          }
          normalizedArgs.session_id = normalizedSessionId;
        }

        let path = mapping.path;
        const init: RequestInit = { method: mapping.method };

        if (mapping.method === 'GET') {
          // Add query params for GET requests
          const url = new URL(path, 'https://placeholder.com');
          if (resolvedUserId) {
            url.searchParams.set('user_id', resolvedUserId);
          }
          path = url.pathname + url.search;
        } else {
          // Transform args for POST requests
          const body: Record<string, unknown> = { ...normalizedArgs };
          if (resolvedUserId) {
            body.user_id = resolvedUserId;
          }

          // Map feature_name to title for start_plan_session
          if (toolId === 'start_plan_session') {
            body.title = normalizedArgs.feature_name || 'Untitled Plan';
            if (
              typeof body.workspace_id !== 'string' ||
              body.workspace_id.trim().length === 0
            ) {
              const workspaceId = this.sessionContext.workspaceId;
              if (workspaceId) body.workspace_id = workspaceId;
            }
          }

          init.body = JSON.stringify(body);
        }

        const response = await callOrgxApiJson(this.env, path, init, {
          userId: resolvedUserId,
        });
        const rawResult = (await response.json()) as Record<string, unknown>;
        const result = enrichPlanSessionResult(toolId, rawResult);

        this.captureMcpToolEvent('mcp_tool_succeeded', {
          toolId,
          toolFamily: 'plan_session',
          userId: resolvedUserId,
          authSource,
          ok: true,
          latencyMs: Date.now() - startTime,
        });

        // Use imported summarizer (DRY)
        const message = summarizePlanSessionResult(toolId, result);

        return {
          content: [{ type: 'text', text: message }],
          structuredContent: result,
        } as CallToolResult;
      } catch (error) {
        if (
          error instanceof OrgXApiError &&
          error.statusCode === 404 &&
          /Session not found/i.test(error.message)
        ) {
          return this.toolError(error.message, {
            code: 'entity_not_found',
            status: 404,
            details: {
              entity_type: 'plan_session',
              accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
              suggested_next_calls: [
                { tool: 'get_active_sessions', args: {} },
                { tool: 'resume_plan_session', args: {} },
              ],
            },
          });
        }
        const latencyMs = Date.now() - startTime;
        this.captureMcpToolEvent('mcp_tool_failed', {
          toolId,
          toolFamily: 'plan_session',
          userId: resolvedUserId,
          authSource,
          ok: false,
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /**
   * Register client integration tools.
   *
   * These route directly to /api/client/* endpoints (not through
   * the generic /api/tools/execute). This gives them:
   * - Dedicated server-side logic (model routing, quality gates)
   * - Proper user identity via a signed MCP actor assertion
   * - No dependency on the chatgptToolExecutor registry
   */
  private registerClientIntegrationTools(allowedTools: Set<string> | null) {
    // Map tool IDs to their direct API endpoints and HTTP methods
    const CLIENT_ENDPOINTS: Record<string, { path: string; method: string }> = {
      get_operator_chronicle: {
        path: '/api/operator/chronicle',
        method: 'GET',
      },
      check_execution_readiness: {
        path: '/api/client/credentials/status',
        method: 'GET',
      },
      orgx_emit_activity: {
        path: '/api/client/live/activity',
        method: 'POST',
      },
      orgx_emit_execution_graph: {
        path: '/api/client/live/execution-graph',
        method: 'POST',
      },
      orgx_apply_changeset: {
        path: '/api/client/live/changesets/apply',
        method: 'POST',
      },
      consolidate_pr: {
        path: '/api/client/consolidate-pr',
        method: 'POST',
      },
      sync_client_state: { path: '/api/client/sync', method: 'POST' },
      check_spawn_guard: { path: '/api/client/spawn', method: 'POST' },
      record_quality_score: { path: '/api/client/quality', method: 'POST' },
      classify_task_model: {
        path: '/api/client/route-task',
        method: 'POST',
      },
    };

    for (const tool of CLIENT_INTEGRATION_TOOL_DEFINITIONS) {
      if (allowedTools && !allowedTools.has(tool.id)) continue;
      const meta = {
        ...tool._meta,
        'openai/visibility': 'private',
        'mcp/securitySchemes': tool.securitySchemes,
      };

      this.server.registerTool(
        tool.id,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: this.withClientContext(tool.inputSchema) as unknown as Record<string, import('zod').ZodTypeAny>,
          annotations: tool.annotations,
          _meta: meta,
        },
        async (args: Record<string, unknown>) => {
          const startTime = Date.now();
          const resolvedUserId = this.props?.userId ?? this.sessionAuth.userId;
          const authSource: 'request' | 'session' | 'none' = this.props?.userId
            ? 'request'
            : this.sessionAuth.userId
            ? 'session'
            : 'none';

          this.captureMcpToolEvent('mcp_tool_called', {
            toolId: tool.id,
            toolFamily: 'client_integration',
            userId: resolvedUserId,
            authSource,
          });

          // Auth check
          const authResponse = buildAuthRequiredResponse({
            toolId: tool.id,
            securitySchemes: tool.securitySchemes,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: `use ${tool.id.replace(/_/g, ' ')}`,
          });
          if (authResponse) {
            this.captureMcpToolEvent('mcp_tool_failed', {
              toolId: tool.id,
              toolFamily: 'client_integration',
              userId: resolvedUserId,
              authSource,
              ok: false,
              latencyMs: Date.now() - startTime,
              error: 'auth_required',
            });
            return authResponse;
          }

          return this.withOrgx(async () => {
            try {
              const endpoint = CLIENT_ENDPOINTS[tool.id];
              if (!endpoint) {
                this.captureMcpToolEvent('mcp_tool_failed', {
                  toolId: tool.id,
                  toolFamily: 'client_integration',
                  userId: resolvedUserId,
                  authSource,
                  ok: false,
                  latencyMs: Date.now() - startTime,
                  error: 'unknown_client_integration_tool',
                });
                return this.toolError(
                  `Unknown client integration tool: ${tool.id}`
                );
              }

              let url = endpoint.path;
              let fetchInit: RequestInit;

              if (endpoint.method === 'GET') {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(args)) {
                  if (k !== '_context' && v !== undefined) {
                    params.set(k, String(v));
                  }
                }
                if (
                  (tool.id === 'get_operator_chronicle' ||
                    tool.id === 'check_execution_readiness') &&
                  !params.has('workspace_id') &&
                  !params.has('command_center_id') &&
                  this.sessionContext?.workspaceId
                ) {
                  params.set('workspace_id', this.sessionContext.workspaceId);
                }
                url = `${endpoint.path}?${params.toString()}`;
                fetchInit = { method: 'GET' };
              } else {
                // Strip _context before forwarding
                const { _context, ...toolArgs } = args;
                let normalizedToolArgs: Record<string, unknown> = toolArgs;
                if (tool.id === 'record_quality_score') {
                  const normalized =
                    normalizeRecordQualityScoreArgs(toolArgs);
                  if (normalized.error) {
                    return this.toolError(normalized.error.reason, {
                      code: normalized.error.code,
                      status: 400,
                      details: {
                        diagnostic: normalized.error,
                        corrected_payload: normalized.error.corrected_payload,
                        suggested_next_calls:
                          normalized.error.suggested_next_calls,
                      },
                    });
                  }
                  normalizedToolArgs = normalized.body;
                }
                fetchInit = {
                  method: 'POST',
                  body: JSON.stringify(normalizedToolArgs),
                };
              }

              const response = await callOrgxApiJson(this.env, url, fetchInit, {
                userId: resolvedUserId,
              });

              const result = (await response.json()) as {
                ok: boolean;
                data?: Record<string, unknown>;
                error?: string;
                message?: string;
              };

              const latencyMs = Date.now() - startTime;
              if (!result.ok) {
                this.captureMcpToolEvent('mcp_tool_failed', {
                  toolId: tool.id,
                  toolFamily: 'client_integration',
                  userId: resolvedUserId,
                  authSource,
                  ok: false,
                  latencyMs,
                  error:
                    result.error ??
                    result.message ??
                    'client_integration_execution_failed',
                });
                return this.toolError(
                  result.error ??
                    result.message ??
                    'Client integration tool execution failed'
                );
              }

              this.captureMcpToolEvent('mcp_tool_succeeded', {
                toolId: tool.id,
                toolFamily: 'client_integration',
                userId: resolvedUserId,
                authSource,
                ok: true,
                latencyMs,
              });

              const data =
                (result.data as Record<string, unknown> | undefined) ??
                (result as unknown as Record<string, unknown>);
              const enrichedData =
                tool.id === 'classify_task_model'
                  ? {
                      ...data,
                      estimate: buildRouteTaskEstimateSummary(data, args),
                    }
                  : data;
              const message = this.summarizeClientResult(tool.id, enrichedData);

              return {
                content: [{ type: 'text', text: message }],
                structuredContent: enrichedData,
              } as CallToolResult;
            } catch (error) {
              this.captureMcpToolEvent('mcp_tool_failed', {
                toolId: tool.id,
                toolFamily: 'client_integration',
                userId: resolvedUserId,
                authSource,
                ok: false,
                latencyMs: Date.now() - startTime,
                error: error instanceof Error ? error.message : String(error),
              });
              const message =
                error instanceof Error ? error.message : String(error);
              const status =
                error instanceof OrgXApiError ? error.statusCode : undefined;
              return this.toolError(message, {
                code: 'client_integration_failed',
                status,
                details: buildFailureDetails({
                  toolId: tool.id,
                  error,
                  args,
                }),
              });
            }
          });
        }
      );
    }
  }

  /**
   * Human-readable summaries for client integration tool results.
   */
  private summarizeClientResult(
    toolId: string,
    data: Record<string, unknown>
  ): string {
    switch (toolId) {
      case 'orgx_emit_activity': {
        const runId = data.run_id as string | undefined;
        const reused = data.reused_run === true;
        return runId
          ? `📝 Activity emitted${
              reused ? ' (existing run)' : ''
            } · run ${runId.slice(0, 8)}...`
          : '📝 Activity emitted';
      }
      case 'orgx_apply_changeset': {
        const replayed = data.replayed === true;
        const appliedCount =
          typeof data.applied_count === 'number' ? data.applied_count : 0;
        const changesetId = data.changeset_id as string | undefined;
        if (replayed) {
          return `↪️ Idempotent replay (no new changes) · ${
            changesetId?.slice(0, 8) ?? 'unknown'
          }...`;
        }
        return `✅ Changeset applied · ${appliedCount} operation${
          appliedCount === 1 ? '' : 's'
        }`;
      }
      case 'get_operator_chronicle': {
        const chronicle =
          data.chronicle && typeof data.chronicle === 'object'
            ? (data.chronicle as Record<string, unknown>)
            : data;
        const headline =
          typeof chronicle.headline === 'string'
            ? chronicle.headline
            : 'Operator chronicle ready';
        const metrics =
          chronicle.metrics && typeof chronicle.metrics === 'object'
            ? (chronicle.metrics as Record<string, unknown>)
            : {};
        const pending =
          typeof metrics.pendingDecisions === 'number'
            ? metrics.pendingDecisions
            : 0;
        const blocked =
          typeof metrics.blockedWork === 'number' ? metrics.blockedWork : 0;
        const artifacts =
          typeof metrics.artifactsProduced === 'number'
            ? metrics.artifactsProduced
            : 0;
        const prs =
          typeof metrics.prReceipts === 'number' ? metrics.prReceipts : 0;
        const narrative =
          chronicle.reportingNarrative &&
          typeof chronicle.reportingNarrative === 'object'
            ? (chronicle.reportingNarrative as Record<string, unknown>)
            : {};
        const nextAction =
          typeof narrative.nextAction === 'string' && narrative.nextAction.trim()
            ? ` · Next: ${narrative.nextAction.trim()}`
            : '';
        return `${headline} · ${pending} decisions pending · ${blocked} blocked · ${artifacts} artifacts · ${prs} PR receipts${nextAction}`;
      }
      case 'consolidate_pr': {
        const status = typeof data.status === 'string' ? data.status : 'ok';
        const artifactId =
          typeof data.artifact_id === 'string' ? data.artifact_id : null;
        const verdict = typeof data.verdict === 'string' ? data.verdict : null;
        const aqScore =
          typeof data.aq_score === 'number' ? ` · AQ ${data.aq_score}` : '';
        return `✅ PR consolidated (${status})${
          verdict ? ` · ${verdict}` : ''
        }${aqScore}${artifactId ? ` · artifact ${artifactId.slice(0, 8)}...` : ''}`;
      }
      case 'sync_client_state': {
        const initiatives = (data.initiatives as unknown[])?.length ?? 0;
        const tasks = (data.activeTasks as unknown[])?.length ?? 0;
        const decisions = (data.pendingDecisions as unknown[])?.length ?? 0;
        return `🔄 Synced — ${initiatives} initiatives, ${tasks} active tasks, ${decisions} pending decisions`;
      }
      case 'check_spawn_guard': {
        const allowed = data.allowed as boolean;
        const tier = data.modelTier as string;
        const reason = data.blockedReason as string | undefined;
        return allowed
          ? `✅ Spawn authorized — use model tier: ${tier}`
          : `🚫 Spawn blocked — ${reason ?? 'unknown reason'}`;
      }
      case 'record_quality_score': {
        const score =
          typeof data.score === 'number'
            ? data.score
            : typeof data.quality_score === 'number'
            ? data.quality_score
            : 0;
        const domain =
          typeof data.agentDomain === 'string'
            ? data.agentDomain
            : typeof data.agent_domain === 'string'
            ? data.agent_domain
            : 'agent';
        const stars = '⭐'.repeat(score) + '☆'.repeat(5 - score);
        return `${stars} Score recorded for ${domain}`;
      }
      case 'classify_task_model': {
        const estimate =
          data.estimate && typeof data.estimate === 'object'
            ? (data.estimate as ReturnType<typeof buildRouteTaskEstimateSummary>)
            : buildRouteTaskEstimateSummary(data);
        const complexity =
          typeof data.complexity === 'string' ? ` (${data.complexity})` : '';
        return `🧭 ${formatRouteTaskEstimateSummary(estimate)}${complexity}`;
      }
      default:
        return JSON.stringify(data, null, 2);
    }
  }

  private buildBootstrapPayload(allowedTools: Set<string> | null) {
    const profile = this.props?.profile ?? 'full';
    const visibleTools = allowedTools
      ? Array.from(allowedTools).sort()
      : getKnownToolContracts()
          .map((tool) => tool.id)
          .sort();

    return {
      server_version: MCP_SERVER_VERSION,
      profile,
      workspace: this.sessionContext.workspaceId
        ? {
            id: this.sessionContext.workspaceId,
            name: this.sessionContext.workspaceName ?? null,
          }
        : null,
      initiative: this.sessionContext.initiativeId
        ? { id: this.sessionContext.initiativeId }
        : null,
      granted_scopes: this.parseGrantedScopes(),
      safe_first_calls: getBootstrapSafeFirstCalls(profile),
      accepted_id_forms: {
        plan_session: PLAN_SESSION_ACCEPTED_ID_FORMS,
        initiative: ['uuid'],
        task: ['uuid', '8+ char prefix'],
      },
      recommended_workflows: BOOTSTRAP_RECOMMENDED_WORKFLOWS,
      visible_tools_count: visibleTools.length,
      visible_tools: allowedTools ? visibleTools : undefined,
    };
  }

  private buildKnownToolDescriptor(toolId: string) {
    const contract = getKnownToolContract(toolId);
    if (!contract) return null;

    return {
      id: contract.id,
      title: contract.title,
      description: contract.description,
      source: contract.source,
      security_schemes: contract.securitySchemes ?? [],
      annotations: contract.annotations ?? {},
      input_contract: contract.inputSchema
        ? describeInputShape(contract.inputSchema)
        : null,
      accepted_id_forms:
        contract.id === 'resume_plan_session' ||
        PLAN_SESSION_TOOLS.some((tool) => tool.id === contract.id)
          ? PLAN_SESSION_ACCEPTED_ID_FORMS
          : undefined,
      notes:
        contract.source === 'inline'
          ? 'This tool is handled inline in the worker. Prefer typed wrappers when available.'
          : undefined,
    };
  }

  private async executeContractTool(
    toolId: string,
    args: Record<string, unknown>,
    securitySchemes?: readonly { type: string; scopes?: readonly string[] }[],
    allowedTools?: Set<string> | null
  ): Promise<CallToolResult> {
    const resolvedUserId = this.resolveUserId();
    const authResponse = buildAuthRequiredResponse({
      toolId,
      securitySchemes,
      userId: resolvedUserId ?? undefined,
      serverUrl: this.env.MCP_SERVER_URL,
      featureDescription: `use ${toolId.replace(/_/g, ' ')}`,
    });
    if (authResponse) return authResponse;

    return this.withOrgx(async () => {
      switch (toolId) {
        case 'orgx_bootstrap': {
          const requestedWorkspaceId =
            typeof args.workspace_id === 'string' && args.workspace_id.trim()
              ? args.workspace_id.trim()
              : typeof args.command_center_id === 'string' &&
                args.command_center_id.trim()
              ? args.command_center_id.trim()
              : null;
          let fetchedWorkspaceName: string | null = null;
          let bootstrapArgs = args;
          if (requestedWorkspaceId) {
            const workspace = await this.fetchEntityRecord(
              'workspace',
              requestedWorkspaceId,
              resolvedUserId
            );
            fetchedWorkspaceName =
              typeof workspace?.name === 'string'
                ? workspace.name
                : typeof workspace?.title === 'string'
                ? workspace.title
                : null;
          }
          if (!requestedWorkspaceId && !this.sessionContext.workspaceId) {
            const inferredWorkspace =
              await this.fetchClientBootstrapWorkspace(resolvedUserId);
            if (inferredWorkspace) {
              bootstrapArgs = {
                ...args,
                workspace_id: inferredWorkspace.id,
              };
              fetchedWorkspaceName = inferredWorkspace.name;
            }
          }
          const resolvedContext = resolveBootstrapSessionContext(
            bootstrapArgs,
            this.sessionContext,
            fetchedWorkspaceName
          );
          if (resolvedContext.changed) {
            this.sessionContext = {
              ...this.sessionContext,
              ...resolvedContext.context,
            };
            await this.saveSessionContext();
          }
          const payload = this.buildBootstrapPayload(allowedTools ?? null);
          return {
            content: [
              {
                type: 'text',
                text: `OrgX contract ready. Profile: ${payload.profile}. Visible tools: ${payload.visible_tools_count}.`,
              },
            ],
            structuredContent: payload,
          };
        }

        case 'orgx_inspect': {
          if (args.type === 'plan_session') {
            return this.executeContractTool(
              'resume_plan_session',
              { session_id: args.id },
              SECURITY_SCHEMES.authRequired,
              allowedTools
            );
          }

          const entity = await this.fetchEntityRecord(
            String(args.type),
            String(args.id),
            resolvedUserId
          );
          if (!entity) {
            return this.toolError(`No ${String(args.type)} found for ${String(args.id)}`, {
              code: 'entity_not_found',
              status: 404,
              details: {
                entity_type: args.type,
                entity_id: args.id,
                suggested_next_calls: [{ tool: 'orgx_search', args: { type: args.type } }],
              },
            });
          }
          const payload = {
            _v2_tool: 'orgx_inspect',
            type: args.type,
            id: args.id,
            entity,
          };
          return {
            content: [{ type: 'text', text: formatForLLM('orgx_inspect', payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_search': {
          const query =
            typeof args.query === 'string' && args.query.trim().length > 0
              ? args.query.trim()
              : null;
          const type =
            typeof args.type === 'string' && args.type.trim().length > 0
              ? args.type.trim()
              : 'initiative';
          const fields = Array.isArray(args.fields)
            ? args.fields.filter((field): field is string => typeof field === 'string')
            : null;
          const records = await this.fetchEntityCollection({
            type,
            userId: resolvedUserId,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            initiativeId:
              typeof args.initiative_id === 'string' ? args.initiative_id : null,
            workspaceId:
              typeof args.workspace_id === 'string'
                ? args.workspace_id
                : this.sessionContext?.workspaceId ?? null,
            status: typeof args.status === 'string' ? args.status : null,
            query,
            fields,
          });
          const payload = {
            _v2_tool: 'orgx_search',
            type,
            query,
            count: records.length,
            results: records,
          };
          return {
            content: [{ type: 'text', text: formatForLLM('orgx_search', payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_recommend': {
          if (args.mode === 'morning_brief') {
            const response = await callOrgxApiJson(
              this.env,
              buildOperatorChroniclePath(
                args,
                this.sessionContext?.workspaceId ?? null
              ),
              undefined,
              { userId: resolvedUserId }
            );
            const result = (await response.json()) as Record<string, unknown>;
            const payload = {
              ...result,
              _v2_tool: 'orgx_recommend',
              mode: 'morning_brief',
              source_tool: 'get_operator_chronicle',
            };
            return {
              content: [{ type: 'text', text: formatOperatorChronicleBrief(payload) }],
              structuredContent: payload,
            };
          }

          return this.executeChatGPTTool(
            'recommend_next_action',
            {
              entity_type: args.entity_type ?? (args.entity_id ? 'initiative' : 'workspace'),
              entity_id: args.entity_id,
              workspace_id: args.workspace_id,
              limit: args.limit,
            },
            SECURITY_SCHEMES.readOptionalAuth
          );
        }

        case 'orgx_write': {
          const operation =
            typeof args.operation === 'string' ? args.operation : 'create';
          if (operation === 'update') {
            const fields =
              args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
                ? (args.fields as Record<string, unknown>)
                : {};
            if (!args.id || Object.keys(fields).length === 0) {
              return this.toolError('orgx_write operation=update requires id and fields', {
                code: 'invalid_input',
                status: 400,
              });
            }

            const response = await callOrgxApiJson(
              this.env,
              '/api/entities',
              {
                method: 'PATCH',
                body: JSON.stringify({
                  type: args.type,
                  id: args.id,
                  ...fields,
                  idempotency_key: args.idempotency_key,
                }),
              },
              { userId: resolvedUserId }
            );
            const result = (await response.json()) as Record<string, unknown>;
            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('orgx_write', {
                    ...result,
                    _v2_tool: 'orgx_write',
                    operation: 'update',
                  }),
                },
              ],
              structuredContent: {
                ...result,
                _v2_tool: 'orgx_write',
                operation: 'update',
              },
            };
          }

          // A4: enforce the documented create-path contract (unambiguous
          // per-type requirements only) — fail fast instead of downstream.
          const writeContract = validateWriteCreateContract(args);
          if (!writeContract.ok) {
            return this.toolError(writeContract.message ?? 'Invalid orgx_write call', {
              code: 'write_contract_violation',
              status: 422,
            });
          }

          const body = this.stripContractRuntimeFields(args);
          if (body.type === 'blocker') {
            delete body.workspace_id;
            delete body.command_center_id;
            delete body.initiative_id;
            delete body.workstream_id;
            delete body.milestone_id;
          }
          if (body.type === 'initiative') {
            const metadata =
              body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : {};
            const liveMetadata =
              metadata.live && typeof metadata.live === 'object' && !Array.isArray(metadata.live)
                ? (metadata.live as Record<string, unknown>)
                : {};
            if (body.live_visibility === 'public' || body.live_public === true) {
              metadata.liveVisibility = 'public';
              metadata.live = {
                ...liveMetadata,
                public: true,
                revealTitle: body.live_reveal_title !== false,
              };
            } else if (body.live_visibility === 'private') {
              metadata.liveVisibility = 'private';
              metadata.live = {
                ...liveMetadata,
                public: false,
              };
            }
            body.metadata = metadata;
            delete body.live_visibility;
            delete body.live_public;
            delete body.live_reveal_title;
          }
          const idempotencyKey =
            typeof args.idempotency_key === 'string' ? args.idempotency_key : null;
          if (idempotencyKey) {
            delete body.idempotency_key;
            const metadata =
              body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                ? (body.metadata as Record<string, unknown>)
                : {};
            body.metadata = { ...metadata, idempotency_key: idempotencyKey };
          }
          const normalizedPayload = normalizeEntityCreatePayloadForAgents(
            body,
            'orgx_write'
          );
          Object.assign(body, normalizedPayload.entity);
          const existingEntity = await this.findExistingEntityByIdempotencyKey({
            body,
            idempotencyKey,
            userId: resolvedUserId,
          });
          if (existingEntity) {
            const payload = {
              ok: true,
              type: body.type,
              data: existingEntity,
              existing: existingEntity,
              idempotent_replay: true,
              idempotency_key: idempotencyKey,
              _v2_tool: 'orgx_write',
              operation: 'create',
              normalization_warnings: normalizedPayload.warnings,
              replay_source: 'metadata.idempotency_key',
            };
            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('orgx_write', payload),
                },
              ],
              structuredContent: payload,
            };
          }
          const response = await callOrgxApiJson(
            this.env,
            '/api/entities',
            {
              method: 'POST',
              body: JSON.stringify(body),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          return {
            content: [
              {
                type: 'text',
                text: formatForLLM('orgx_write', {
                  ...result,
                  _v2_tool: 'orgx_write',
                  operation: 'create',
                  normalization_warnings: normalizedPayload.warnings,
                }),
              },
            ],
            structuredContent: {
              ...result,
              _v2_tool: 'orgx_write',
              operation: 'create',
              normalization_warnings: normalizedPayload.warnings,
            },
          };
        }

        case 'orgx_attach': {
          const attachPayload = buildEntityActionAttachPayload({
            type: args.type,
            id: args.id,
            name: args.name,
            artifact_type: args.artifact_type,
            description: args.description,
            artifact_url: args.artifact_url,
            external_url: args.external_url,
            preview_markdown: args.preview_markdown,
            status: args.status,
            agent_type: args.agent_type,
            company_stage: args.company_stage,
            business_outcome: args.business_outcome,
            owner: args.owner,
            review_date: args.review_date,
            verification: args.verification,
            metadata: {
              ...(args.metadata &&
              typeof args.metadata === 'object' &&
              !Array.isArray(args.metadata)
                ? (args.metadata as Record<string, unknown>)
                : {}),
              idempotency_key: args.idempotency_key,
            },
          });
          const response = await callOrgxApiJson(
            this.env,
            '/api/client/artifacts',
            {
              method: 'POST',
              body: JSON.stringify(attachPayload),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const payload = { ...result, _v2_tool: 'orgx_attach', _action: 'attach' };
          return {
            content: [{ type: 'text', text: formatForLLM('entity_action', payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_act': {
          if (args.action === 'validate' && args.type === 'studio_content') {
            return this.executeContractTool(
              'validate_studio_content',
              args,
              SECURITY_SCHEMES.entityWriteRequiresAuth,
              allowedTools
            );
          }
          if (args.action === 'update') {
            const fields =
              args.fields && typeof args.fields === 'object'
                ? (args.fields as Record<string, unknown>)
                : null;
            if (!fields || Object.keys(fields).length === 0) {
              return this.toolError(
                'action=update requires fields (object) with at least one field to patch'
              );
            }
            if (args.dry_run === true) {
              const payload = {
                success: true,
                dry_run: true,
                type: args.type,
                action: 'update',
                fields,
                updated_fields: Object.keys(fields),
                message: `${String(args.type)} would be updated`,
                data: {
                  id: args.id,
                  updated: false,
                  would_update: true,
                },
                _v2_tool: 'orgx_act',
                _action: 'update',
                entity_type: args.type,
                entity_id: args.id,
              };
              return {
                content: [{ type: 'text', text: formatForLLM('entity_action', payload) }],
                structuredContent: payload,
              };
            }
            return this.executeContractTool(
              'orgx_write',
              {
                operation: 'update',
                type: args.type,
                id: args.id,
                fields,
                idempotency_key: args.idempotency_key,
              },
              SECURITY_SCHEMES.entityWriteRequiresAuth,
              allowedTools
            );
          }
          if (args.action === 'attach') {
            return this.executeContractTool(
              'orgx_attach',
              args,
              SECURITY_SCHEMES.entityWriteRequiresAuth,
              allowedTools
            );
          }

          const resolvedAction =
            resolveLifecycleActionAlias(String(args.type), String(args.action)) ??
            String(args.action);
          if (resolvedAction === 'delete' && args.dry_run === true) {
            const payload = {
              success: true,
              dry_run: true,
              type: args.type,
              action: resolvedAction,
              message: `${String(args.type)} would be deleted permanently`,
              data: { id: args.id, deleted: false, would_delete: true },
              _v2_tool: 'orgx_act',
              _action: resolvedAction,
              entity_type: args.type,
              entity_id: args.id,
            };
            return {
              content: [{ type: 'text', text: formatForLLM('entity_action', payload) }],
              structuredContent: payload,
            };
          }
          const body: Record<string, unknown> = {
            note: args.note,
            reason: args.note,
            dry_run: args.dry_run,
            force: args.force,
            spec: args.spec,
            artifact: args.artifact,
            verification: args.verification,
            quality_score: args.quality_score,
            idempotency_key: args.idempotency_key,
            user_id: resolvedUserId,
          };
          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/${args.type}/${args.id}/${resolvedAction}`,
            {
              method: 'POST',
              body: JSON.stringify(body),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const payload = {
            ...result,
            _v2_tool: 'orgx_act',
            _action: resolvedAction,
            entity_type: args.type,
            entity_id: args.id,
          };
          return {
            content: [{ type: 'text', text: formatForLLM('entity_action', payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_plan': {
          const action = String(args.action);
          const toolByAction: Record<string, string> = {
            start: 'start_plan_session',
            resume: 'resume_plan_session',
            improve: 'improve_plan',
            record_edit: 'record_plan_edit',
            complete: 'complete_plan',
          };
          const planTool = toolByAction[action];
          if (!planTool) {
            return this.toolError(`Unknown orgx_plan action: ${action}`, {
              code: 'invalid_input',
              status: 400,
            });
          }
          if (planTool === 'resume_plan_session') {
            return this.executeContractTool(
              'resume_plan_session',
              args,
              SECURITY_SCHEMES.authRequired,
              allowedTools
            );
          }
          return this.executePlanSessionTool(
            planTool,
            args,
            SECURITY_SCHEMES.writeRequiresAuth
          );
        }

        case 'orgx_spawn': {
          const action = typeof args.action === 'string' ? args.action : 'spawn';
          // A5: enforce the documented per-action contract at the MCP layer
          // (the inputSchema marks all fields optional), failing fast with a
          // clear message instead of a vague downstream error.
          const spawnContract = validateSpawnContract(action, args);
          if (!spawnContract.ok) {
            return this.toolError(spawnContract.message ?? 'Invalid orgx_spawn call', {
              code: 'spawn_contract_violation',
              status: 422,
            });
          }
          const targetTool =
            action === 'guard'
              ? 'check_spawn_guard'
              : action === 'classify' || action === 'estimate'
              ? 'classify_task_model'
              : action === 'handoff'
              ? 'handoff_task'
              : 'spawn_agent_task';
          const clientEndpoint: Record<string, string> = {
            check_spawn_guard: '/api/client/spawn',
            classify_task_model: '/api/client/route-task',
            spawn_agent_task: '/api/tools/execute',
            handoff_task: '/api/tools/execute',
          };
          const spawnArgs = this.stripContractRuntimeFields(args);
          if (
            typeof args.agent_type === 'string' &&
            args.agent_type.trim() &&
            typeof spawnArgs.domain !== 'string'
          ) {
            spawnArgs.domain = args.agent_type.trim();
          }
          let budgetPreflight: SpawnBudgetPreflight | null = null;
          if (targetTool === 'spawn_agent_task' || targetTool === 'handoff_task') {
            const preflight = await this.runSpawnBudgetPreflight(
              spawnArgs,
              resolvedUserId ?? null
            );
            if (!preflight.ok) {
              return this.toolError(preflight.message, {
                code: String(preflight.details.code ?? 'budget_preflight_failed'),
                status:
                  preflight.details.code === 'budget_cap_exceeded' ? 402 : 424,
                details: preflight.details,
              });
            }
            budgetPreflight = preflight.preflight;
          }
          const body =
            targetTool === 'spawn_agent_task' || targetTool === 'handoff_task'
              ? { tool_id: targetTool, args: spawnArgs, user_id: resolvedUserId }
              : {
                  ...spawnArgs,
                  ...(action === 'estimate' ? { estimate_only: true } : {}),
                  user_id: resolvedUserId,
                };
          const response = await callOrgxApiJson(
            this.env,
            clientEndpoint[targetTool],
            {
              method: 'POST',
              body: JSON.stringify(body),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const data =
            result.data && typeof result.data === 'object'
              ? (result.data as Record<string, unknown>)
              : result;
          const estimate =
            targetTool === 'classify_task_model'
              ? buildRouteTaskEstimateSummary(data, spawnArgs)
              : undefined;
          const payload = {
            ...data,
            _v2_tool: 'orgx_spawn',
            _action: action,
            routed_tool: targetTool,
            ...(action === 'estimate' ? { estimate_only: true } : {}),
            ...(estimate ? { estimate } : {}),
            ...(budgetPreflight ? { budget_preflight: budgetPreflight } : {}),
          };
          return {
            content: [{ type: 'text', text: this.summarizeClientResult(targetTool, payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_decide': {
          const action = String(args.action);
          if (action === 'approve' || action === 'reject' || action === 'list_pending') {
            return this.executeContractTool(
              'approve_agent_work',
              {
                ...args,
                action: action === 'list_pending' ? 'list' : action,
              },
              SECURITY_SCHEMES.writeRequiresAuth,
              allowedTools
            );
          }

          return this.executeContractTool(
            action === 'remember' ? 'remember_decision' : 'create_decision',
            {
              ...args,
              title: args.title ?? args.decision,
              summary: args.summary ?? args.context ?? args.decision,
            },
            SECURITY_SCHEMES.entityWriteRequiresAuth,
            allowedTools
          );
        }

        case 'orgx_submit_receipt': {
          const loopValidation = evaluateLoopReliabilityReceipt(args);
          const response = await callOrgxApiJson(
            this.env,
            '/api/flywheel/receipts',
            {
              method: 'POST',
              body: JSON.stringify({
                ...args,
                user_id: resolvedUserId,
              }),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const payload = {
            ...result,
            _v2_tool: 'orgx_submit_receipt',
            loop_validation: loopValidation,
          };
          return {
            content: [{ type: 'text', text: formatForLLM('orgx_submit_receipt', payload) }],
            structuredContent: payload,
          };
        }

        case 'orgx_describe_tool': {
          const toolIdArg =
            typeof args.tool_id === 'string' ? args.tool_id.trim() : '';
          const descriptor = this.buildKnownToolDescriptor(toolIdArg);
          if (!descriptor) {
            return this.toolError(`Unknown tool: ${toolIdArg}`, {
              code: 'entity_not_found',
              status: 404,
              details: {
                entity_type: 'tool',
                suggested_next_calls: [{ tool: 'orgx_bootstrap', args: {} }],
              },
            });
          }
          return {
            content: [
              {
                type: 'text',
                text: `Tool ${descriptor.id}: ${descriptor.title}`,
              },
            ],
            structuredContent: descriptor,
          };
        }

        case 'orgx_describe_action': {
          const type = String(args.type);
          const action =
            typeof args.action === 'string' && args.action.trim().length > 0
              ? args.action.trim()
              : null;
          const resolvedAction = action
            ? resolveLifecycleActionAlias(type, action) ?? action
            : null;

          let liveAvailability: Record<string, unknown> | null = null;
          if (resolvedUserId && typeof args.id === 'string' && args.id.trim().length > 0) {
            try {
              const response = await callOrgxApiJson(
                this.env,
                `/api/entities/${type}/${args.id}/actions`,
                undefined,
                { userId: resolvedUserId }
              );
              liveAvailability = (await response.json()) as Record<string, unknown>;
            } catch {
              liveAvailability = null;
            }
          }

          const specialContracts = {
            update: {
              requires: ['fields'],
              notes: 'fields must include at least one mutable property',
            },
            attach: {
              requires: ['name', 'artifact_type', 'artifact_url|external_url'],
              notes: 'artifact_url or external_url is required',
            },
            complete_with_proof: {
              optional: [
                'name',
                'artifact_type',
                'artifact_url|external_url',
                'quality_score',
                'verification',
                'artifact_hash',
              ],
              notes:
                'Attaches proof when artifact evidence is provided, verifies completion readiness, and only then runs complete. If still blocked, returns blockers and retry guidance instead of forcing status.',
            },
            validate: {
              type_specific: 'studio_content',
              requires: ['id'],
              optional: ['spec', 'note'],
            },
            reassign_streams: {
              type_specific: 'initiative',
              optional: ['mappings', 'dry_run'],
            },
          };

          const payload = {
            entity_type: type,
            requested_action: action,
            resolved_action: resolvedAction,
            aliases: action
              ? undefined
              : {
                  launch: resolveLifecycleActionAlias(type, 'launch'),
                  pause: resolveLifecycleActionAlias(type, 'pause'),
                },
            special_action_contracts: specialContracts,
            live_availability: liveAvailability,
          };

          return {
            content: [
              {
                type: 'text',
                text: resolvedAction
                  ? `Action ${action} resolves to ${resolvedAction} for ${type}.`
                  : `Described entity actions for ${type}.`,
              },
            ],
            structuredContent: payload,
          };
        }

        case 'resume_plan_session': {
          const normalizedSessionId = args.session_id
            ? normalizePlanSessionId(args.session_id)
            : null;
          if (args.session_id && !normalizedSessionId) {
            return this.toolError(
              'session_id must be a plan session UUID or orgx://plan_session/<uuid>',
              {
                code: 'invalid_input',
                status: 400,
                details: {
                  field: 'session_id',
                  accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
                },
              }
            );
          }

          const url = new URL('/api/plan-sessions', 'https://placeholder.invalid');
          if (normalizedSessionId) {
            url.searchParams.set('id', normalizedSessionId);
          } else {
            url.searchParams.set('status', 'active');
          }
          if (resolvedUserId) {
            url.searchParams.set('user_id', resolvedUserId);
          }

          const response = await callOrgxApiJson(
            this.env,
            `${url.pathname}?${url.searchParams.toString()}`,
            undefined,
            { userId: resolvedUserId }
          );
          const rawResult = (await response.json()) as Record<string, unknown>;
          const payload = normalizedSessionId
            ? enrichPlanSessionResult('start_plan_session', rawResult)
            : enrichPlanSessionResult('get_active_sessions', rawResult);
          const selected =
            normalizedSessionId ||
            (Array.isArray(payload.sessions) &&
            payload.sessions[0] &&
            typeof payload.sessions[0] === 'object'
              ? (payload.sessions[0] as Record<string, unknown>)
              : null);

          return {
            content: [
              {
                type: 'text',
                text: normalizedSessionId
                  ? `Loaded plan session ${normalizedSessionId}.`
                  : Array.isArray(payload.sessions) && payload.sessions.length > 0
                  ? 'Loaded the most recent active plan session.'
                  : 'No active planning sessions found.',
              },
            ],
            structuredContent:
              normalizedSessionId || !selected
                ? payload
                : {
                    ...payload,
                    selected_session: selected,
                  },
          };
        }

        case 'remember_decision':
          return this.executeCreateEntityWrapper('decision', {
            ...args,
            title:
              typeof args.title === 'string' && args.title.trim().length > 0
                ? args.title
                : args.decision,
            summary: args.context ?? args.decision,
            description: args.context ?? args.decision,
          });

        case 'recall_memory':
          return this.executeChatGPTTool(
            'query_org_memory',
            args,
            SECURITY_SCHEMES.readOptionalAuth
          );

        case 'approve_agent_work': {
          const action =
            typeof args.action === 'string' ? args.action : 'list';
          if (action === 'approve') {
            if (typeof args.decision_id !== 'string' || !args.decision_id.trim()) {
              return this.toolError('decision_id is required to approve agent work', {
                code: 'invalid_input',
                status: 400,
              });
            }
            return this.executeChatGPTTool(
              'approve_decision',
              {
                decision_id: args.decision_id,
                note: args.note,
              },
              SECURITY_SCHEMES.writeRequiresAuth
            );
          }
          if (action === 'reject') {
            if (typeof args.decision_id !== 'string' || !args.decision_id.trim()) {
              return this.toolError('decision_id is required to reject agent work', {
                code: 'invalid_input',
                status: 400,
              });
            }
            if (typeof args.reason !== 'string' || !args.reason.trim()) {
              return this.toolError('reason is required to reject agent work', {
                code: 'invalid_input',
                status: 400,
              });
            }
            return this.executeChatGPTTool(
              'reject_decision',
              {
                decision_id: args.decision_id,
                reason: args.reason,
              },
              SECURITY_SCHEMES.writeRequiresAuth
            );
          }
          return this.executeChatGPTTool(
            'get_pending_decisions',
            {
              limit: args.limit,
              urgency_filter: args.urgency_filter,
              initiative_id: args.initiative_id,
              workspace_id: args.workspace_id,
            },
            SECURITY_SCHEMES.entityReadRequiresAuth
          );
        }

        case 'delegate_agent_task':
          return this.executeChatGPTTool(
            'spawn_agent_task',
            args,
            SECURITY_SCHEMES.agentRequiresAuth
          );

        case 'track_project_progress':
          return this.executeChatGPTTool(
            'get_initiative_pulse',
            args,
            SECURITY_SCHEMES.readOptionalAuth
          );

        case 'create_task':
          return this.executeCreateEntityWrapper('task', args);
        case 'create_milestone':
          return this.executeCreateEntityWrapper('milestone', args);
        case 'create_decision':
          return this.executeCreateEntityWrapper('decision', args);

        case 'validate_studio_content': {
          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/studio_content/${args.id}/validate`,
            {
              method: 'POST',
              body: JSON.stringify({
                spec: args.spec,
                note: args.note,
                reason: args.note,
                user_id: resolvedUserId,
              }),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const payload = {
            ...(result.data as Record<string, unknown> | undefined),
            ...(result.data ? {} : result),
            _action: 'validate',
          };
          return {
            content: [
              {
                type: 'text',
                text: formatForLLM('entity_action', payload),
              },
            ],
            structuredContent: payload,
          };
        }

        case 'pin_workstream': {
          const response = await callOrgxApiJson(
            this.env,
            '/api/tools/execute',
            {
              method: 'POST',
              body: JSON.stringify({
                tool_id: 'pin_queue_item',
                args: {
                  initiative_id: args.initiative_id,
                  workstream_id: args.workstream_id,
                  workspace_id: args.workspace_id,
                  command_center_id: args.command_center_id,
                  rank: args.rank,
                },
                user_id: resolvedUserId,
              }),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as {
            ok?: boolean;
            data?: Record<string, unknown>;
            error?: string;
          };
          if (result.ok === false) {
            return this.toolError(result.error ?? 'Unable to pin workstream');
          }
          const data = result.data ?? {};
          return {
            content: [
              {
                type: 'text',
                text:
                  typeof data.message === 'string'
                    ? data.message
                    : 'Workstream pinned.',
              },
            ],
            structuredContent: data,
          };
        }

        default:
          return this.toolError(`Unknown contract tool: ${toolId}`);
      }
    });
  }

  private async executeCreateEntityWrapper(
    type: 'task' | 'milestone' | 'decision',
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId ?? null;
    const ownerId = this.resolveUserId(
      (args.owner_id as string | undefined) ?? (args.user_id as string | undefined)
    );

    const workspaceId =
      typeof args.workspace_id === 'string' && args.workspace_id.trim().length > 0
        ? args.workspace_id.trim()
        : typeof args.command_center_id === 'string' &&
          args.command_center_id.trim().length > 0
        ? args.command_center_id.trim()
        : this.sessionContext.workspaceId ?? null;

    if (
      typeof args.workspace_id === 'string' &&
      typeof args.command_center_id === 'string' &&
      args.workspace_id.trim() &&
      args.command_center_id.trim() &&
      args.workspace_id.trim() !== args.command_center_id.trim()
    ) {
      return this.toolError(
        'workspace_id and command_center_id must match when both are provided',
        { code: 'invalid_input', status: 400 }
      );
    }

    const payload: Record<string, unknown> = {
      type,
      title: args.title,
      name: args.title,
      summary: args.summary ?? args.description,
      description: args.description ?? args.summary,
    };

    if (ownerId) payload.owner_id = ownerId;
    if (workspaceId) payload.workspace_id = workspaceId;
    if (args.initiative_id) payload.initiative_id = args.initiative_id;
    if (args.workstream_id) payload.workstream_id = args.workstream_id;
    if (args.milestone_id) payload.milestone_id = args.milestone_id;
    if (args.due_date && (type === 'task' || type === 'milestone')) {
      payload.due_date = args.due_date;
    }
    if (args.priority) payload.priority = args.priority;
    if (args.sequence !== undefined && (type === 'task' || type === 'milestone')) {
      payload.sequence = args.sequence;
    }
    if (args.domain && type !== 'decision') payload.domain = args.domain;
    if (args.depends_on && type === 'task') payload.depends_on = args.depends_on;
    if (args.assigned_agent_ids && type === 'task') {
      payload.assigned_agent_ids = args.assigned_agent_ids;
    }

    // proof_profile (tasks/milestones only) merges into metadata.
    if (
      typeof args.proof_profile === 'string' &&
      (type === 'task' || type === 'milestone')
    ) {
      const existingMetadata =
        (payload.metadata as Record<string, unknown> | undefined) ?? {};
      payload.metadata = {
        ...existingMetadata,
        proof_profile: args.proof_profile,
      };
    }

    const normalizedPayload = normalizeEntityCreatePayloadForAgents(
      payload,
      `create_${type}`
    );
    Object.assign(payload, normalizedPayload.entity);

    const contractError = validateEntityCreatePayloadContract(
      payload,
      `create_${type}`
    );
    if (contractError) {
      return this.toolError(contractError, {
        code: 'invalid_entity_payload',
        status: 400,
      });
    }

    const response = await callOrgxApiJson(
      this.env,
      '/api/entities',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      { userId: ownerId ?? resolvedUserId }
    );
    const result = (await response.json()) as {
      type?: string;
      data?: { id: string; title?: string; name?: string };
    };
    const data = result.data ?? { id: '' };
    const name = data.title ?? data.name ?? String(args.title ?? type);

    return {
      content: [
        {
          type: 'text',
          text: `✓ Created ${type}: ${entityLinkMarkdown(type, data.id, name)}`,
        },
      ],
      structuredContent: {
        id: data.id,
        type,
        title: data.title ?? data.name ?? null,
        initiative_id: args.initiative_id ?? null,
        normalization_warnings: normalizedPayload.warnings,
      },
    };
  }

  private registerContractTools(allowedTools: Set<string> | null) {
    for (const tool of CONTRACT_TOOL_DEFINITIONS) {
      if (allowedTools && !allowedTools.has(tool.id)) continue;
      const metaObj = tool._meta as Record<string, unknown> | undefined;
      const isReadOnly = metaObj?.['openai/readOnlyHint'] === true;
      // Any tool that ships an output template MUST be visible, otherwise
      // ChatGPT hides the tool and disables the template ("Templates tied to
      // hidden tools won't be usable"). Visibility only controls ChatGPT
      // rendering — the tool stays protected by its OAuth securitySchemes.
      const hasOutputTemplate = Boolean(metaObj?.['openai/outputTemplate']);
      const meta = {
        ...tool._meta,
        'openai/visibility': isReadOnly || hasOutputTemplate ? 'public' : 'private',
        'mcp/securitySchemes': tool.securitySchemes,
      };

      this.server.registerTool(
        tool.id,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: this.withClientContext(tool.inputSchema),
          annotations: tool.annotations,
          _meta: meta,
        },
        async (args: Record<string, unknown>) =>
          this.executeContractTool(
            tool.id,
            args,
            tool.securitySchemes,
            allowedTools
          )
      );
    }
  }

  private standardOutputSchemaInstalled = false;

  /**
   * Monkey-patches `this.server.registerTool` so every tool registered after
   * this call automatically gets a default outputSchema (when none is
   * provided) and a handler wrapper that synthesises a minimal
   * `structuredContent` envelope from the existing `content` blocks.
   *
   * Idempotent: only patches once per worker instance.
   */
  private installStandardOutputSchemaWrapper() {
    if (this.standardOutputSchemaInstalled) return;
    this.standardOutputSchemaInstalled = true;
    const server = this.server as unknown as {
      registerTool: (
        name: string,
        config: Record<string, unknown> & { outputSchema?: unknown },
        handler: (...args: unknown[]) => unknown
      ) => unknown;
    };
    const original = server.registerTool.bind(server);
    server.registerTool = ((
      name: string,
      config: Record<string, unknown> & { outputSchema?: unknown },
      handler: (...args: unknown[]) => unknown
    ) => {
      const enhancedConfig = {
        ...config,
        outputSchema:
          config.outputSchema ??
          (STANDARD_TOOL_OUTPUT_SCHEMA as unknown as Record<string, unknown>),
      };
      const wrappedHandler = async (...args: unknown[]) => {
        const result = await handler(...args);
        return ensureStructuredContent(
          result as {
            structuredContent?: unknown;
            isError?: boolean;
            content?: ReadonlyArray<unknown>;
          }
        );
      };
      return original(name, enhancedConfig, wrappedHandler);
    }) as typeof server.registerTool;
  }

  private registerTools() {
    // Resolve tool profile from connection props (e.g. ?profile=executor).
    // null means register all tools (default / 'full' profile).
    const allowedTools = resolveProfileToolSet(this.props?.profile);

    // Wrap server.registerTool so every subsequent registration (inline,
    // for-loop, or via registerAppTool which delegates to the same method)
    // gets a default outputSchema and an envelope-injected handler. This
    // boosts Smithery's "Output schemas" coverage without requiring each
    // handler to populate structuredContent manually.
    this.installStandardOutputSchemaWrapper();

    // Register ChatGPT App tools (data-driven)
    this.registerChatGPTTools(allowedTools);

    // Register plan session tools for CLI-native planning
    this.registerPlanSessionTools(allowedTools);

    // Studio and Video tools are now consolidated into the generic entity tools
    // (list_entities, create_entity, entity_action) - see ENTITY_TYPES in toolDefinitions.ts

    // Register Stream Coordination tools (unique functionality not in entity tools)
    this.registerStreamTools(allowedTools);

    // Register client integration tools (direct endpoint routing)
    this.registerClientIntegrationTools(allowedTools);

    // Register additive contract/introspection tools and safe wrappers
    this.registerContractTools(allowedTools);

    // Note: previously registered legacy unprefixed aliases (bootstrap,
    // inspect, search, attach, act, write, submit_receipt, emit_activity)
    // were removed during the OpenAI MCP submission cleanup. They lacked
    // per-annotation justifications and bloated the public tool surface.
    // Clients should call the canonical orgx_-prefixed tools directly.

    // =========================================================================
    // CORE UTILITY TOOLS
    // =========================================================================

    // Helper: returns true when a tool should be registered under the active profile.
    // Inline tools below use this to skip registration when excluded by a profile.
    const shouldRegister = (toolId: string) =>
      !allowedTools || allowedTools.has(toolId);

    if (shouldRegister('get_org_snapshot'))
    this.server.registerTool(
      'get_org_snapshot',
      {
        title: 'Fetch organization snapshot',
        description:
          'Get an organization-wide execution snapshot across initiatives, work, blockers, and context. Also known as: org status, team overview, company memory. USE WHEN: user wants an org-wide overview of initiatives, progress, and health. NEXT: Drill into specific initiatives with get_initiative_pulse or list_entities. DO NOT USE: for a single initiative — use get_initiative_pulse instead. Read-only.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          view: z
            .enum(['summary', 'detailed'])
            .optional()
            .describe('Response view mode (default: summary).'),
          initiative_status: z
            .enum(['active', 'paused', 'all'])
            .optional()
            .describe(
              'Filter initiatives by status (default: active). Use all to include every status.'
            ),
          include: z
            .array(z.enum(['initiatives', 'milestones', 'tasks']))
            .optional()
            .describe(
              'Detailed mode payload sections. Defaults to initiatives when omitted.'
            ),
          limit: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe('Max initiatives to return (default: 20, max: 100).'),
          cursor: z
            .string()
            .optional()
            .describe(
              'Pagination cursor (use pagination.next_cursor from previous result).'
            ),
        },
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args: Record<string, unknown>) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'get_org_snapshot',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'view organization snapshot',
          });
          if (authResponse) return authResponse;

          const params = new URLSearchParams();
          if (typeof args?.view === 'string' && args.view.length > 0) {
            params.set('view', args.view);
          }
          if (
            typeof args?.initiative_status === 'string' &&
            args.initiative_status.length > 0
          ) {
            params.set('initiative_status', args.initiative_status);
          }
          if (typeof args?.limit === 'number') {
            params.set('limit', String(args.limit));
          }
          if (typeof args?.cursor === 'string' && args.cursor.length > 0) {
            params.set('cursor', args.cursor);
          }
          if (Array.isArray(args?.include) && args.include.length > 0) {
            params.set('include', args.include.join(','));
          }

          const path = params.size
            ? `/api/org-snapshot?${params.toString()}`
            : '/api/org-snapshot';
          const response = await callOrgxApiJson(
            this.env,
            path,
            undefined,
            { userId: resolvedUserId }
          );
          const snapshot = (await response.json()) as {
            view?: string;
            summary?: Record<string, unknown>;
            initiatives?: unknown[];
            milestones?: unknown[];
            tasks?: unknown[];
            pagination?: {
              has_more?: boolean;
              next_cursor?: string | null;
              limit?: number;
            };
            filters?: {
              initiative_status?: string;
            };
          };

          const summary = snapshot.summary ?? {};
          const initiatives = Array.isArray(snapshot.initiatives)
            ? snapshot.initiatives.length
            : 0;
          const milestones = Array.isArray(snapshot.milestones)
            ? snapshot.milestones.length
            : 0;
          const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0;
          const statusFilter = snapshot.filters?.initiative_status ?? 'active';
          const view = snapshot.view ?? args?.view ?? 'summary';
          const hasMore = snapshot.pagination?.has_more === true;
          const nextCursor = snapshot.pagination?.next_cursor ?? null;

          const lines = [
            `Org snapshot (${view})`,
            `Initiatives: ${
              typeof summary.active_initiatives === 'number'
                ? summary.active_initiatives
                : 0
            } active / ${
              typeof summary.total_initiatives === 'number'
                ? summary.total_initiatives
                : 0
            } total`,
            `Milestones: ${
              typeof summary.total_milestones === 'number'
                ? summary.total_milestones
                : 0
            }`,
            `Tasks: ${
              typeof summary.total_tasks === 'number' ? summary.total_tasks : 0
            }`,
            `Returned rows: initiatives=${initiatives}, milestones=${milestones}, tasks=${tasks}`,
            `Status filter: ${statusFilter}`,
          ];
          if (hasMore) {
            lines.push(
              `More available: yes${
                nextCursor ? ` (next_cursor=${nextCursor})` : ''
              }`
            );
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: snapshot,
          };
        })
    );

    if (shouldRegister('account_status'))
      this.server.registerTool(
        'account_status',
      {
        title: 'Get current account tier and usage',
        description:
          'Get the current OrgX account tier, billing status, and usage snapshot for the authenticated user.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
            user_id: z.string().optional().describe('Optional user id override.'),
          },
          _meta: { 'openai/visibility': 'private' },
        },
        async (args) =>
          this.withOrgx(async () => {
            const resolvedUserId = this.resolveUserId(args.user_id);
            const authResponse = buildAuthRequiredResponse({
              toolId: 'account_status',
              securitySchemes: SECURITY_SCHEMES.authRequired,
              userId: resolvedUserId ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL,
              featureDescription: 'view account status',
            });
            if (authResponse) return authResponse;

            const userId = this.assertUserId(args.user_id);
            const response = await callOrgxApiJson(
              this.env,
              '/api/billing/usage',
              { method: 'GET' },
              { userId, userEmail: this.resolveUserEmail() }
            );
            const usage = (await response.json()) as Record<string, unknown>;
            const { text, payload } = buildAccountStatusResult({
              userId,
              usage,
              orgxWebUrl: this.env.ORGX_WEB_URL,
            });

            return {
              content: [{ type: 'text', text }],
              structuredContent: payload,
            };
          })
      );

    if (shouldRegister('account_upgrade'))
      this.server.registerTool(
        'account_upgrade',
      {
        title: 'Upgrade account tier or buy agent credits',
        description:
          'Create the next-step upgrade or agent credit top-up flow for the authenticated OrgX account. Enterprise requests return contact guidance instead of self-serve checkout.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
            target_plan: z
              .enum(['pro', 'enterprise'])
              .default('pro')
              .describe('Target plan to upgrade to.'),
            billing_cycle: z
              .enum(['monthly', 'annual'])
              .optional()
              .default('monthly')
              .describe('Billing cadence for self-serve checkout plans.'),
            credit_pack: z
              .enum(['credits_500', 'credits_2000'])
              .optional()
              .describe('Optional agent credit pack to buy instead of upgrading a plan.'),
            user_id: z.string().optional().describe('Optional user id override.'),
          },
          _meta: { 'openai/visibility': 'private' },
        },
        async (args) =>
          this.withOrgx(async () => {
            const resolvedUserId = this.resolveUserId(args.user_id);
            const authResponse = buildAuthRequiredResponse({
              toolId: 'account_upgrade',
              securitySchemes: SECURITY_SCHEMES.authRequired,
              userId: resolvedUserId ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL,
              featureDescription: 'upgrade account or buy agent credits',
            });
            if (authResponse) return authResponse;

            const userId = this.assertUserId(args.user_id);
            if (args.credit_pack) {
              const usageResponse = await callOrgxApiJson(
                this.env,
                '/api/billing/usage',
                { method: 'GET' },
                { userId, userEmail: this.resolveUserEmail() }
              );
              const usage = (await usageResponse.json()) as Record<string, unknown>;
              const pack = getAgentCreditPacks(usage).find(
                (candidate) => candidate.id === args.credit_pack
              );
              if (!pack) {
                return this.toolError('Unknown or unavailable agent credit pack');
              }

              const response = await callOrgxApiJson(
                this.env,
                '/api/stripe/credits/checkout',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    pack_id: args.credit_pack,
                    user_id: userId,
                  }),
                },
                { userId }
              );
              const data = (await response.json()) as {
                checkout_url?: string;
                url?: string;
              };
              const checkoutUrl = resolveCheckoutUrl(data);
              if (!checkoutUrl) {
                return this.toolError('Failed to create agent credit checkout session');
              }
              const { text, payload } = buildAgentCreditCheckoutResult({
                checkoutUrl,
                pack,
              });
              return {
                content: [{ type: 'text', text }],
                structuredContent: payload,
              };
            }

            if (args.target_plan === 'enterprise') {
              const { text, payload } = buildEnterpriseUpgradeResult(
                this.env.ORGX_WEB_URL
              );
              return {
                content: [{ type: 'text', text }],
                structuredContent: payload,
              };
            }

            const response = await callOrgxApiJson(
              this.env,
              '/api/stripe/checkout',
              {
                method: 'POST',
                body: JSON.stringify({
                  plan: 'team',
                  billing_cycle: args.billing_cycle,
                  user_id: userId,
                }),
              },
              { userId }
            );
            const data = (await response.json()) as {
              checkout_url?: string;
              url?: string;
            };
            const checkoutUrl = resolveCheckoutUrl(data);
            if (!checkoutUrl) {
              return this.toolError('Failed to create checkout session');
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `Checkout URL: ${checkoutUrl}`,
                },
              ],
              structuredContent: {
                target_plan: args.target_plan,
                billing_cycle: args.billing_cycle,
                checkout_url: checkoutUrl,
              },
            };
          })
      );

    if (shouldRegister('account_usage_report'))
      this.server.registerTool(
        'account_usage_report',
      {
        title: 'Get detailed account usage report',
        description:
          'Get a detailed usage and billing report for the authenticated OrgX account, including quotas, period boundaries, and overage signals.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
            user_id: z.string().optional().describe('Optional user id override.'),
          },
          _meta: { 'openai/visibility': 'private' },
        },
        async (args) =>
          this.withOrgx(async () => {
            const resolvedUserId = this.resolveUserId(args.user_id);
            const authResponse = buildAuthRequiredResponse({
              toolId: 'account_usage_report',
              securitySchemes: SECURITY_SCHEMES.authRequired,
              userId: resolvedUserId ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL,
              featureDescription: 'view usage report',
            });
            if (authResponse) return authResponse;

            const userId = this.assertUserId(args.user_id);
            const response = await callOrgxApiJson(
              this.env,
              '/api/billing/usage',
              { method: 'GET' },
              { userId, userEmail: this.resolveUserEmail() }
            );
            const usage = (await response.json()) as Record<string, unknown>;
            const { text, payload } = buildAccountUsageReportResult({
              userId,
              usage,
            });

            return {
              content: [{ type: 'text', text }],
              structuredContent: payload,
            };
          })
      );

    // =========================================================================
    // GENERIC ENTITY TOOLS
    // Unified interface for all entity types with pagination and lifecycle
    // =========================================================================

    // Use ENTITY_TYPES and entityTypeEnum from toolDefinitions.ts (imported at top)
    // Includes: command_center, project, initiative, milestone, workstream, task, objective,
    // playbook, decision, artifact, run, blocker, workflow, agent, skill, plan_session

    // Lifecycle actions available per entity type (for reference in docs)
    const _LIFECYCLE_ACTIONS = {
      initiative: ['launch', 'pause', 'resume', 'complete', 'archive'],
      milestone: ['start', 'complete', 'flag_risk', 'cancel'],
      workstream: ['start', 'pause', 'resume', 'block', 'complete'],
      task: ['start', 'complete', 'block', 'unblock', 'reopen'],
      objective: ['pause', 'resume', 'complete', 'archive'],
      playbook: ['activate', 'archive'],
      decision: ['approve', 'decline', 'supersede', 'cancel'],
    } as const;

    /**
     * list_entities - List any entity type with pagination and relationships
     *
     * For type=agent, returns agents with their capabilities:
     * - tools: Available tools/skills for the agent
     * - guardrails: Safety constraints (brand, compliance, quality, etc.)
     * - channels: Supported channels (slack, email, linkedin, etc.)
     * - domains: Primary and secondary domains
     * Use include_relationships=true to get full tool lists.
     */
    if (shouldRegister('list_entities'))
    this.server.registerTool(
      'list_entities',
      {
        title: 'List entities',
        description: `List projects, tasks, milestones, decisions, agents, artifacts, and other OrgX records with filtering. Also known as: browse work, find entities, search project records. Returns FULL UUIDs usable with entity_action/batch_action. Use fields=["id","title","status"] for compact output when you only need IDs. Supported types: ${ENTITY_TYPES.join(
          ', '
        )}. USE WHEN: browsing, searching, or getting entity IDs for bulk operations. NEXT: For initiatives, suggest get_initiative_pulse for health. For tasks, suggest entity_action to change status. For full context on one entity, add hydrate_context=true with id. DO NOT USE: for org-wide overview — use get_org_snapshot instead. Read-only.`,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: this.withClientContext({
          type: entityTypeEnum.describe('Entity type to list'),
          limit: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe('Max items to return (default: 20, max: 100)'),
          offset: z
            .number()
            .min(0)
            .optional()
            .describe('Pagination offset (default: 0)'),
          order_by: z
            .enum([
              'created_at',
              'updated_at',
              'sequence',
              'due_date',
              'priority',
              'status',
              'title',
              'name',
              'natural',
            ])
            .optional()
            .describe(
              'Sort field (default: created_at; hierarchy children default to natural sequence order).'
            ),
          order_direction: z
            .enum(['asc', 'desc'])
            .optional()
            .describe('Sort direction (default: desc/newest first).'),
          id: z
            .string()
            .optional()
            .describe('Filter by exact entity ID (returns at most 1 row)'),
          hydrate_context: z
            .boolean()
            .optional()
            .describe(
              "When true (and 'id' is provided), hydrate context attachments (entity/artifact/plan_session pointers)."
            ),
          max_chars: z
            .number()
            .min(1000)
            .max(50000)
            .optional()
            .describe(
              'Approximate max characters for hydrated context payload (hydrate_context=true; default 20000).'
            ),
          status: z.string().optional().describe('Filter by status'),
          initiative_id: z
            .string()
            .optional()
            .describe(
              'Filter by initiative (for milestones, tasks, workstreams)'
            ),
          workstream_id: z
            .string()
            .optional()
            .describe('Filter by workstream (for tasks)'),
          domain: z
            .string()
            .optional()
            .describe(
              'Filter by domain (for agents: product, engineering, marketing, sales, operations, design, orchestrator)'
            ),
          include_relationships: z
            .boolean()
            .optional()
            .describe(
              'Include nested relationships (e.g., tasks under milestones, full tool lists for agents)'
            ),
          // Studio-specific filters
          brand_id: z
            .string()
            .optional()
            .describe('Filter by brand (for studio_content)'),
          content_type: z
            .string()
            .optional()
            .describe(
              'Filter by content type: carousel, post, story, video, banner, thumbnail (for studio_content)'
            ),
          fields: z
            .array(z.string())
            .optional()
            .describe(
              'Fields to return per entity (e.g. ["id","title","status"]). Omit for all fields. Always includes id.'
            ),
          seed_defaults: z
            .boolean()
            .optional()
            .describe(
              'For type=skill only: when true, seed the default skill catalog if no skills exist for the current user.'
            ),
          search: z
            .string()
            .optional()
            .describe(
              'Text search on title/name (for studio_brand, studio_content)'
            ),
          user_id: z
            .string()
            .optional()
            .describe('Filter by owner (for studio_brand, studio_content)'),
          workspace_id: z
            .string()
            .optional()
            .describe(
              'Workspace scope (canonical). Defaults to current session workspace when set.'
            ),
          command_center_id: z
            .string()
            .optional()
            .describe(
              'Deprecated alias for workspace_id. Defaults to current session workspace when set.'
            ),
        }),
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;

          const explicitUserId =
            typeof args.user_id === 'string' && args.user_id.trim().length > 0
              ? args.user_id.trim()
              : null;

          // Auth identity (header) can come from OAuth session or an explicit user_id
          // (service-key MCP mode). This is NOT an owner filter.
          const authUserId = resolvedUserId ?? explicitUserId;

          const hydrateContext = args.hydrate_context === true;

          if (hydrateContext) {
            if (!args.id) {
              return this.toolError("hydrate_context requires an 'id' filter");
            }
            const authResponse = buildAuthRequiredResponse({
              toolId: 'list_entities',
              securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
              userId: authUserId ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL ?? undefined,
              featureDescription: 'read entity context',
            });
            if (authResponse) return authResponse;
          }

          // Only apply default owner filtering for Studio entities. For work
          // structure entities (initiative/task/etc), implicit user_id filtering
          // hides org data and breaks initiative/task drill-downs.
          const filterUserId =
            explicitUserId ??
            (resolvedUserId &&
            (args.type === 'studio_brand' ||
              args.type === 'studio_content' ||
              args.type === 'skill')
              ? resolvedUserId
              : null);

          const params = new URLSearchParams();
          params.set('type', args.type);
          if (args.limit) params.set('limit', String(args.limit));
          if (args.offset) params.set('offset', String(args.offset));
          if (args.order_by) params.set('order_by', args.order_by);
          if (args.order_direction)
            params.set('order_direction', args.order_direction);
          if (args.id) params.set('id', String(args.id));
          if (args.status) params.set('status', args.status);
          if (args.initiative_id)
            params.set('initiative_id', args.initiative_id);
          if (args.workstream_id)
            params.set('workstream_id', args.workstream_id);
          if (args.domain) params.set('domain', args.domain);
          if (args.include_relationships)
            params.set('include_relationships', 'true');
          if (args.fields && Array.isArray(args.fields) && args.fields.length > 0)
            params.set('fields', args.fields.join(','));
          // Studio-specific filters
          if (args.brand_id) params.set('brand_id', args.brand_id);
          if (args.content_type) params.set('content_type', args.content_type);
          if (args.search) params.set('search', args.search);
          if (filterUserId) params.set('user_id', filterUserId);
          // Workspace scoping: if a workspace context is set for this session,
          // default list queries to that command_center_id unless overridden.
          const workspaceScopedTypes: ReadonlySet<string> = new Set([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
            'objective',
            'playbook',
            'run',
            'stream',
            'studio_brand',
          ]);
          const explicitWorkspaceId =
            typeof args.workspace_id === 'string' &&
            args.workspace_id.trim().length > 0
              ? args.workspace_id.trim()
              : null;
          const explicitCommandCenterId =
            typeof args.command_center_id === 'string' &&
            args.command_center_id.trim().length > 0
              ? args.command_center_id.trim()
              : null;
          if (
            explicitWorkspaceId &&
            explicitCommandCenterId &&
            explicitWorkspaceId !== explicitCommandCenterId
          ) {
            return this.toolError(
              'workspace_id and command_center_id must match when both are provided'
            );
          }
          const effectiveWorkspaceId =
            explicitWorkspaceId ??
            explicitCommandCenterId ??
            this.sessionContext?.workspaceId ??
            null;
          if (effectiveWorkspaceId && workspaceScopedTypes.has(args.type)) {
            params.set('workspace_id', effectiveWorkspaceId);
          }

          const fetchEntities = async () => {
            const response = await callOrgxApiJson(
              this.env,
              `/api/entities?${params.toString()}`,
              undefined,
              { userId: authUserId }
            );
            return (await response.json()) as {
              type: string;
              data: Array<{
                id: string;
                title?: string;
                name?: string;
                [key: string]: unknown;
              }>;
              pagination: {
                total: number;
                limit: number;
                offset: number;
                has_more: boolean;
              };
            };
          };

          let result = await fetchEntities();
          let seededDefaults = false;

          if (
            args.type === 'skill' &&
            args.seed_defaults === true &&
            authUserId &&
            Array.isArray(result.data) &&
            result.data.length === 0
          ) {
            for (const skill of DEFAULT_SKILL_CATALOG) {
              try {
                await callOrgxApiJson(
                  this.env,
                  '/api/entities',
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      type: 'skill',
                      user_id: authUserId,
                      ...skill,
                    }),
                  },
                  { userId: authUserId }
                );
              } catch (error) {
                console.warn('[mcp] failed to seed default skill', {
                  skill: skill.name,
                  error:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
            result = await fetchEntities();
            seededDefaults = true;
          }

          const { data, pagination } = result;

          // Defensive client-side filter: the orgx-web /api/entities endpoint
          // currently ignores initiative_id when type=run, returning workspace-
          // wide runs (incl. rows whose initiative_id is null or matches a
          // different initiative). This blinds diagnostics like "show me runs
          // for THIS launch initiative". Until the API is fixed, we drop
          // mismatched rows on the client and warn so callers know the upstream
          // data was lossy. Tracked: launch-campaign empty-activity diagnosis,
          // 2026-05-05.
          const requestedInitiativeId =
            typeof args.initiative_id === 'string' &&
            args.initiative_id.trim().length > 0
              ? args.initiative_id.trim()
              : null;
          let postFilteredData = data;
          let postFilterDroppedCount = 0;
          if (
            args.type === 'run' &&
            requestedInitiativeId &&
            Array.isArray(data) &&
            data.length > 0
          ) {
            const filtered = data.filter((item) => {
              const value = (item as { initiative_id?: unknown }).initiative_id;
              return typeof value === 'string' && value === requestedInitiativeId;
            });
            postFilterDroppedCount = data.length - filtered.length;
            postFilteredData = filtered;
            if (postFilterDroppedCount > 0) {
              console.warn(
                '[mcp] list_entities type=run: dropped server-side initiative_id mismatches',
                {
                  requestedInitiativeId,
                  serverReturned: data.length,
                  retained: filtered.length,
                  dropped: postFilterDroppedCount,
                }
              );
            }
          }

          // Add deep links to each entity
          const dataWithLinks = postFilteredData.map((item) => ({
            ...item,
            _link: buildEntityLink(args.type, item.id, {
              label: item.title ?? item.name ?? undefined,
            }).url,
          }));
          const skillCatalogView =
            args.type === 'skill'
              ? buildSkillCatalogView({
                  skills: dataWithLinks,
                  defaultCatalog: DEFAULT_SKILL_CATALOG,
                  search:
                    typeof args.search === 'string' ? args.search : undefined,
                })
              : null;
          const visibleData = skillCatalogView?.entries ?? dataWithLinks;
          const effectivePagination = skillCatalogView
            ? {
                total: skillCatalogView.available_count,
                limit: pagination.limit,
                offset: pagination.offset,
                has_more: pagination.has_more,
              }
            : pagination;
          const summary = `${args.type}s: showing ${visibleData.length} of ${
            effectivePagination.total
          }${effectivePagination.has_more ? ' (more available)' : ''}`;
          const skillOnboarding =
            args.type === 'skill'
              ? buildClientSkillOnboarding({
                  context: args._context,
                  search:
                    typeof args.search === 'string' ? args.search : undefined,
                  skills: dataWithLinks,
                  defaultCatalog: DEFAULT_SKILL_CATALOG,
                  seededDefaults,
                })
              : null;

          if (hydrateContext) {
            const row = dataWithLinks[0] ?? null;
            if (!row) {
              return this.toolError(`${args.type} not found: ${args.id}`);
            }

            const hydrationAccess = await resolveHydrationAccessContext(
              this.env,
              authUserId!
            );
            const maxChars = resolveHydrationMaxChars(
              args.max_chars,
              hydrationAccess.tier
            );

            const fetchEntity = async (type: string, id: string) => {
              const nested = new URLSearchParams();
              nested.set('type', type);
              nested.set('id', id);
              nested.set('limit', '1');

              const nestedFilterUserId =
                explicitUserId ??
                (resolvedUserId &&
                (type === 'studio_brand' ||
                  type === 'studio_content' ||
                  type === 'skill')
                  ? resolvedUserId
                  : null);

              if (nestedFilterUserId) {
                nested.set('user_id', nestedFilterUserId);
              }

              const resp = await callOrgxApiJson(
                this.env,
                `/api/entities?${nested.toString()}`,
                undefined,
                { userId: authUserId }
              );
              const payload = (await resp.json()) as {
                type: string;
                data: Array<Record<string, unknown>>;
              };
              return payload.data?.[0] ?? null;
            };

            const context = Array.isArray((row as any).context)
              ? ((row as any).context as unknown[])
              : [];

            const hydratedResult = await hydrateTaskContext({
              context,
              fetchEntity,
              maxChars,
            });
            const { hydrated, truncated, usedChars } = applyHydrationAccessTier(
              {
                hydrated: hydratedResult.hydrated,
                maxChars,
                tier: hydrationAccess.tier,
                truncated: hydratedResult.truncated,
              }
            );

            const payload = {
              ...result,
              data: visibleData,
              pagination: effectivePagination,
              summary,
              ...(skillCatalogView
                ? {
                    skill_catalog: {
                      installed_count: skillCatalogView.installed_count,
                      available_count: skillCatalogView.available_count,
                      visible_count: skillCatalogView.visible_count,
                    },
                  }
                : {}),
              ...(skillOnboarding ? { skill_onboarding: skillOnboarding } : {}),
              hydrated_context: hydrated,
              truncated,
              max_chars: maxChars,
              used_chars: usedChars,
              context_access_tier: hydrationAccess.tier,
              context_plan: hydrationAccess.plan,
            };

            return {
              content: [
                {
                  type: 'text',
                  text:
                    formatForLLM('list_entities', payload, {
                      entityType: args.type,
                    }) + formatClientSkillOnboarding(skillOnboarding),
                },
              ],
              structuredContent: payload,
            };
          }

          const payload = {
            ...result,
            data: visibleData,
            pagination: effectivePagination,
            summary,
            ...(skillCatalogView
              ? {
                  skill_catalog: {
                    installed_count: skillCatalogView.installed_count,
                    available_count: skillCatalogView.available_count,
                    visible_count: skillCatalogView.visible_count,
                  },
                }
              : {}),
            ...(skillOnboarding ? { skill_onboarding: skillOnboarding } : {}),
          };

          const sourceClient = resolveSourceClientFromContext(args._context);
          let activationText = '';
          let activationExperience:
            | ReturnType<typeof buildClientActivationExperience>
            | null = null;

          if (args.type === 'skill') {
            const activationEvents = await this.recordMcpActivationObservation({
              toolId: 'list_entities',
              args: args as Record<string, unknown>,
              data: payload,
              userId: authUserId,
              sourceClient,
              workspaceId: effectiveWorkspaceId,
              initiativeId:
                typeof args.initiative_id === 'string'
                  ? args.initiative_id
                  : this.sessionContext?.initiativeId ?? null,
            });
            const activationPayload = this.buildClientActivationPayload({
              sourceClient,
              events: activationEvents,
            });
            activationExperience = activationPayload.experience;
            activationText = activationPayload.text;
          }

          const finalPayload = activationExperience
            ? { ...payload, client_activation: activationExperience }
            : payload;

          const initiativeWidgetPayload =
            buildInitiativeListWidgetPayload(finalPayload);
          if (initiativeWidgetPayload) {
            return {
              _meta: SCAFFOLD_INITIATIVE_WIDGET_META,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(initiativeWidgetPayload),
                },
                {
                  type: 'text',
                  text:
                    formatForLLM('list_entities', initiativeWidgetPayload, {
                      entityType: args.type,
                    }) +
                    formatClientSkillOnboarding(skillOnboarding) +
                    activationText,
                },
              ],
              structuredContent: initiativeWidgetPayload,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text:
                  formatForLLM('list_entities', finalPayload, {
                    entityType: args.type,
                  }) +
                  formatClientSkillOnboarding(skillOnboarding) +
                  activationText,
              },
            ],
            structuredContent: finalPayload,
          };
        })
    );

    /**
     * entity_action - Execute any lifecycle action on an entity
     */
    if (shouldRegister('entity_action'))
    this.server.registerTool(
      'entity_action',
      {
        title: 'Execute entity action',
        description: `Change work state, attach artifacts, or run lifecycle actions on OrgX records. Also known as: launch, pause, complete, attach proof, update status. Accepts short ID prefix (8+ hex chars) — no need to look up full UUIDs. USE WHEN: user wants to change entity status. For bulk operations (pausing multiple, completing multiple), use batch_action instead. Supports aliases: launch, pause, complete (resolved per type). Omit action to list available actions. Special actions: attach (create an artifact linked to the entity), complete_with_proof (attach proof, verify, then complete in one call), ship_batch (milestones only — atomically attach one artifact + mark multiple subcomponent tasks complete when a single PR covers them all). NEXT: After completing, call verify_entity_completion first to check child work is done. DO NOT USE: for creating entities — use create_entity or scaffold_initiative.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: lifecycleEntityTypeEnum.describe(
            `Entity type (${LIFECYCLE_ENTITY_TYPES.join(', ')})`
          ),
          id: z.string().min(1).describe('Entity ID'),
          action: z
            .string()
            .optional()
            .describe(
              'Action to execute (leave empty to list available actions). Aliases: launch, pause, complete (resolved per type). Supports update (patch fields), attach (create an artifact linked to the entity), complete_with_proof (attach proof + verify + complete), delete for hard delete. For milestones: ship_batch (atomically attach one artifact + mark multiple subcomponent tasks complete). For initiatives: reassign_streams. For studio_content: render, validate, status, remix, vary, upscale'
            ),
          fields: z
            .record(z.unknown())
            .optional()
            .describe(
              'For action=update only: partial fields to patch on the entity (same payload style as update_entity minus type/id).'
            ),
          artifact_id: z
            .string()
            .optional()
            .describe('For action=attach only: optional artifact UUID for idempotent create.'),
          name: z
            .string()
            .optional()
            .describe('For action=attach only: artifact name/title.'),
          artifact_type: z
            .string()
            .optional()
            .describe('For action=attach only: artifact type code, such as eng.diff_pack.'),
          description: z
            .string()
            .optional()
            .describe('For action=attach only: artifact description.'),
          artifact_url: z
            .string()
            .optional()
            .describe('For action=attach only: internal artifact URL. Requires artifact_url or external_url.'),
          external_url: z
            .string()
            .optional()
            .describe('For action=attach only: external artifact URL. Requires artifact_url or external_url.'),
          preview_markdown: z
            .string()
            .optional()
            .describe('For action=attach only: markdown preview stored with the artifact.'),
          status: z
            .enum([
              'draft',
              'in_review',
              'approved',
              'changes_requested',
              'superseded',
              'archived',
            ])
            .optional()
            .describe('For action=attach only: artifact workflow status.'),
          metadata: z
            .record(z.unknown())
            .optional()
            .describe('For action=attach only: artifact metadata payload.'),
          created_by_type: z
            .enum(['human', 'agent'])
            .optional()
            .describe('For action=attach only: creator type for the artifact.'),
          created_by_id: z
            .string()
            .optional()
            .describe('For action=attach only: creator user UUID or external user id.'),
          initiative_id: z
            .string()
            .optional()
            .describe('For action=attach only: optional initiative reference to resolve alongside the target entity.'),
          note: z.string().optional().describe('Optional note/reason'),
          force: z
            .boolean()
            .optional()
            .describe('Force action when server supports override semantics'),
          // Initiative reassign_streams fields
          mappings: z
            .record(z.string())
            .optional()
            .describe(
              'Workstream_id → agent_domain overrides (for initiative action=reassign_streams). If omitted, domains are inferred from workstream fields.'
            ),
          dry_run: z
            .boolean()
            .optional()
            .describe(
              'Preview changes without updating (for initiative action=reassign_streams)'
            ),
          // Studio action fields (for studio_content)
          quality: z
            .enum(['preview', 'draft', 'production'])
            .optional()
            .describe('Render quality (for studio_content action=render)'),
          format: z
            .enum(['mp4', 'webm', 'gif'])
            .optional()
            .describe('Output format (for studio_content action=render)'),
          strength: z
            .enum(['subtle', 'strong'])
            .optional()
            .describe('Variation strength (for studio_content action=vary)'),
          mode: z
            .enum(['subtle', 'creative'])
            .optional()
            .describe('Upscale mode (for studio_content action=upscale)'),
          spec: z
            .record(z.unknown())
            .optional()
            .describe(
              'Video spec to validate (for studio_content action=validate)'
            ),
          prompt: z
            .string()
            .optional()
            .describe('Remix prompt (for studio_content action=remix)'),
          use_original_style: z
            .boolean()
            .optional()
            .describe(
              'Keep original style when remixing (for studio_content action=remix)'
            ),
          // Milestone ship_batch fields: atomically attach one artifact + mark N
          // subcomponent tasks complete. Omit task_ids to target all subcomponent
          // tasks on the milestone. Requires action=ship_batch and type=milestone.
          artifact: z
            .object({
              name: z.string().min(1).describe('Artifact name/title'),
              artifact_url: z
                .string()
                .optional()
                .describe('Internal artifact URL (requires artifact_url or external_url)'),
              external_url: z
                .string()
                .optional()
                .describe('External artifact URL (requires artifact_url or external_url)'),
              artifact_type: z
                .string()
                .min(1)
                .describe('Artifact type code (e.g. eng.diff_pack)'),
              artifact_hash: z
                .string()
                .optional()
                .describe('Optional content hash for idempotency/provenance'),
              status: z
                .enum([
                  'draft',
                  'in_review',
                  'approved',
                  'changes_requested',
                  'superseded',
                  'archived',
                ])
                .optional()
                .describe('Artifact workflow status'),
              preview_markdown: z
                .string()
                .optional()
                .describe('Markdown preview stored with the artifact'),
              metadata: z
                .record(z.unknown())
                .optional()
                .describe('Artifact metadata payload'),
            })
            .optional()
            .describe(
              'For action=ship_batch only (milestone): the single artifact that covers all batched subcomponent tasks.'
            ),
          quality_score: z
            .number()
            .min(0)
            .max(5)
            .optional()
            .describe(
              'For action=ship_batch or action=complete_with_proof: quality score (0-5) recorded against the proof artifact.'
            ),
          verification: z
            .array(z.string())
            .optional()
            .describe(
              'For action=complete_with_proof: verification commands, checks, or review evidence that support completion.'
            ),
          atomic_unit_type: z
            .string()
            .optional()
            .describe(
              'For action=complete_with_proof: proof unit type, such as pull_request, release_merge, test_run, or review.'
            ),
          artifact_hash: z
            .string()
            .optional()
            .describe(
              'For action=complete_with_proof: durable proof hash, commit SHA, artifact digest, or external evidence ID.'
            ),
          schema_validated: z
            .boolean()
            .optional()
            .describe(
              'For action=complete_with_proof: whether the evidence payload/schema was validated.'
            ),
          schema_validated_artifact: z
            .boolean()
            .optional()
            .describe(
              'For action=complete_with_proof: whether the attached artifact conforms to the proof contract.'
            ),
          task_ids: z
            .array(z.string().uuid())
            .optional()
            .describe(
              'For action=ship_batch only (milestone): explicit list of subcomponent task UUIDs to mark complete. Omit to target all subcomponent tasks under the milestone.'
            ),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'entity_action',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'execute entity actions',
          });
          if (authResponse) return authResponse;

          // Resolve action aliases: launch/pause → type-specific action
          const resolvedAction = resolveLifecycleActionAlias(
            args.type,
            args.action
          );

          if (!resolvedAction) {
            // List available actions
            const response = await callOrgxApiJson(
              this.env,
              `/api/entities/${args.type}/${args.id}/actions`
            );
            const result = (await response.json()) as {
              current_status: string;
              available_actions: Array<{
                action: string;
                result_status: string;
                message: string;
              }>;
            };

            const actionList = result.available_actions
              .map((a) => `• ${a.action} → ${a.result_status}`)
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Current status: ${
                    result.current_status
                  }\n\nAvailable actions:\n${
                    actionList || '(none available from this state)'
                  }`,
                },
              ],
            };
          }

          if (resolvedAction === 'update') {
            if (!args.fields || typeof args.fields !== 'object') {
              return this.toolError(
                'action=update requires fields (object) with at least one field to patch'
              );
            }
            const fields = args.fields as Record<string, unknown>;
            if (Object.keys(fields).length === 0) {
              return this.toolError(
                'action=update requires fields (object) with at least one field to patch'
              );
            }
            if (args.dry_run === true) {
              const payload = {
                success: true,
                dry_run: true,
                type: args.type,
                action: 'update',
                fields,
                updated_fields: Object.keys(fields),
                message: `${String(args.type)} would be updated`,
                data: {
                  id: args.id,
                  updated: false,
                  would_update: true,
                },
              };

              return {
                content: [
                  {
                    type: 'text',
                    text: formatForLLM('entity_action', payload),
                  },
                ],
                structuredContent: payload,
              };
            }

            const response = await callOrgxApiJson(
              this.env,
              '/api/entities',
              {
                method: 'PATCH',
                body: JSON.stringify({
                  type: args.type,
                  id: args.id,
                  ...fields,
                }),
              },
              { userId: resolvedUserId ?? null }
            );
            const result = (await response.json()) as {
              type?: string;
              data?: Record<string, unknown>;
            };
            const payload = {
              ...result,
              action: 'update',
              updated_fields: Object.keys(fields),
            };

            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('entity_action', payload),
                },
              ],
              structuredContent: payload,
            };
          }

          if (resolvedAction === 'attach') {
            const attachPayload = buildEntityActionAttachPayload({
              type: args.type,
              id: args.id,
              artifact_id: args.artifact_id,
              initiative_id: args.initiative_id,
              name: args.name,
              artifact_type: args.artifact_type,
              description: args.description,
              artifact_url: args.artifact_url,
              external_url: args.external_url,
              preview_markdown: args.preview_markdown,
              status: args.status,
              metadata: args.metadata,
              created_by_type: args.created_by_type,
              created_by_id: args.created_by_id,
            });

            const response = await callOrgxApiJson(
              this.env,
              '/api/client/artifacts',
              {
                method: 'POST',
                body: JSON.stringify(attachPayload),
              },
              { userId: resolvedUserId ?? null }
            );
            const result = (await response.json()) as {
              ok?: boolean;
              skipped?: boolean;
              reason?: string;
              artifact?: Record<string, unknown>;
              artifactTypeFallbackApplied?: boolean;
              effectiveArtifactType?: string;
            };
            const artifactId =
              result.artifact &&
              typeof result.artifact.id === 'string' &&
              result.artifact.id.length > 0
                ? result.artifact.id
                : null;
            const payload = {
              ...result,
              _action: 'attach',
              entity_type: attachPayload.entity_type,
              entity_id: attachPayload.entity_id,
              artifact_id: artifactId ?? attachPayload.artifact_id ?? null,
              message: result.skipped
                ? `Artifact attach skipped: ${result.reason ?? 'unknown'}`
                : `Attached artifact "${attachPayload.name}" to ${attachPayload.entity_type} ${attachPayload.entity_id}`,
            };

            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('entity_action', payload),
                },
              ],
              structuredContent: payload,
            };
          }

          if (resolvedAction === 'complete_with_proof') {
            if (
              !VERIFIABLE_COMPLETION_ENTITY_TYPES.includes(
                args.type as (typeof VERIFIABLE_COMPLETION_ENTITY_TYPES)[number]
              )
            ) {
              return this.toolError(
                'action=complete_with_proof is only supported for initiative, workstream, milestone, and task entities',
                { code: 'invalid_input', status: 400 }
              );
            }

            const artifactInput =
              args.artifact &&
              typeof args.artifact === 'object' &&
              !Array.isArray(args.artifact)
                ? (args.artifact as Record<string, unknown>)
                : {};
            const firstString = (...values: unknown[]) =>
              values.find(
                (value): value is string =>
                  typeof value === 'string' && value.trim().length > 0
              )?.trim();
            const proofVerification = Array.isArray(args.verification)
              ? args.verification.filter(
                  (entry): entry is string =>
                    typeof entry === 'string' && entry.trim().length > 0
                )
              : [];
            const proofMetadata = {
              ...(args.metadata &&
              typeof args.metadata === 'object' &&
              !Array.isArray(args.metadata)
                ? (args.metadata as Record<string, unknown>)
                : {}),
              atomic_unit_type:
                firstString(args.atomic_unit_type, artifactInput.atomic_unit_type) ??
                'completion_proof',
              artifact_hash:
                firstString(args.artifact_hash, artifactInput.artifact_hash) ??
                undefined,
              schema_validated: args.schema_validated ?? true,
              schema_validated_artifact:
                args.schema_validated_artifact ?? args.schema_validated ?? true,
              completion_state: 'completed',
              quality_score:
                typeof args.quality_score === 'number'
                  ? args.quality_score
                  : undefined,
              verification:
                proofVerification.length > 0 ? proofVerification : undefined,
              entity_type: args.type,
              entity_id: args.id,
              ...(args.type === 'task' ? { task_id: args.id } : {}),
            };

            const artifactUrl = firstString(
              args.artifact_url,
              artifactInput.artifact_url
            );
            const externalUrl = firstString(
              args.external_url,
              artifactInput.external_url
            );
            const artifactId = firstString(args.artifact_id);
            const shouldAttachProof = Boolean(
              artifactId || artifactUrl || externalUrl
            );
            let attachResult: Record<string, unknown> | null = null;

            if (shouldAttachProof) {
              let attachPayload: ReturnType<typeof buildEntityActionAttachPayload>;
              try {
                attachPayload = buildEntityActionAttachPayload({
                  type: args.type,
                  id: args.id,
                  artifact_id: artifactId,
                  initiative_id: args.initiative_id,
                  name:
                    firstString(args.name, artifactInput.name) ??
                    `Completion proof for ${args.type} ${args.id}`,
                  artifact_type:
                    firstString(args.artifact_type, artifactInput.artifact_type) ??
                    'eng.release_evidence',
                  description:
                    firstString(args.description, artifactInput.description) ??
                    args.note,
                  artifact_url: artifactUrl,
                  external_url: externalUrl,
                  preview_markdown:
                    firstString(
                      args.preview_markdown,
                      artifactInput.preview_markdown
                    ) ?? undefined,
                  status: (args.status as any) ?? 'approved',
                  metadata: proofMetadata,
                  created_by_type: args.created_by_type ?? 'agent',
                  created_by_id: args.created_by_id ?? resolvedUserId ?? undefined,
                });
              } catch (error) {
                return this.toolError(
                  error instanceof Error
                    ? error.message
                    : 'Invalid complete_with_proof artifact payload',
                  {
                    code: 'invalid_input',
                    status: 400,
                    details: buildFailureDetails({
                      toolId: 'entity_action',
                      error,
                      args: args as Record<string, unknown>,
                    }),
                  }
                );
              }

              const attachResponse = await callOrgxApiJson(
                this.env,
                '/api/client/artifacts',
                {
                  method: 'POST',
                  body: JSON.stringify(attachPayload),
                },
                { userId: resolvedUserId ?? null }
              );
              attachResult = (await attachResponse.json()) as Record<
                string,
                unknown
              >;
            }

            const verifyParams = new URLSearchParams({
              type: String(args.type),
              id: String(args.id),
            });
            const verifyResponse = await callOrgxApiJson(
              this.env,
              `/api/entities/verify?${verifyParams.toString()}`,
              undefined,
              { userId: resolvedUserId ?? null }
            );
            const verifyResult = (await verifyResponse.json()) as {
              verification?: {
                verified: boolean;
                progress_pct: number;
                blockers?: string[];
              };
            };
            const verification = verifyResult.verification;
            if (!verification?.verified) {
              const blockers = verification?.blockers ?? [
                'Completion verifier did not return ready=true',
              ];
              const payload = {
                ok: false,
                _action: 'complete_with_proof',
                entity_type: args.type,
                entity_id: args.id,
                proof_attached: Boolean(attachResult),
                attach_result: attachResult,
                verification: verifyResult.verification ?? null,
                diagnostic: diagnoseToolFailure({
                  toolId: 'entity_action',
                  error: blockers.join('; '),
                  args: args as Record<string, unknown>,
                }),
              };
              return {
                content: [
                  {
                    type: 'text',
                    text: `Proof ${
                      attachResult ? 'attached, but completion is still blocked' : 'not attached and completion is blocked'
                    }.\n\nBlockers:\n${blockers
                      .map((blocker) => `• ${blocker}`)
                      .join('\n')}`,
                  },
                ],
                structuredContent: payload,
              };
            }

            const completeResponse = await callOrgxApiJson(
              this.env,
              `/api/entities/${args.type}/${args.id}/complete`,
              {
                method: 'POST',
                body: JSON.stringify({
                  note: args.note,
                  reason: args.note,
                  force: args.force,
                  user_id: resolvedUserId,
                }),
              },
              { userId: resolvedUserId ?? null }
            );
            const completeResult = (await completeResponse.json()) as Record<
              string,
              unknown
            >;
            const payload = {
              ...completeResult,
              _action: 'complete_with_proof',
              entity_type: args.type,
              entity_id: args.id,
              proof_attached: Boolean(attachResult),
              attach_result: attachResult,
              verification: verifyResult.verification,
              message: `Completed ${args.type} ${args.id} with proof`,
            };
            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('entity_action', payload),
                },
              ],
              structuredContent: payload,
            };
          }

          if (resolvedAction === 'ship_batch') {
            // ship_batch: atomically attach one artifact + mark N subcomponent tasks
            // complete on a milestone. Only valid for milestones.
            if (args.type !== 'milestone') {
              return this.toolError(
                'action=ship_batch is only supported on milestone entities',
                { code: 'invalid_input', status: 400 }
              );
            }

            let shipBatchBuilt: ReturnType<
              typeof buildEntityActionShipBatchPayload
            >;
            try {
              shipBatchBuilt = buildEntityActionShipBatchPayload({
                milestone_id: args.id,
                artifact: args.artifact,
                quality_score: args.quality_score,
                task_ids: args.task_ids,
                note: args.note,
                user_id: resolvedUserId,
              });
            } catch (error) {
              return this.toolError(
                error instanceof Error
                  ? error.message
                  : 'Invalid ship_batch payload',
                { code: 'invalid_input', status: 400 }
              );
            }

            const response = await callOrgxApiJson(
              this.env,
              `/api/entities/milestone/${shipBatchBuilt.milestone_id}/ship_batch`,
              {
                method: 'POST',
                body: JSON.stringify(shipBatchBuilt.body),
              },
              { userId: resolvedUserId ?? null }
            );
            const result = (await response.json()) as {
              ok?: boolean;
              error?: string;
              artifact?: Record<string, unknown>;
              completed_task_ids?: string[];
              skipped_task_ids?: string[];
              milestone?: Record<string, unknown>;
            };
            if (result.error) {
              return this.toolError(result.error);
            }
            const payload = {
              ...result,
              _action: 'ship_batch',
              entity_type: 'milestone',
              entity_id: args.id,
              message: `Shipped batch on milestone ${args.id}: attached "${shipBatchBuilt.body.artifact.name}"${
                result.completed_task_ids
                  ? ` and completed ${result.completed_task_ids.length} task(s)`
                  : ''
              }`,
            };

            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('entity_action', payload),
                },
              ],
              structuredContent: payload,
            };
          }

          // Build request body - include studio-specific and initiative-specific fields
          const body: Record<string, unknown> = {
            note: args.note,
            reason: args.note,
          };
          if (args.force !== undefined) body.force = args.force;
          if (args.quality) body.quality = args.quality;
          if (args.format) body.format = args.format;
          if (args.strength) body.strength = args.strength;
          if (args.mode) body.mode = args.mode;
          if (args.spec) body.spec = args.spec;
          if (args.prompt) body.prompt = args.prompt;
          if (args.use_original_style !== undefined)
            body.use_original_style = args.use_original_style;
          // Initiative reassign_streams fields
          if (args.mappings) body.mappings = args.mappings;
          if (args.dry_run !== undefined) body.dry_run = args.dry_run;
          // Pass user_id for studio actions
          if (resolvedUserId) body.user_id = resolvedUserId;

          // Execute the action
          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/${args.type}/${args.id}/${resolvedAction}`,
            {
              method: 'POST',
              body: JSON.stringify(body),
            },
            { userId: resolvedUserId ?? null }
          );
          const result = (await response.json()) as {
            success?: boolean;
            message?: string;
            transition?: { from: string; to: string };
            data?: unknown;
            error?: string;
            initiative_activation?: {
              created_stream_count?: number;
              redispatched_stream_count?: number;
              error?: string;
            };
          };

          // Studio/initiative custom actions return { success, data } instead of { message, transition }
          if (result.error) {
            return this.toolError(result.error);
          }
          // Detect the silent-no-op case for initiative launch: API returns 200
          // with no transition AND no error AND no initiative_activation. Seen
          // in production where the launch endpoint accepts the request but
          // doesn't actually re-dispatch streams (idempotency path swallows
          // the call when streams already exist). Without this branch the
          // tool returns an empty success and the agent thinks launch worked.
          const isInitiativeLaunch =
            args.type === 'initiative' && resolvedAction === 'launch';
          if (
            isInitiativeLaunch &&
            !result.transition &&
            !result.initiative_activation &&
            (result.data === undefined || result.data === null)
          ) {
            const liveUrl = buildLiveUrl(args.id);
            const warning =
              `⚠️  Launch endpoint returned success but no transition or stream activation was reported. ` +
              `This often means the dispatcher silently no-op'd because streams already exist. ` +
              `Verify with get_initiative_stream_state. If streams stay 'ready' without progress, ` +
              `bypass via spawn_agent_task to dispatch a single task directly.`;
            return {
              content: [
                { type: 'text', text: `${warning}\n\n📺 **Live view:** ${liveUrl}` },
              ],
              structuredContent: {
                ok: false,
                error_kind: 'launch_silent_no_op',
                live_url: liveUrl,
                warning,
                next_steps: [
                  'Call get_initiative_stream_state to inspect actual stream status',
                  'If streams sit at "ready" with no current_job_id, the auto-dispatcher is not picking them up',
                  'Bypass via spawn_agent_task to dispatch directly',
                ],
              },
            };
          }
          if (result.transition) {
            // Include live_url for initiative launch
            const liveUrl = isInitiativeLaunch ? buildLiveUrl(args.id) : null;
            const liveSection = liveUrl
              ? `\n\n📺 **Watch progress live:** ${liveUrl}`
              : '';
            // Surface the actual activation count when available — agents
            // need this to decide whether the launch did real work.
            const activationSummary = result.initiative_activation
              ? `\n\nStreams: +${result.initiative_activation.created_stream_count ?? 0} created, ${result.initiative_activation.redispatched_stream_count ?? 0} dispatched`
              : '';

            return {
              content: [
                {
                  type: 'text',
                  text: `✓ ${result.message}\n\nStatus: ${result.transition.from} → ${result.transition.to}${activationSummary}${liveSection}`,
                },
              ],
              ...(liveUrl && {
                structuredContent: {
                  live_url: liveUrl,
                  initiative_activation: result.initiative_activation,
                },
              }),
            };
          }
          // Studio/initiative action response
          return {
            content: [
              {
                type: 'text',
                text: formatForLLM(
                  'entity_action',
                  { ...(result.data as Record<string, unknown> ?? result), _action: resolvedAction },
                ),
              },
            ],
          };
        })
    );

    /**
     * verify_entity_completion - Run hierarchy-aware completion checks.
     */
    if (shouldRegister('verify_entity_completion'))
    this.server.registerTool(
      'verify_entity_completion',
      {
        title: 'Verify entity completion readiness',
        description:
          'Run pre-completion verification to confirm all child work is done. For tasks, this also checks proof-chain hard blocks that would stop entity_action action=complete. USE WHEN: before completing an entity with entity_action action=complete. NEXT: If verified, proceed with entity_action action=complete. If not, show blockers to user. Read-only.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: z
            .enum(VERIFIABLE_COMPLETION_ENTITY_TYPES)
            .describe('Entity type to verify'),
          id: z.string().min(1).describe('Entity ID'),
        },
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'verify_entity_completion',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'verify entity completion',
          });
          if (authResponse) return authResponse;

          const params = new URLSearchParams({
            type: args.type,
            id: args.id,
          });
          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/verify?${params.toString()}`,
            undefined,
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as {
            verification?: {
              verified: boolean;
              progress_pct: number;
              blockers?: string[];
            };
          };

          const verification = result.verification;
          if (!verification) {
            return this.toolError('Verification response was empty');
          }

          const statusLine = verification.verified
            ? '✅ Ready to complete'
            : '⚠️ Not ready to complete';
          const blockers =
            verification.blockers && verification.blockers.length > 0
              ? `\n\nBlockers:\n${verification.blockers
                  .map((b) => `• ${b}`)
                  .join('\n')}`
              : '';

          return {
            content: [
              {
                type: 'text',
                text: `${statusLine}\nProgress: ${verification.progress_pct}%${blockers}`,
              },
            ],
            structuredContent: result,
          };
        })
    );

    /**
     * create_entity - Generic entity creation
     */
    if (shouldRegister('create_entity'))
    this.server.registerTool(
      'create_entity',
      {
        title: 'Create an entity',
        description: `Create durable work records such as tasks, milestones, decisions, artifacts, or initiatives. Also known as: save work item, add record, create project context. USE WHEN: adding a single task, milestone, workstream, or other entity to an existing hierarchy. NEXT: Use entity_action to launch/start the entity. DO NOT USE: for creating a full initiative hierarchy — use scaffold_initiative instead.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: this.withClientContext({
          type: entityTypeEnum.describe('Entity type to create'),
          title: z
            .string()
            .optional()
            .describe('Title/name (required for most types)'),
          name: z.string().optional().describe('Name (alternative to title)'),
          summary: z.string().optional().describe('Summary/description'),
          description: z.string().optional().describe('Description'),
          context: z
            .array(z.record(z.unknown()))
            .optional()
            .describe(
              'Optional context attachments (initiative, workstream, milestone, task). Each entry is a pointer with a relevance note.'
            ),
          metadata: z
            .record(z.unknown())
            .optional()
            .describe('Optional metadata payload persisted with supported entity types'),
          initiative_id: z
            .string()
            .optional()
            .describe(
              'Parent initiative ID (for milestones, tasks, workstreams)'
            ),
          workstream_id: z
            .string()
            .optional()
            .describe('Parent workstream ID (for milestones, tasks)'),
          milestone_id: z
            .string()
            .optional()
            .describe('Parent milestone ID (for tasks)'),
          due_date: z.string().optional().describe('Due date (YYYY-MM-DD)'),
          status: z
            .string()
            .optional()
            .describe('Initial workflow status; common agent aliases such as active are normalized per entity type'),
          sequence: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Execution order for initiative/workstream/milestone/task (lower runs first)'
            ),
          priority: z
            .enum(['low', 'medium', 'high', 'urgent'])
            .optional()
            .describe(
              'Priority level. For type=task use low, medium, or high; use high instead of urgent.'
            ),
          persona: z
            .string()
            .optional()
            .describe('Optional workstream persona/owner label'),
          domain: z
            .string()
            .optional()
            .describe(
              'Optional domain for initiative/workstream/milestone/task planning (engineering, marketing, design, etc.)'
            ),
          depends_on: z
            .array(z.string())
            .optional()
            .describe(
              'Optional dependency IDs/refs for initiative/workstream/milestone/task metadata'
            ),
          goal_ids: z
            .array(z.string())
            .optional()
            .describe(
              'Optional goal UUIDs for initiative/workstream/milestone/task creation. Suggested when the workspace enforces a primary goal; the first goal acts as the primary anchor.'
            ),
          expected_duration_hours: z
            .number()
            .optional()
            .describe('Estimated effort in hours for planning metadata'),
          expected_tokens: z
            .number()
            .optional()
            .describe('Estimated token budget for planning metadata'),
          expected_budget_usd: z
            .number()
            .optional()
            .describe('Estimated budget in USD for planning metadata'),
          assigned_agent_ids: z
            .array(z.string())
            .optional()
            .describe('Optional explicit assignee IDs for planning metadata'),
          agent_domain: z
            .string()
            .optional()
            .describe(
              'Agent domain for streams (e.g., engineering, marketing)'
            ),
          auto_continue: z
            .boolean()
            .optional()
            .describe('Auto-run streams when ready'),
          proof_profile: z
            .enum(['full', 'subcomponent', 'release', 'external_artifact'])
            .optional()
            .describe(
              'Proof-chain profile (task/milestone only). Controls completion evidence required before the entity can be marked complete. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
            ),
          owner_id: z
            .string()
            .optional()
            .describe(
              'Optional owner user ID for the created entity; defaults to the authenticated user when omitted'
            ),
          user_id: z
            .string()
            .optional()
            .describe('Deprecated alias for owner_id; prefer owner_id for new calls'),
          entity_type: z
            .string()
            .optional()
            .describe('Artifact target entity type, such as initiative, workstream, milestone, task, or decision'),
          entity_id: z
            .string()
            .optional()
            .describe('Artifact target entity UUID'),
          task_id: z
            .string()
            .optional()
            .describe('Artifact target task UUID shortcut'),
          artifact_type: z
            .string()
            .optional()
            .describe('Artifact type code, such as eng.demo_report or proof.link'),
          artifact_url: z
            .string()
            .optional()
            .describe('Internal artifact URL'),
          external_url: z
            .string()
            .optional()
            .describe('External artifact URL'),
          preview_markdown: z
            .string()
            .optional()
            .describe('Artifact markdown preview'),
          run_id: z
            .string()
            .optional()
            .describe('Agent run UUID for blocker creation'),
          step_id: z
            .string()
            .optional()
            .describe('Optional agent run step UUID for blocker creation'),
          blocker_type: z
            .string()
            .optional()
            .describe('Blocker category/type when type=blocker'),
          resolution: z
            .string()
            .optional()
            .describe('Blocker resolution text when known'),
          live_visibility: z
            .enum(['private', 'public'])
            .optional()
            .describe('Initiative live-link visibility'),
          live_public: z
            .boolean()
            .optional()
            .describe('Shortcut to publish an initiative live link'),
          live_reveal_title: z
            .boolean()
            .optional()
            .describe('Allow public live-link visitors to see the initiative title'),
          // Skill-specific fields (for type: 'skill')
          prompt_template: z
            .string()
            .optional()
            .describe(SKILL_PROMPT_TEMPLATE_SAFETY_DESCRIPTION),
          trigger_keywords: z
            .array(z.string())
            .optional()
            .describe('Keywords that trigger this skill'),
          trigger_domains: z
            .array(z.string())
            .optional()
            .describe('Domains this skill applies to'),
          checklist: z
            .array(
              z.object({ item: z.string(), critical: z.boolean().optional() })
            )
            .optional()
            .describe('Checklist items'),
          // Plan session fields (for type: 'plan_session')
          feature_name: z.string().optional().describe('Feature being planned'),
          initial_plan: z.string().optional().describe('Initial plan content'),
          // Studio brand fields (for type: 'studio_brand')
          sources: z
            .array(
              z.object({
                type: z
                  .enum(['url', 'file', 'asset'])
                  .describe('Source kind for brand ingestion'),
                url: z
                  .string()
                  .optional()
                  .describe('Source URL when type=url'),
                assetType: z
                  .string()
                  .optional()
                  .describe('Asset category or MIME hint when type=asset or file'),
              })
            )
            .optional()
            .describe('Brand sources to ingest (for studio_brand)'),
          workspace_id: z
            .string()
            .optional()
            .describe(
              'Workspace ID (canonical). Defaults to current session workspace for supported types.'
            ),
          visibility: z
            .enum(['private', 'org', 'public'])
            .optional()
            .describe('Brand visibility (for studio_brand)'),
          command_center_id: z
            .string()
            .optional()
            .describe(
              'Deprecated alias for workspace_id (defaults to current session workspace for supported types)'
            ),
          is_default: z
            .boolean()
            .optional()
            .describe('Set as default brand (for studio_brand)'),
          // Studio content fields (for type: 'studio_content')
          content_type: z
            .enum(['carousel', 'post', 'story', 'video', 'banner', 'thumbnail'])
            .optional()
            .describe('Content type (for studio_content)'),
          prompt: z
            .string()
            .optional()
            .describe('Generation prompt (for studio_content)'),
          brand_id: z
            .string()
            .optional()
            .describe('Brand pack ID (for studio_content)'),
          platform: z
            .enum([
              'linkedin',
              'instagram',
              'x',
              'facebook',
              'tiktok',
              'youtube',
            ])
            .optional()
            .describe('Target platform (for studio_content)'),
          template: z
            .string()
            .optional()
            .describe(
              'Video template (for studio_content with content_type=video)'
            ),
          options: z
            .object({
              slideCount: z
                .number()
                .optional()
                .describe('Requested number of slides or frames'),
              aspectRatio: z
                .string()
                .optional()
                .describe('Target aspect ratio, such as 1:1, 4:5, or 16:9'),
              style: z
                .string()
                .optional()
                .describe('Visual style direction for the generated content'),
              duration: z
                .string()
                .optional()
                .describe('Requested video or animation duration'),
            })
            .optional()
            .describe('Generation options (for studio_content)'),
        }),
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'create_entity',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'create entities',
          });
          if (authResponse) return authResponse;

          // Soft-resolve: use authenticated user if available, let API
          // fall back to org default when no user identity is present.
          const ownerId = this.resolveUserId(args.owner_id ?? args.user_id);

          const explicitWorkspaceId =
            typeof args.workspace_id === 'string' &&
            args.workspace_id.trim().length > 0
              ? args.workspace_id.trim()
              : null;
          const explicitCommandCenterId =
            typeof args.command_center_id === 'string' &&
            args.command_center_id.trim().length > 0
              ? args.command_center_id.trim()
              : null;
          if (
            explicitWorkspaceId &&
            explicitCommandCenterId &&
            explicitWorkspaceId !== explicitCommandCenterId
          ) {
            return this.toolError(
              'workspace_id and command_center_id must match when both are provided'
            );
          }
          const effectiveWorkspaceId =
            explicitWorkspaceId ??
            explicitCommandCenterId ??
            this.sessionContext?.workspaceId ??
            null;
          let validatedSkillPromptTemplate: string | undefined;
          if (args.prompt_template !== undefined) {
            if (args.type !== 'skill') {
              return this.toolError(
                'prompt_template can only be used with skill entities',
                { code: 'invalid_skill_prompt_template', status: 400 }
              );
            }

            try {
              validatedSkillPromptTemplate = validateSkillPromptTemplate(
                args.prompt_template
              );
            } catch (error) {
              return this.toolError(
                error instanceof Error
                  ? error.message
                  : 'Invalid skill prompt_template',
                { code: 'invalid_skill_prompt_template', status: 400 }
              );
            }
          }
          const workspaceScopedTypes: ReadonlySet<string> = new Set([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
            'objective',
            'playbook',
            'run',
            'stream',
            'studio_brand',
          ] as const);
          const hierarchyEntityTypes: ReadonlySet<string> = new Set([
            'initiative',
            'workstream',
            'milestone',
            'task',
          ] as const);
          const datedEntityTypes: ReadonlySet<string> = new Set([
            'task',
            'milestone',
          ] as const);
          const priorityEntityTypes: ReadonlySet<string> = new Set([
            'workstream',
            'milestone',
            'task',
            'decision',
          ] as const);
          const sequencedEntityTypes = hierarchyEntityTypes;

          const payload: Record<string, unknown> = {
            type: args.type,
            title: args.title ?? args.name,
            name: args.name ?? args.title,
            summary: args.summary ?? args.description,
            description: args.description ?? args.summary,
          };
          if (
            args.metadata &&
            typeof args.metadata === 'object' &&
            !Array.isArray(args.metadata)
          ) {
            payload.metadata = args.metadata;
          }
          if (args.status) payload.status = args.status;

          // Include owner_id in body when explicitly available
          if (ownerId) {
            payload.owner_id = ownerId;
          }

          // Workspace scoping: default to the session workspace unless overridden.
          if (effectiveWorkspaceId && workspaceScopedTypes.has(args.type)) {
            payload.workspace_id = effectiveWorkspaceId;
          }

          // Context attachments (persisted on a subset of entities today)
          if (args.context && hierarchyEntityTypes.has(args.type)) {
            payload.context = args.context;
          }

          // Add optional fields (only for types whose tables have these columns)
          if (args.initiative_id && args.type !== 'blocker') {
            payload.initiative_id = args.initiative_id;
          }
          if (
            args.workstream_id &&
            args.type !== 'blocker' &&
            args.type !== 'artifact'
          ) {
            payload.workstream_id = args.workstream_id;
          }
          if (
            args.milestone_id &&
            args.type !== 'blocker' &&
            args.type !== 'artifact'
          ) {
            payload.milestone_id = args.milestone_id;
          }
          // due_date exists on: milestones, workstream_tasks
          if (args.due_date && datedEntityTypes.has(args.type)) {
            payload.due_date = args.due_date;
          }
          // priority exists on: workstreams, milestones, workstream_tasks, decisions
          if (args.priority && priorityEntityTypes.has(args.type)) {
            payload.priority = args.priority;
          }
          // sequence exists on: initiatives, workstreams, milestones, workstream_tasks
          if (
            args.sequence !== undefined &&
            sequencedEntityTypes.has(args.type)
          ) {
            payload.sequence = args.sequence;
          }
          if (args.type === 'workstream') {
            if (args.persona) payload.persona = args.persona;
            if (args.domain && !payload.persona) {
              payload.persona = args.domain;
            }
          }
          if (args.domain && hierarchyEntityTypes.has(args.type)) {
            payload.domain = args.domain;
          }
          if (args.goal_ids && hierarchyEntityTypes.has(args.type)) {
            payload.goal_ids = args.goal_ids;
          }
          if (args.depends_on && hierarchyEntityTypes.has(args.type)) {
            payload.depends_on = args.depends_on;
          }
          if (
            args.expected_duration_hours !== undefined &&
            hierarchyEntityTypes.has(args.type)
          ) {
            payload.expected_duration_hours = args.expected_duration_hours;
          }
          if (
            args.expected_tokens !== undefined &&
            hierarchyEntityTypes.has(args.type)
          ) {
            payload.expected_tokens = args.expected_tokens;
          }
          if (
            args.expected_budget_usd !== undefined &&
            hierarchyEntityTypes.has(args.type)
          ) {
            payload.expected_budget_usd = args.expected_budget_usd;
          }
          if (
            args.assigned_agent_ids &&
            hierarchyEntityTypes.has(args.type)
          ) {
            payload.assigned_agent_ids = args.assigned_agent_ids;
          }
          if (args.type === 'stream') {
            if (args.agent_domain) payload.agent_domain = args.agent_domain;
            if (args.auto_continue !== undefined)
              payload.auto_continue = args.auto_continue;
          }

          if (args.type === 'artifact') {
            payload.entity_type =
              args.entity_type ??
              (args.task_id ? 'task' : undefined) ??
              (args.milestone_id ? 'milestone' : undefined) ??
              (args.workstream_id ? 'workstream' : undefined) ??
              (args.initiative_id ? 'initiative' : undefined);
            payload.entity_id =
              args.entity_id ??
              args.task_id ??
              args.milestone_id ??
              args.workstream_id ??
              args.initiative_id;
            if (args.artifact_type) payload.artifact_type = args.artifact_type;
            if (args.artifact_url) payload.artifact_url = args.artifact_url;
            if (args.external_url) payload.external_url = args.external_url;
            if (args.preview_markdown)
              payload.preview_markdown = args.preview_markdown;
          }

          if (args.type === 'blocker') {
            if (args.run_id) payload.run_id = args.run_id;
            if (args.step_id) payload.step_id = args.step_id;
            if (args.blocker_type) payload.blocker_type = args.blocker_type;
            if (args.resolution) payload.resolution = args.resolution;
          }

          if (args.type === 'initiative') {
            const metadata =
              payload.metadata &&
              typeof payload.metadata === 'object' &&
              !Array.isArray(payload.metadata)
                ? (payload.metadata as Record<string, unknown>)
                : {};
            const liveMetadata =
              metadata.live &&
              typeof metadata.live === 'object' &&
              !Array.isArray(metadata.live)
                ? (metadata.live as Record<string, unknown>)
                : {};
            if (args.live_visibility === 'public' || args.live_public === true) {
              payload.metadata = {
                ...metadata,
                liveVisibility: 'public',
                live: {
                  ...liveMetadata,
                  public: true,
                  revealTitle: args.live_reveal_title !== false,
                },
              };
            } else if (args.live_visibility === 'private') {
              payload.metadata = {
                ...metadata,
                liveVisibility: 'private',
                live: {
                  ...liveMetadata,
                  public: false,
                },
              };
            }
          }

          // proof_profile (tasks/milestones only) — merged into metadata so server-side
          // proof-chain handler can read it without schema changes.
          if (
            args.proof_profile &&
            (args.type === 'task' || args.type === 'milestone')
          ) {
            const existingMetadata =
              (payload.metadata as Record<string, unknown> | undefined) ?? {};
            payload.metadata = {
              ...existingMetadata,
              proof_profile: args.proof_profile,
            };
          }

          // Skill-specific fields
          if (args.type === 'skill') {
            if (validatedSkillPromptTemplate !== undefined)
              payload.prompt_template = validatedSkillPromptTemplate;
            if (args.trigger_keywords)
              payload.trigger_keywords = args.trigger_keywords;
            if (args.trigger_domains)
              payload.trigger_domains = args.trigger_domains;
            if (args.checklist) payload.checklist = args.checklist;
            payload.source_type = 'manual_created'; // Default for skills created via MCP
          }

          // Plan session fields
          if (args.type === 'plan_session') {
            if (args.feature_name) payload.feature_name = args.feature_name;
            if (args.initial_plan) payload.current_plan = args.initial_plan;
          }

          // Studio brand fields
          if (args.type === 'studio_brand') {
            if (args.sources) payload.sources = args.sources;
            if (args.visibility) payload.visibility = args.visibility;
            if (effectiveWorkspaceId) payload.workspace_id = effectiveWorkspaceId;
            if (args.is_default !== undefined)
              payload.is_default = args.is_default;
          }

          // Studio content fields
          if (args.type === 'studio_content') {
            if (args.content_type) payload.content_type = args.content_type;
            if (args.prompt) payload.prompt = args.prompt;
            if (args.brand_id) payload.brand_id = args.brand_id;
            if (args.platform) payload.platform = args.platform;
            if (args.template) payload.template = args.template;
            if (args.options) payload.options = args.options;
          }

          const normalizedPayload = normalizeEntityCreatePayloadForAgents(
            payload,
            'create_entity'
          );
          Object.assign(payload, normalizedPayload.entity);

          const contractError = validateEntityCreatePayloadContract(
            payload,
            'create_entity'
          );
          if (contractError) {
            return this.toolError(contractError, {
              code: 'invalid_entity_payload',
              status: 400,
            });
          }

          const response = await callOrgxApiJson(
            this.env,
            '/api/entities',
            {
              method: 'POST',
              body: JSON.stringify(payload),
            },
            { userId: ownerId }
          );
          const result = (await response.json()) as {
            type: string;
            data: { id: string; title?: string; name?: string };
          };

          const name = result.data.title ?? result.data.name ?? 'entity';
          const link = entityLinkMarkdown(args.type, result.data.id, name);

          // Include live_url for initiatives so users can watch when launched
          const isInitiative = args.type === 'initiative';
          const liveUrl = isInitiative ? buildLiveUrl(result.data.id) : null;

          // Update session initiative context for "context survival".
          // 1) Creating an initiative sets it as the active context.
          // 2) Creating child entities under an initiative keeps that initiative active.
          const initiativeIdForContext = isInitiative
            ? result.data.id
            : typeof args.initiative_id === 'string' &&
              args.initiative_id.trim().length > 0
            ? args.initiative_id.trim()
            : null;
          if (initiativeIdForContext) {
            this.sessionContext = {
              ...this.sessionContext,
              initiativeId: initiativeIdForContext,
            };
            await this.saveSessionContext();
          }

          let message = `✓ Created ${args.type}: ${link}`;
          const liveHint = liveUrl
            ? `\n\n💡 **Tip:** After launching, watch progress at: ${liveUrl}`
            : '';
          message += liveHint;

          const enrichment = await this.maybeEnrichWithRelatedContext({
            toolId: 'create_entity',
            args: args as Record<string, unknown>,
            userId: ownerId ?? resolvedUserId ?? null,
            data: {
              ...result.data,
              type: args.type,
              initiative_id:
                (result.data as Record<string, unknown>).initiative_id ??
                args.initiative_id ??
                (args.type === 'initiative' ? result.data.id : undefined),
            },
            message,
          });
          message = enrichment.message;
          const structuredPayload = {
            ...(enrichment.data ?? {}),
            ...(liveUrl ? { live_url: liveUrl } : {}),
            id: result.data.id,
            type: args.type,
            normalization_warnings: normalizedPayload.warnings,
          };

          const sourceClient = resolveSourceClientFromContext(args._context);
          const activationEvents = await this.recordMcpActivationObservation({
            toolId: 'create_entity',
            args: args as Record<string, unknown>,
            data: structuredPayload,
            userId: ownerId ?? resolvedUserId ?? null,
            sourceClient,
            workspaceId: effectiveWorkspaceId,
            initiativeId: initiativeIdForContext,
          });
          const activationPayload = this.buildClientActivationPayload({
            sourceClient,
            events: activationEvents,
          });
          const finalPayload = activationPayload.experience
            ? {
                ...structuredPayload,
                client_activation: activationPayload.experience,
              }
            : structuredPayload;

          return {
            content: [
              {
                type: 'text',
                text: message + activationPayload.text,
              },
            ],
            structuredContent: finalPayload,
          };
        })
    );

    /**
     * comment_on_entity - Leave cross-agent notes on any entity.
     */
    if (shouldRegister('comment_on_entity'))
    this.server.registerTool(
      'comment_on_entity',
      {
        title: 'Comment on an entity',
        description:
          'Leave a threaded comment on an entity. USE WHEN: agent or user wants to annotate an entity with observations, concerns, or progress notes. NEXT: Use list_entity_comments to read the thread. DO NOT USE: for status changes — use entity_action instead.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          entity_type: z.enum([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
          ]).describe('Entity type to comment on.'),
          entity_id: z
            .string()
            .min(1)
            .describe('Entity ID to attach the comment to.'),
          body: z
            .string()
            .min(1)
            .max(4000)
            .describe('Comment body in plain text or markdown.'),
          parent_comment_id: z
            .string()
            .uuid()
            .optional()
            .describe('Optional parent comment ID when replying in-thread.'),
          comment_type: z
            .enum([
              'observation',
              'concern',
              'suggestion',
              'progress_note',
              'blocker_flag',
              'question',
              'handoff_note',
              'cross_reference',
              'note',
            ])
            .optional()
            .describe(
              'Optional classification for the comment (e.g. observation, concern, blocker_flag) used by downstream filters and dashboards.'
            ),
          severity: z
            .enum(['info', 'low', 'medium', 'high', 'critical'])
            .optional()
            .describe(
              'Optional severity level for triage when comment_type implies an issue (concern, blocker_flag, etc.).'
            ),
          tags: z
            .array(z.string())
            .max(20)
            .optional()
            .describe('Optional tags for categorization and later filtering.'),
          author_type: z
            .enum(['human', 'agent', 'system'])
            .optional()
            .describe('Author type to attribute the comment to.'),
          author_id: z
            .string()
            .max(200)
            .optional()
            .describe('Optional author ID override.'),
          author_name: z
            .string()
            .max(200)
            .optional()
            .describe('Optional human-readable author name.'),
          metadata: z
            .record(z.unknown())
            .optional()
            .describe('Optional structured metadata attached to the comment.'),
          user_id: z.string().optional().describe('Optional user id override'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const explicitUserId =
            typeof args.user_id === 'string' && args.user_id.trim().length > 0
              ? args.user_id.trim()
              : null;
          const authUserId = resolvedUserId ?? explicitUserId;

          const authResponse = buildAuthRequiredResponse({
            toolId: 'comment_on_entity',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: authUserId ?? undefined,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'comment on entities',
          });
          if (authResponse) return authResponse;

          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/${args.entity_type}/${args.entity_id}/comments`,
            {
              method: 'POST',
              body: JSON.stringify({
                body: args.body,
                parentCommentId: args.parent_comment_id,
                commentType: args.comment_type,
                severity: args.severity,
                tags: args.tags,
                authorType: args.author_type ?? 'agent',
                authorId: args.author_id,
                authorName: args.author_name,
                metadata: args.metadata ?? {},
              }),
            },
            { userId: authUserId }
          );
          const result = (await response.json()) as {
            status: string;
            comment?: { id: string };
          };

          const link = entityLinkMarkdown(args.entity_type, args.entity_id);
          return {
            content: [
              {
                type: 'text',
                text: `✓ Comment saved\n\n${link}`,
              },
            ],
            structuredContent: result,
          };
        })
    );

    /**
     * list_entity_comments - Read comments on an entity.
     */
    if (shouldRegister('list_entity_comments'))
    this.server.registerTool(
      'list_entity_comments',
      {
        title: 'List entity comments',
        description:
          'List comments for an entity. USE WHEN: reviewing discussion thread on an entity. NEXT: Use comment_on_entity to add a reply. Read-only.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          entity_type: z.enum([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
          ]).describe('Entity type to read comments for.'),
          entity_id: z
            .string()
            .min(1)
            .describe('Entity ID whose comment thread should be returned.'),
          limit: z
            .number()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum number of comments to return.'),
          cursor: z
            .string()
            .optional()
            .describe('Pagination cursor from a previous response.'),
          user_id: z.string().optional().describe('Optional user id override'),
        },
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'list_entity_comments',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'read entity comments',
          });
          if (authResponse) return authResponse;

          const explicitUserId =
            typeof args.user_id === 'string' && args.user_id.trim().length > 0
              ? args.user_id.trim()
              : null;
          const authUserId = resolvedUserId ?? explicitUserId;

          const params = new URLSearchParams();
          if (args.limit) params.set('limit', String(args.limit));
          if (args.cursor) params.set('cursor', args.cursor);

          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/${args.entity_type}/${args.entity_id}/comments?${params.toString()}`,
            undefined,
            { userId: authUserId }
          );
          const result = (await response.json()) as {
            status: string;
            comments: unknown[];
            nextCursor?: string | null;
          };

          const comments = Array.isArray(result.comments) ? result.comments : [];
          const commentSummary = comments.length === 0
            ? 'No comments found.'
            : `${comments.length} comment${comments.length === 1 ? '' : 's'}${
                result.nextCursor ? ' (more available)' : ''
              }`;

          return {
            content: [{ type: 'text', text: commentSummary }],
            structuredContent: result,
          };
        })
    );

    /**
     * batch_create_entities - Create multiple entities in one tool call.
     */
    if (shouldRegister('batch_create_entities'))
    this.server.registerTool(
      'batch_create_entities',
      {
        title: 'Batch create entities',
        description:
          'Create multiple entities in one call with ref-based dependency resolution. USE WHEN: creating several related entities at once. NEXT: Use entity_action to launch created entities. DO NOT USE: for initiative hierarchies — use scaffold_initiative which handles the nesting automatically.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          entities: z
            .array(z.record(z.unknown()))
            .min(1)
            .max(100)
            .describe(
              "Array of entity payloads. Each item must include at least 'type' and its required fields. Agent-safe aliases are accepted: task priority urgent -> high; active task/milestone status -> in_progress."
            ),
          owner_id: z
            .string()
            .optional()
            .describe('Optional owner_id applied when item owner is omitted'),
          user_id: z
            .string()
            .optional()
            .describe('Alias for owner_id (optional)'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Continue creating remaining entities after an error'),
          concurrency: z
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe('Parallel creation concurrency (default 8)'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'batch_create_entities',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'batch create entities',
          });
          if (authResponse) return authResponse;

          const ownerId = this.resolveUserId(args.owner_id ?? args.user_id);
          const continueOnError = args.continue_on_error !== false;
          const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 20));
          const entities = args.entities as Array<Record<string, unknown>>;

          const effectiveWorkspaceId =
            this.sessionContext?.workspaceId ?? null;
          const workspaceScopedTypes = new Set([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
            'objective',
            'playbook',
            'run',
            'stream',
            'studio_brand',
          ]);
          const patchedEntities = effectiveWorkspaceId
            ? entities.map((entity) => {
                const type =
                  typeof entity.type === 'string' ? entity.type.trim() : null;
                if (!type || !workspaceScopedTypes.has(type)) return entity;

                const hasWorkspaceId =
                  typeof entity.workspace_id === 'string' &&
                  entity.workspace_id.trim().length > 0;
                const hasCommandCenterId =
                  typeof entity.command_center_id === 'string' &&
                  entity.command_center_id.trim().length > 0;
                const hasWorkspaceRef =
                  typeof (entity as any).workspace_ref === 'string' &&
                  String((entity as any).workspace_ref).trim().length > 0;
                const hasCommandCenterRef =
                  typeof (entity as any).command_center_ref === 'string' &&
                  String((entity as any).command_center_ref).trim().length > 0;
                if (
                  hasWorkspaceId ||
                  hasCommandCenterId ||
                  hasWorkspaceRef ||
                  hasCommandCenterRef
                )
                  return entity;

                return {
                  ...entity,
                  workspace_id: effectiveWorkspaceId,
                };
              })
            : entities;

          const result = await runBatchCreateEntities({
            env: this.env,
            callApi: ({ env, path, init, userId }) =>
              callOrgxApiJson(env, path, init, { userId }),
            findExistingEntity: ({ body }) =>
              this.findExistingEntityByIdempotencyKey({
                body,
                idempotencyKey: readEntityIdempotencyKey(body),
                userId: ownerId,
              }),
            entities: patchedEntities,
            ownerId,
            continueOnError,
            concurrency,
          });

          // IMPORTANT: Many LLM clients only see the text `content`, not `structuredContent`.
          // Include IDs + ref_map in text so callers can chain without list_entities round trips.
          const createdLines =
            result.created.length > 0
              ? result.created
                  .map((item) => {
                    const title = item.title
                      ? ` ${JSON.stringify(item.title)}`
                      : '';
                    const ref = item.ref ? ` (ref=${item.ref})` : '';
                    return `- [${item.index}] ${item.type} ${item.id}${ref}${title}`;
                  })
                  .join('\n')
              : null;

          const refMapEntries = Object.entries(result.ref_map ?? {});
          const refMapLines =
            refMapEntries.length > 0
              ? refMapEntries.map(([ref, id]) => `- ${ref} -> ${id}`).join('\n')
              : null;

          const failedLines =
            result.failed.length > 0
              ? result.failed
                  .map((item) => {
                    const ref = item.ref ? ` (ref=${item.ref})` : '';
                    return `- [${item.index}] ${item.type ?? 'entity'}${ref}: ${
                      item.error
                    }`;
                  })
                  .join('\n')
              : null;

          const machinePayload = {
            created: result.created,
            failed: result.failed,
            warnings: result.warnings,
            ref_map: result.ref_map,
          };

          const textParts: string[] = [result.summary];
          if (createdLines) textParts.push(`\ncreated:\n${createdLines}`);
          if (refMapLines) textParts.push(`\nref_map:\n${refMapLines}`);
          if (failedLines) textParts.push(`\nfailed:\n${failedLines}`);
          if (result.warnings.length > 0) {
            textParts.push(
              `\nnormalized:\n${result.warnings
                .map(
                  (warning) =>
                    `- ${warning.path}: ${warning.from} -> ${warning.to} (${warning.reason})`
                )
                .join('\n')}`
            );
          }

          return {
            content: [{ type: 'text', text: textParts.join('\n') }],
            structuredContent: { ...result, ...machinePayload },
          };
        })
    );

    /**
     * scaffold_initiative - Create an initiative and full hierarchy in one call.
     *
     * This is syntactic sugar over ref-based batch_create_entities:
     * - Accepts nested { workstreams: [{ milestones: [{ tasks: [...] }]}]}
     * - Generates stable ref keys when omitted
     * - Returns the created hierarchy with IDs (plus created/failed/ref_map)
     */
    const scaffoldContextSchema = z
      .array(z.record(z.unknown()))
      .optional()
      .describe('Optional context attachments (pointers, not payloads).');

    const scaffoldTaskSchema = z
      .object({
        ref: z
          .string()
          .optional()
          .describe('Optional stable client-side reference used in ref_map and dependencies'),
        title: z.string().min(1).describe('Task title'),
        description: z.string().optional().describe('Task description'),
        summary: z.string().optional().describe('Short task summary'),
        type: z
          .enum(['research', 'create', 'review', 'implement'])
          .optional()
          .describe('Task execution type for slicing and estimate defaults'),
        due_date: z.string().optional().describe('Optional task due date'),
        priority: z
          .enum(['low', 'medium', 'high', 'urgent'])
          .optional()
          .describe('Task priority. "urgent" is accepted and normalized to "high".'),
        status: z
          .enum(['todo', 'in_progress', 'done', 'blocked', 'active'])
          .optional()
          .describe('Optional task status. "active" is accepted and normalized to "in_progress".'),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Task refs/IDs this task depends on'),
        goal_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Optional objective UUIDs for this task. This field is named goal_ids for API compatibility; use IDs from list_entities type=objective when the workspace requires a primary objective.'
          ),
        objective_ids: z
          .array(z.string())
          .optional()
          .describe('Preferred alias for goal_ids; objective UUIDs linked to this task.'),
        expected_duration_hours: z
          .number()
          .optional()
          .describe('Estimated task effort in hours'),
        expected_tokens: z
          .number()
          .optional()
          .describe('Estimated task token budget'),
        expected_budget_usd: z
          .number()
          .optional()
          .describe('Estimated task budget in USD'),
        assigned_agent_ids: z
          .array(z.string())
          .optional()
          .describe('Optional explicit assignee IDs for this task'),
        context: scaffoldContextSchema,
      })
      .passthrough();

    const scaffoldMilestoneSchema = z
      .object({
        ref: z
          .string()
          .optional()
          .describe('Optional stable client-side reference used in ref_map and dependencies'),
        title: z.string().min(1).describe('Milestone title'),
        description: z.string().optional().describe('Milestone description'),
        due_date: z.string().optional().describe('Optional milestone due date'),
        status: z
          .enum([
            'planned',
            'in_progress',
            'completed',
            'at_risk',
            'cancelled',
            'active',
          ])
          .optional()
          .describe('Optional milestone status. "active" is accepted and normalized to "in_progress".'),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Milestone refs/IDs this milestone depends on'),
        goal_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Optional objective UUIDs for this milestone. OrgX stores workspace objectives in goal_ids; provide at least one when the parent workspace requires a primary objective.'
          ),
        objective_ids: z
          .array(z.string())
          .optional()
          .describe('Preferred alias for goal_ids; objective UUIDs linked to this milestone.'),
        expected_duration_hours: z
          .number()
          .optional()
          .describe('Estimated milestone effort in hours'),
        expected_tokens: z
          .number()
          .optional()
          .describe('Estimated milestone token budget'),
        expected_budget_usd: z
          .number()
          .optional()
          .describe('Estimated milestone budget in USD'),
        context: scaffoldContextSchema,
        tasks: z
          .array(scaffoldTaskSchema)
          .optional()
          .describe('Nested tasks under this milestone'),
      })
      .passthrough();

    const scaffoldWorkstreamSchema = z
      .object({
        ref: z
          .string()
          .optional()
          .describe('Optional stable client-side reference used in ref_map and dependencies'),
        title: z
          .string()
          .optional()
          .describe(
            'Workstream title. REQUIRED on each workstream (provide either "title" or "name" — they are aliases).'
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Workstream name; alias for "title". REQUIRED on each workstream when "title" is not provided.'
          ),
        summary: z.string().optional().describe('Short workstream summary'),
        description: z.string().optional().describe('Workstream description'),
        persona: z.string().optional().describe('Workstream owner/persona label'),
        domain: z
          .string()
          .optional()
          .describe('Workstream domain (engineering, marketing, design, etc.)'),
        ownerAgent: z.string().optional().describe('Owner agent alias for this workstream'),
        primaryAgent: z
          .string()
          .optional()
          .describe('Primary agent alias for this workstream'),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Workstream refs/IDs this workstream depends on'),
        goal_ids: z
          .array(z.string())
          .optional()
          .describe(
            'Optional objective UUIDs for this workstream. OrgX stores workspace objectives in goal_ids; provide at least one when the parent workspace requires a primary objective.'
          ),
        objective_ids: z
          .array(z.string())
          .optional()
          .describe('Preferred alias for goal_ids; objective UUIDs linked to this workstream.'),
        expected_duration_hours: z
          .number()
          .optional()
          .describe('Estimated workstream effort in hours'),
        expected_tokens: z
          .number()
          .optional()
          .describe('Estimated workstream token budget'),
        expected_budget_usd: z
          .number()
          .optional()
          .describe('Estimated workstream budget in USD'),
        context: scaffoldContextSchema,
        milestones: z
          .array(scaffoldMilestoneSchema)
          .optional()
          .describe('Nested milestones under this workstream'),
      })
      .passthrough();

    if (shouldRegister('scaffold_initiative'))
    registerAppTool(
      this.server,
      'scaffold_initiative',
      {
        title: 'Scaffold an initiative hierarchy',
        description:
          'Turn an objective, roadmap, launch, or feature plan into executable workstreams, milestones, and tasks. Also known as: Scaffold an initiative hierarchy, scaffold project, create roadmap, generate execution plan, build a workstream tree.\n\n' +
          'Minimum required input: title.\n' +
          'Conditionally required:\n' +
          '  • workspace_id — REQUIRED unless the MCP session already carries workspace context (resolve via list_entities type=command_center or get_org_snapshot).\n' +
          '  • objective_ids (or goal_ids) — REQUIRED only when workspace policy enforces a primary objective. objective_ids is the preferred alias; goal_ids carries the same content for API compatibility.\n\n' +
          'Per-nested-entity rules (when workstreams[]/milestones[]/tasks[] are provided):\n' +
          '  • Each workstream MUST have either "title" or "name" set (they are aliases — provide one).\n' +
          '  • Each milestone MUST have "title" set.\n' +
          '  • Each task MUST have "title" set.\n' +
          '  • All other workstream/milestone/task fields are optional and can be omitted — the scaffold builder auto-fills defaults for missing domain/duration/owner/agent/budget.\n' +
          '  • "ref" is a client-side label used inside this single call (in depends_on and ref_map). It is not persisted as an ID.\n\n' +
          'Agent-safe aliases that are accepted and normalized server-side: task priority "urgent" → "high"; task/milestone status "active" → "in_progress".\n\n' +
          'USE WHEN: user wants to plan a new initiative from scratch. NEXT: use mode="launch" to create and start agents (default), mode="scaffold" to create without launching, or mode="draft" to validate the plan without writes. The result returns initiative_id, ref_map, and preferred_next_calls for orgx_inspect/orgx_search/orgx_write chaining. DO NOT USE: for adding a single task to an existing initiative — use create_entity instead.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: this.withClientContext({
          mode: z
            .enum(['draft', 'scaffold', 'launch'])
            .optional()
            .describe(
              'Optional stage. draft validates without writes; scaffold creates records without launching agents; launch creates records and starts agents. Defaults to launch for backwards compatibility.'
            ),
          response_mode: z
            .enum(['fast_ack', 'complete'])
            .optional()
            .describe(
              'Optional response timing. fast_ack returns after durable record creation and queues launch follow-ups asynchronously; complete waits for agent assignment, launch, and stream snapshot before returning. Defaults to fast_ack for non-draft scaffolds.'
            ),
          title: z.string().min(1).describe('Initiative title'),
          summary: z.string().optional().describe('Initiative summary'),
          description: z.string().optional().describe('Initiative description'),
          objective_ids: z
            .array(z.string())
            .optional()
            .describe(
              'Preferred objective UUIDs for the initiative. Normalized to goal_ids for API compatibility.'
            ),
          goal_ids: z
            .array(z.string())
            .optional()
            .describe(
              'Optional objective UUIDs for the initiative. OrgX stores workspace objectives in goal_ids; provide at least one to avoid objective-invariant failures.'
            ),
          idempotency_key: z
            .string()
            .min(8)
            .max(120)
            .optional()
            .describe(
              'Optional stable retry key. When omitted, OrgX derives one from workspace, owner, title, objectives, and hierarchy.'
            ),
          command_center_id: z
            .string()
            .optional()
            .describe(
              'Deprecated alias for workspace_id to scope the initiative hierarchy'
            ),
          workspace_id: z
            .string()
            .optional()
            .describe(
              'Workspace/command center UUID to scope the initiative hierarchy. Required unless the MCP session already has workspace context; resolve with list_entities type=command_center or get_org_snapshot.'
            ),
          context: scaffoldContextSchema,
          workstreams: z
            .array(scaffoldWorkstreamSchema)
            .optional()
            .describe(
              'Nested workstreams. Include domain, dependencies, and estimate fields when possible. If omitted, the scaffold builder auto-fills subtasks/dependencies and OrgX re-estimates domain+agent+cost with model-guided baselines.'
            ),
          coordination_dependency: z
            .object({
              name: z.string().describe('Short label for the dependency, e.g. "Design handoff dependency" or "QA gating dependency"'),
              fromWorkstreamName: z.string().describe('Name of the upstream workstream that must produce output first'),
              toWorkstreamName: z.string().describe('Name of the downstream workstream that is blocked until the upstream delivers'),
            })
            .optional()
            .describe(
              'The single most important cross-workstream coordination dependency you identified while planning this initiative. Name it specifically based on what the workstreams actually do — not a generic label. Omit if only one workstream exists.'
            ),
          owner_id: z
            .string()
            .optional()
            .describe(
              'Optional owner user ID for the scaffolded initiative; defaults to the authenticated user when omitted'
            ),
          user_id: z
            .string()
            .optional()
            .describe('Deprecated alias for owner_id; prefer owner_id for new calls'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Continue creating remaining entities after an error'),
          launch_after_create: z
            .boolean()
            .optional()
            .describe(
              'Legacy alias for mode. false maps to mode=scaffold; true maps to mode=launch when mode is omitted.'
            ),
          external_sync: z
            .object({
              targets: z
                .array(z.enum(['linear', 'jira']))
                .describe('Optional work-tracker targets to mirror after scaffold. Linear is active v1; Jira is a non-blocking stub.'),
              mode: z
                .enum(['project_and_tasks', 'tasks_only'])
                .optional()
                .describe('Mirror shape. Defaults to project_and_tasks.'),
              linear_project_id: z
                .string()
                .optional()
                .describe('Optional existing Linear project ID for tasks_only or project reuse.'),
            })
            .optional()
            .describe('Optional async mirror request for external work trackers. Omit for fastest scaffold response.'),
          concurrency: z
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe('Parallel creation concurrency (default 8)'),
        }),
        _meta: {
          'openai/visibility': 'public',
          'mcp/securitySchemes': SECURITY_SCHEMES.entityWriteRequiresAuth,
          securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
          ...SCAFFOLD_INITIATIVE_WIDGET_META,
        },
      },
      async (args: Record<string, unknown>) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'scaffold_initiative',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'scaffold initiative hierarchy',
          });
          if (authResponse) return authResponse;

          const sourceClient = resolveSourceClientFromContext(
            (args._context ?? undefined) as
              | Record<string, unknown>
              | undefined
          );
          const telemetryTrace = createScaffoldTelemetryTrace();
          const recordScaffoldTelemetry = (params: {
            status: 'success' | 'error';
            userId?: string | null;
            workspaceId?: string | null;
            errorCode?: string | null;
            metadata?: Record<string, unknown>;
          }) => {
            this.ctx.waitUntil(
              recordDurableMcpToolInvocation({
                env: this.env,
                toolId: 'scaffold_initiative',
                status: params.status,
                latencyMs: Date.now() - telemetryTrace.startedAt,
                metadata: telemetryTrace.snapshot(params.metadata),
                userId: params.userId,
                workspaceId: params.workspaceId,
                sourceClient,
                context: args._context,
                errorCode: params.errorCode,
                serverVersion: MCP_SERVER_VERSION,
                isWidgetTool: true,
              })
            );
          };

          const sanitizeErrorMessage = (error: unknown): string => {
            const raw =
              error instanceof Error
                ? error.message
                : typeof error === 'string'
                ? error
                : String(error);
            const compact = raw.replace(/\s+/g, ' ').trim();
            return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
          };

          const buildHumanErrorResponse = (params: {
            message: string;
            error: unknown;
            debug?: Record<string, unknown>;
          }) => {
            const safeError = sanitizeErrorMessage(params.error);
            const lowerError = safeError.toLowerCase();
            const needsWorkspace =
              lowerError.includes('workspace_id') ||
              lowerError.includes('workspace id') ||
              lowerError.includes('workspace is required') ||
              lowerError.includes('command_center_id') ||
              lowerError.includes('command center');
            const needsObjective =
              lowerError.includes('primary goal') ||
              lowerError.includes('goal invariant') ||
              lowerError.includes('goal_ids') ||
              lowerError.includes('objective');
            const nextSteps = needsWorkspace
              ? [
                  'Resolve a workspace first with list_entities type=command_center or get_org_snapshot',
                  'Retry scaffold_initiative with workspace_id set to that command center UUID',
                  'If you also see a primary-goal invariant, resolve objectives with list_entities type=objective and pass the chosen objective UUID in goal_ids',
                ]
              : needsObjective
              ? [
                  'Resolve objectives with list_entities type=objective',
                  'Retry scaffold_initiative with goal_ids set to one of those objective UUIDs; goal_ids is the API field name for objective IDs',
                  'Keep the same workspace_id/command_center_id on the retry',
                ]
              : [
                  'Re-run the same prompt (transient failures happen)',
                  'Set launch_after_create=false, then say "start agents"',
                  'Reduce concurrency (e.g. concurrency=2)',
                  'If this is an auth issue, reconnect and try again',
                ];
            const text = `${params.message}\n\nDetails: ${safeError}\n\nTry:\n${nextSteps
              .map((step) => `- ${step}`)
              .join('\n')}`;
            return {
              content: [{ type: 'text' as const, text }],
              structuredContent: {
                ok: false,
                error_kind: 'scaffold_initiative_failed',
                error: safeError,
                resolution_hint: needsWorkspace
                  ? 'workspace_id_required'
                  : needsObjective
                  ? 'objective_goal_ids_required'
                  : undefined,
                ...params.debug,
              },
            };
          };

          try {
            const modeResolution = resolveScaffoldMode(args);
            const objectiveAliasResult = normalizeScaffoldObjectiveAliases(args);
            const normalizedArgs = objectiveAliasResult.args;
            const responseModeResolution = resolveScaffoldResponseMode(
              normalizedArgs,
              modeResolution.mode
            );
            const contractWarnings: ScaffoldContractWarning[] = [
              ...modeResolution.warnings,
              ...objectiveAliasResult.warnings,
              ...responseModeResolution.warnings,
            ];
            const scaffoldMode = modeResolution.mode;
            const responseMode = responseModeResolution.responseMode;
            const explicitOwnerId =
              typeof normalizedArgs.owner_id === 'string'
                ? normalizedArgs.owner_id
                : typeof normalizedArgs.user_id === 'string'
                ? normalizedArgs.user_id
                : undefined;
            const ownerId = this.resolveUserId(explicitOwnerId);
            const continueOnError =
              typeof normalizedArgs.continue_on_error === 'boolean'
                ? normalizedArgs.continue_on_error
                : true;
            const launchAfterCreate = modeResolution.launchAfterCreate;
            const concurrencyInput =
              typeof normalizedArgs.concurrency === 'number'
                ? normalizedArgs.concurrency
                : 8;
            const concurrency = Math.max(1, Math.min(concurrencyInput, 20));

            // Free-tier guardrail: limit scaffolds per billing period.
            // Best-effort: if the billing endpoint is unavailable, don't block scaffolding.
            let billingUsage:
              | {
                  scaffoldsRemaining?: number;
                  scaffoldsIncluded?: number;
                  scaffoldsUsed?: number;
                  hasScaffolds?: boolean;
                  creditsRemaining?: number;
                  hasCredits?: boolean;
                  identity?: {
                    resolvedUserId?: string;
                    resolution?: string;
                  };
                  identityWarning?: {
                    code?: string;
                    message?: string;
                  };
                }
              | null = null;
            if (scaffoldMode !== 'draft') {
            try {
              const userEmail = this.resolveUserEmail();
              const usageResp = await callOrgxApiJson(
                this.env,
                '/api/billing/usage',
                undefined,
                {
                  userId: ownerId ?? resolvedUserId ?? undefined,
                  userEmail,
                }
              );
              billingUsage = (await usageResp.json()) as any;
              if (
                billingUsage?.identityWarning?.code ===
                'mcp_placeholder_identity'
              ) {
                const lines = [
                  `OrgX cannot scaffold from this MCP session yet because it is connected to a placeholder account, not your real OrgX account.`,
                  '',
                  billingUsage.identityWarning.message ??
                    'Reconnect OrgX MCP so usage, billing, and created entities resolve to the same account you use in the web app.',
                  '',
                  `After reconnecting, rerun the scaffold request. Do not treat this as a plan upgrade problem.`,
                ];

                recordScaffoldTelemetry({
                  status: 'error',
                  userId: ownerId ?? resolvedUserId ?? null,
                  errorCode: 'mcp_identity_mismatch',
                  metadata: {
                    mode: scaffoldMode,
                    failure_stage: 'billing_precheck',
                  },
                });
                return {
                  content: [{ type: 'text', text: lines.join('\n') }],
                  structuredContent: {
                    ok: false,
                    error_kind: 'mcp_identity_mismatch',
                    identity_warning: billingUsage.identityWarning,
                  },
                };
              }
              if (billingUsage && billingUsage.hasScaffolds === false) {
                const billingUrl = buildBillingSettingsUrl(this.env.ORGX_WEB_URL, {
                  source: 'mcp_scaffold_limit',
                  reason: 'scaffold_limit_reached',
                });
                const pricingUrl = buildPricingUrl(this.env.ORGX_WEB_URL, {
                  upgrade: 'true',
                  source: 'mcp_scaffold_limit',
                });

                // Build plan-aware message
                const used = billingUsage.scaffoldsUsed ?? 0;
                const included = billingUsage.scaffoldsIncluded ?? 0;
                const limitLabel = included === -1 ? 'unlimited' : String(included);

                const lines = [
                  `You've used ${used}/${limitLabel} scaffolds this billing period.`,
                  '',
                  `**Upgrade your plan** to get more scaffolds and unlock higher limits:`,
                  `→ Upgrade now: ${pricingUrl}`,
                  '',
                  `Or manage your current subscription:`,
                  `→ Billing settings: ${billingUrl}`,
                  '',
                  `You can also wait for the next billing period to reset your usage.`,
                ];

                recordScaffoldTelemetry({
                  status: 'error',
                  userId: ownerId ?? resolvedUserId ?? null,
                  errorCode: 'billing_scaffold_limit_reached',
                  metadata: {
                    mode: scaffoldMode,
                    failure_stage: 'billing_precheck',
                    scaffolds_used: used,
                    scaffolds_included: included,
                  },
                });
                return {
                  content: [
                    {
                      type: 'text',
                      text: lines.join('\n'),
                    },
                  ],
                  structuredContent: {
                    ok: false,
                    error_kind: 'billing_scaffold_limit_reached',
                    billing_url: billingUrl,
                    pricing_url: pricingUrl,
                    usage: billingUsage,
                  },
                };
              }
            } catch {
              billingUsage = null;
            }
            }
            telemetryTrace.mark('billing_precheck');

          const billingResolvedUserId =
            typeof billingUsage?.identity?.resolvedUserId === 'string' &&
            billingUsage.identity.resolvedUserId.trim().length > 0
              ? billingUsage.identity.resolvedUserId.trim()
              : null;
          const scaffoldOwnerId =
            billingResolvedUserId ?? ownerId ?? resolvedUserId ?? null;

          const explicitWorkspaceId =
            typeof (normalizedArgs as any).workspace_id === 'string' &&
            (normalizedArgs as any).workspace_id.trim().length > 0
              ? ((normalizedArgs as any).workspace_id as string).trim()
              : null;
          const explicitCommandCenterId =
            typeof (normalizedArgs as any).command_center_id === 'string' &&
            (normalizedArgs as any).command_center_id.trim().length > 0
              ? ((normalizedArgs as any).command_center_id as string).trim()
              : null;
          if (
            explicitWorkspaceId &&
            explicitCommandCenterId &&
            explicitWorkspaceId !== explicitCommandCenterId
          ) {
            recordScaffoldTelemetry({
              status: 'error',
              userId: scaffoldOwnerId,
              errorCode: 'workspace_alias_conflict',
              metadata: {
                mode: scaffoldMode,
                failure_stage: 'workspace_resolution',
              },
            });
            return this.toolError(
              'workspace_id and command_center_id must match when both are provided'
            );
          }
          const effectiveCommandCenterId =
            explicitWorkspaceId ??
            explicitCommandCenterId ??
            this.sessionContext?.workspaceId ??
            null;
          telemetryTrace.mark('workspace_resolution');

          if (!effectiveCommandCenterId && scaffoldMode !== 'draft') {
            const text = [
              'I need a workspace_id before I can scaffold this initiative.',
              '',
              'This MCP session does not include a workspace context, and creating the hierarchy without one will fail before any agents can launch.',
              '',
              'Suggested next calls:',
              '- orgx_search with type="workspace" to pick the workspace',
              '- orgx_search with type="objective" and workspace_id to pick objective UUIDs for goal_ids when the workspace requires a primary objective',
              '- scaffold_initiative again with workspace_id and, when available, goal_ids',
            ].join('\n');
            recordScaffoldTelemetry({
              status: 'error',
              userId: scaffoldOwnerId,
              errorCode: 'missing_workspace_context',
              metadata: {
                mode: scaffoldMode,
                failure_stage: 'workspace_resolution',
              },
            });
            return {
              content: [{ type: 'text' as const, text }],
              structuredContent: {
                ok: false,
                error_kind: 'missing_workspace_context',
                missing: ['workspace_id'],
                suggested_next_calls: [
                  {
                    tool: 'orgx_search',
                    arguments: {
                      type: 'workspace',
                      query: 'workspace',
                    },
                    purpose: 'Find the workspace_id for this scaffold.',
                  },
                  {
                    tool: 'orgx_search',
                    arguments: {
                      type: 'objective',
                      workspace_id: '<workspace_id>',
                    },
                    purpose:
                      'Find objective UUIDs to pass as goal_ids when required.',
                  },
                ],
              },
            };
          }

          const argsForBatch: Record<string, unknown> = {
            ...(normalizedArgs as unknown as Record<string, unknown>),
            // Ensure owner_id propagates into the batch so the initiative
            // gets created with an owner — prevents dispatch stalls when
            // the POST handler can't resolve owner from gateway headers.
            ...(scaffoldOwnerId ? { owner_id: scaffoldOwnerId } : {}),
          };

          if (effectiveCommandCenterId) {
            const shouldSet = (value: unknown) =>
              !(typeof value === 'string' && value.trim().length > 0);

            if (shouldSet(argsForBatch.workspace_id)) {
              argsForBatch.workspace_id = effectiveCommandCenterId;
            }
            if (shouldSet(argsForBatch.command_center_id)) {
              argsForBatch.command_center_id = effectiveCommandCenterId;
            }

            const patchNode = (node: Record<string, unknown>) => {
              if (shouldSet(node.workspace_id)) {
                node.workspace_id = effectiveCommandCenterId;
              }
              if (shouldSet(node.command_center_id)) {
                node.command_center_id = effectiveCommandCenterId;
              }
            };

            if (Array.isArray(argsForBatch.workstreams)) {
              argsForBatch.workstreams = (
                argsForBatch.workstreams as unknown[]
              ).map((ws) => {
                if (!ws || typeof ws !== 'object' || Array.isArray(ws))
                  return ws;
                const wsRec: Record<string, unknown> = {
                  ...(ws as Record<string, unknown>),
                };
                patchNode(wsRec);

                if (Array.isArray(wsRec.milestones)) {
                  wsRec.milestones = (wsRec.milestones as unknown[]).map(
                    (ms) => {
                      if (!ms || typeof ms !== 'object' || Array.isArray(ms))
                        return ms;
                      const msRec: Record<string, unknown> = {
                        ...(ms as Record<string, unknown>),
                      };
                      patchNode(msRec);

                      if (Array.isArray(msRec.tasks)) {
                        msRec.tasks = (msRec.tasks as unknown[]).map((t) => {
                          if (!t || typeof t !== 'object' || Array.isArray(t))
                            return t;
                          const tRec: Record<string, unknown> = {
                            ...(t as Record<string, unknown>),
                          };
                          patchNode(tRec);
                          return tRec;
                        });
                      }

                      return msRec;
                    }
                  );
                }

                return wsRec;
              });
            }
          }

          const scaffoldIdempotencyKey = deriveScaffoldIdempotencyKey({
            args: argsForBatch,
            workspaceId: effectiveCommandCenterId,
            ownerId: scaffoldOwnerId,
          });
          argsForBatch.idempotency_key = scaffoldIdempotencyKey;
          delete argsForBatch.idempotencyKey;
          const externalSync = normalizeExternalSyncRequest(
            argsForBatch.external_sync ?? argsForBatch.externalSync
          );
          delete argsForBatch.response_mode;
          delete argsForBatch.responseMode;

          const {
            batch,
            initiativeRef,
            wsRefs,
            msRefs,
            taskRefs,
            materializedDependencies,
            warnings: buildWarnings,
          } =
            buildScaffoldInitiativeBatch(
              argsForBatch as unknown as Record<string, unknown>
            );
          const allContractWarnings = [...contractWarnings, ...buildWarnings];
          telemetryTrace.mark('batch_build');

          if (scaffoldMode === 'draft') {
            const draftPayload = buildScaffoldDraftResult({
              batch,
              workspaceId: effectiveCommandCenterId,
              idempotencyKey: scaffoldIdempotencyKey,
              contractWarnings: allContractWarnings,
              dependencyEdges: materializedDependencies,
            });
            telemetryTrace.mark('draft_response');
            recordScaffoldTelemetry({
              status: 'success',
              userId: scaffoldOwnerId,
              workspaceId: effectiveCommandCenterId,
              metadata: {
                mode: scaffoldMode,
                requested_count: batch.length,
                dependency_edge_count: materializedDependencies.length,
                contract_warning_count: allContractWarnings.length,
                idempotency_key_present: Boolean(scaffoldIdempotencyKey),
              },
            });
            return {
              content: buildJsonFirstContentBlocks({
                data: draftPayload,
                summary: draftPayload.summary,
              }),
              structuredContent: draftPayload,
            };
          }

          const result = await runBatchCreateEntities({
            env: this.env,
            callApi: ({ env, path, init, userId }) =>
              callOrgxApiJson(env, path, init, {
                userId,
                userEmail: this.resolveUserEmail(),
              }),
            findExistingEntity: ({ body }) =>
              this.findExistingEntityByIdempotencyKey({
                body,
                idempotencyKey: readEntityIdempotencyKey(body),
                userId: scaffoldOwnerId,
              }),
            entities: batch,
            ownerId: scaffoldOwnerId,
            continueOnError,
            concurrency,
          });
          telemetryTrace.mark('entity_create');

          const hierarchy = buildScaffoldHierarchy({
            result,
            batch,
            initiativeRef,
            wsRefs,
            msRefs,
            taskRefs,
          });

          const createdInitiativeId =
            typeof (hierarchy as any)?.initiative?.id === 'string'
              ? ((hierarchy as any).initiative.id as string)
              : null;

          const liveUrl = createdInitiativeId
            ? buildLiveUrl(createdInitiativeId)
            : null;

          if (createdInitiativeId) {
            this.sessionContext = {
              ...this.sessionContext,
              initiativeId: createdInitiativeId,
            };
            const saveContext = this.saveSessionContext();
            if (responseMode === 'fast_ack') {
              this.ctx.waitUntil(saveContext);
            } else {
              await saveContext;
            }
          }

          const followups =
            responseMode === 'fast_ack'
              ? buildQueuedScaffoldFollowups({
                  createdInitiativeId,
                  launchAfterCreate,
                })
              : await runScaffoldPostCreateFollowups({
                  env: this.env,
                  createdInitiativeId,
                  launchAfterCreate,
                  effectiveCommandCenterId,
                  scaffoldOwnerId,
                  hierarchy,
                  resolveUserEmail: () => this.resolveUserEmail(),
                  onStage: (stage) => telemetryTrace.mark(stage),
                });

          if (responseMode === 'fast_ack') {
            telemetryTrace.mark('post_create_enqueue');
            this.ctx.waitUntil(
              runScaffoldPostCreateFollowups({
                env: this.env,
                createdInitiativeId,
                launchAfterCreate,
                effectiveCommandCenterId,
                scaffoldOwnerId,
                hierarchy,
                resolveUserEmail: () => this.resolveUserEmail(),
              }).catch((error) => {
                console.warn('[scaffold:followups] async follow-up failed', {
                  initiativeId: createdInitiativeId,
                  error: error instanceof Error ? error.message : String(error),
                });
              })
            );
          }

          const {
            agent_assignment,
            scaffold_usage,
            credential_status,
            launch,
            streams,
            fallback_agent_dispatch,
          } = followups;


              // ── Scaffold stream session ──
              // Push created entities as SSE events into ScaffoldSessionDO so the
              // widget can replay them as an animated tree. Fire-and-forget.
              let scaffold_stream_url: string | undefined;
              let scaffold_session_id: string | undefined;
              try {
                scaffold_session_id = crypto.randomUUID();
                scaffold_stream_url = `${this.env.MCP_SERVER_URL}/scaffold/${scaffold_session_id}/stream`;
                const _doId = this.env.SCAFFOLD_SESSION.idFromName(scaffold_session_id);
                const _stub = this.env.SCAFFOLD_SESSION.get(_doId);
                const _internalHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
                if (this.env.ORGX_INTERNAL_SECRET) {
                  _internalHeaders['Authorization'] = `Bearer ${this.env.ORGX_INTERNAL_SECRET}`;
                }
                const _pushEvent = async (payload: Record<string, unknown>) => {
                  await _stub.fetch(
                    `https://internal/scaffold/${scaffold_session_id}/event`,
                    { method: 'POST', headers: _internalHeaders, body: JSON.stringify(payload) }
                  );
                };
                const _emitEvents = async () => {
                  await _pushEvent({ type: 'session.start', sessionId: scaffold_session_id, title: typeof normalizedArgs.title === 'string' ? normalizedArgs.title : undefined, ts: Date.now() });
                  const _entities = result.results ?? [];
                  const _total = _entities.length;
                  for (let _i = 0; _i < _entities.length; _i++) {
                    const _item = _entities[_i]!;
                    if (!_item.success) continue;
                    const _data = (_item.data ?? {}) as Record<string, unknown>;
                    await _pushEvent({ type: 'entity.created', entityType: String(_data.type ?? _data.entity_type ?? 'entity'), entity: _data, index: _i, total: _total, ts: Date.now() });
                  }
                  await _pushEvent({ type: 'scaffold.complete', initiativeId: createdInitiativeId, liveUrl: liveUrl ?? null, totalEntities: _entities.filter((e: { success: boolean }) => e.success).length, ts: Date.now() });
                };
                this.ctx.waitUntil(_emitEvents());
              } catch (_streamErr) {
                console.warn('[scaffold:stream] session setup failed', { error: _streamErr });
              }

              let external_sync:
                | (ExternalSyncRequest & { status: 'queued' })
                | undefined;
              if (createdInitiativeId && externalSync) {
                external_sync = { ...externalSync, status: 'queued' };
                this.ctx.waitUntil(
                  callOrgxApiJson(
                    this.env,
                    '/api/integrations/work-graph/mirror',
                    {
                      method: 'POST',
                      body: JSON.stringify({
                        source: 'scaffold_initiative',
                        initiative_id: createdInitiativeId,
                        workspace_id: effectiveCommandCenterId,
                        idempotency_key: scaffoldIdempotencyKey,
                        targets: externalSync.targets,
                        mode: externalSync.mode,
                        linear_project_id: externalSync.linear_project_id,
                        ref_map: result.ref_map,
                        hierarchy,
                      }),
                    },
                    {
                      userId: scaffoldOwnerId ?? undefined,
                      userEmail: this.resolveUserEmail(),
                    }
                  ).catch((error) => {
                    console.warn('[scaffold:external-sync] mirror failed', {
                      initiativeId: createdInitiativeId,
                      targets: externalSync.targets,
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                  })
                );
              }
              telemetryTrace.mark('external_sync_enqueue');

              const firstAgentWork = buildFirstAgentWorkState({
                mode: scaffoldMode,
                initiativeId: createdInitiativeId,
                launch: (launch ?? null) as Record<string, unknown> | null,
                streams: (streams ?? null) as Record<string, unknown> | null,
                fallbackAgentDispatch: (fallback_agent_dispatch ?? null) as
                  | Record<string, unknown>
                  | null,
              });
              const replayedEntityCount = result.results.filter(
                (entry) => entry.success && entry.skipped
              ).length;

              const benchmarkMetrics = {
                mode: scaffoldMode,
                response_mode: responseMode,
                requested_count: result.total,
                created_count: result.created_count,
                failed_count: result.failed_count,
                replayed_entity_count: replayedEntityCount,
                response_contract: 'compact_scaffold_result',
                dependency_edge_count: materializedDependencies.length,
                idempotency_key_present: Boolean(scaffoldIdempotencyKey),
                first_agent_status: firstAgentWork.status,
                external_sync_target_count: externalSync?.targets.length ?? 0,
                external_sync_status: external_sync?.status ?? 'not_requested',
              };

              const compactScaffoldPayload = buildCompactScaffoldResult({
                result,
                hierarchy,
                mode: scaffoldMode,
                responseMode,
                initiativeId: createdInitiativeId,
                workspaceId: effectiveCommandCenterId,
                liveUrl,
                idempotencyKey: scaffoldIdempotencyKey,
                contractWarnings: allContractWarnings,
                dependencyEdges: materializedDependencies,
                firstAgentWork,
                externalSync: external_sync,
                benchmarkMetrics,
                scaffoldStreamUrl: scaffold_stream_url,
                scaffoldSessionId: scaffold_session_id,
                agentAssignment: agent_assignment,
                credentialStatus: credential_status,
                launch,
                streams,
                billingUsage: billingUsage ?? undefined,
                scaffoldUsage: scaffold_usage,
                fallbackAgentDispatch: fallback_agent_dispatch,
              });

	          const activationSummary =
	            launch?.initiative_activation &&
	            typeof launch.initiative_activation === 'object'
	              ? `\nStreams: +${launch.initiative_activation.created_stream_count} created, ${launch.initiative_activation.redispatched_stream_count} dispatched${
	                  launch.initiative_activation.error
	                    ? ` (warning: ${launch.initiative_activation.error})`
	                    : ''
	                }`
	              : '';
	
		          const streamSnapshotSummary =
		            streams && streams.total > 0
	              ? `\nStreams snapshot: ${streams.total} total${
	                  streams.by_status.ready ? `, ${streams.by_status.ready} ready` : ''
	                }${
	                  streams.by_status.active
	                    ? `, ${streams.by_status.active} active`
	                    : ''
	                }${
	                  streams.by_status.pending
	                    ? `, ${streams.by_status.pending} pending`
	                    : ''
	                }`
		              : '';

              const fallbackDispatchSummary =
                fallback_agent_dispatch?.attempted
                  ? fallback_agent_dispatch.ok
                    ? `\nFallback dispatch: spawned ${fallback_agent_dispatch.agent ?? 'agent'}`
                    : `\nFallback dispatch warning: ${
                        fallback_agent_dispatch.error ?? 'failed'
                      }`
                  : '';
		
		          const agentAssignmentSummary =
		            agent_assignment?.attempted
		              ? agent_assignment.ok
		                ? `\nAgents: assigned ${agent_assignment.assigned_count ?? 0} workstream(s)`
		                : `\nAgent assignment warning: ${agent_assignment.error ?? 'failed'}`
		              : '';

		          const credentialWarning =
		            launch?.needs_credentials
		              ? `\n\n⚠️ Execution account required: ${launch.next_steps?.join('. ') ?? 'Configure execution at /settings/execution'}`
		              : '';

		          const startAgentsHint =
		            createdInitiativeId && (!launchAfterCreate || (launch && launch.ok === false))
		              ? `\n\nNext: ${launch?.start_agents_hint ?? 'say "start agents" (or re-run launch) to begin automated execution.'}`
		              : `\n\nNext: open the live view to watch progress. If agents don't start automatically, try: "start agents".`;

		          const launchSummary = launch
		            ? launch.attempted
		              ? launch.ok
		                ? `\n\nLaunch: ${launch.message ?? 'Initiative launched'}${activationSummary}${streamSnapshotSummary}${fallbackDispatchSummary}${agentAssignmentSummary}${startAgentsHint}`
		                : `\n\nLaunch warning: ${launch.error ?? 'unknown error'}${launch.next_steps ? '\nNext steps: ' + launch.next_steps.join('. ') : ''}`
		              : launch.queued_async
		                ? `\n\nLaunch: queued asynchronously after scaffold creation${agentAssignmentSummary}${startAgentsHint}`
		              : launch.needs_credentials
		                ? `\n\nLaunch: skipped (credentials required)${credentialWarning}${agentAssignmentSummary}`
		                : '\n\nLaunch: skipped (launch_after_create=false)'
		            : '';

              let activationPayload: {
                experience?: ReturnType<typeof buildClientActivationExperience>;
                text: string;
              } = { text: '' };
              const activationObservation = {
                toolId: 'scaffold_initiative',
                args: normalizedArgs as Record<string, unknown>,
                data: compactScaffoldPayload,
                userId: scaffoldOwnerId,
                sourceClient,
                workspaceId: effectiveCommandCenterId,
                initiativeId: createdInitiativeId,
              };
              if (responseMode === 'fast_ack') {
                this.ctx.waitUntil(
                  this.recordMcpActivationObservation(activationObservation).then(
                    () => undefined
                  )
                );
              } else {
                const activationEvents =
                  await this.recordMcpActivationObservation(
                    activationObservation
                  );
                activationPayload = this.buildClientActivationPayload({
                  sourceClient,
                  events: activationEvents,
                });
              }
              const countTasks = (v: any): number => {
                if (!v) return 0;
                if (Array.isArray(v)) return v.reduce((sum, i) => sum + countTasks(i), 0);
                if (typeof v !== 'object') return 0;
                let c = v.type === 'task' || v.entity_type === 'task' ? 1 : 0;
                for (const k of ['tasks', 'workstreams', 'milestones', 'hierarchy', 'data']) {
                  if (k in v) c += countTasks(v[k]);
                }
                return c;
              };
              const summaryStats =
                compactScaffoldPayload.summary_stats as Record<string, unknown>;
              const compactTaskCount =
                typeof summaryStats.task_count === 'number'
                  ? summaryStats.task_count
                  : countTasks(hierarchy);
              const expectedTokens = Math.max(8_000, compactTaskCount * 4_500);
              const etaSeconds = Math.max(120, Math.floor(expectedTokens / (6500 / 3600)));
              const estimatedCost = Number(((expectedTokens / 1000) * 0.012).toFixed(4));

              const finalPayload = activationPayload.experience
                ? {
                    ...compactScaffoldPayload,
                    estimated_time_seconds: etaSeconds,
                    estimated_cost: estimatedCost,
                    client_activation: activationPayload.experience,
                  }
                : {
                    ...compactScaffoldPayload,
                    estimated_time_seconds: etaSeconds,
                    estimated_cost: estimatedCost,
                  };
              telemetryTrace.mark('response_build');
              recordScaffoldTelemetry({
                status: 'success',
                userId: scaffoldOwnerId,
                workspaceId: effectiveCommandCenterId,
                metadata: {
                  mode: scaffoldMode,
                  response_mode: responseMode,
                  requested_count: result.total,
                  created_count: result.created_count,
                  failed_count: result.failed_count,
                  replayed_entity_count: replayedEntityCount,
                  dependency_edge_count: materializedDependencies.length,
                  contract_warning_count: allContractWarnings.length,
                  idempotency_key_present: Boolean(scaffoldIdempotencyKey),
                  first_agent_status: firstAgentWork.status,
                  external_sync_target_count: externalSync?.targets.length ?? 0,
                  external_sync_status:
                    external_sync?.status ?? 'not_requested',
                  response_size_bytes: JSON.stringify(finalPayload).length,
                },
              });

              // The registered scaffolded-initiative resource renders from the
              // compact structured payload. Avoid returning a second inline
              // SSE-only widget: Claude drops or externalizes very large tool
              // results, and the inline EventSource path can remain stuck when
              // the host does not connect to the stream.

              // CLI/API fallback: plain-text summary for clients that don't render HTML
              const _cliFallback = [
                result.summary,
                liveUrl ? `\n\n📺 Live view: ${liveUrl}` : '',
                scaffold_stream_url ? `\n🌊 Real-time stream: ${scaffold_stream_url}` : '',
                launchSummary,
                activationPayload.text,
              ].join('').trim();

              return {
                content: buildJsonFirstContentBlocks({
                  data: finalPayload,
                  summary: _cliFallback,
                }),
                structuredContent: finalPayload,
              };
            } catch (error) {
              recordScaffoldTelemetry({
                status: 'error',
                errorCode:
                  classifyErrorKind(error instanceof Error ? error.message : String(error)) ??
                  'scaffold_initiative_failed',
                metadata: {
                  failure_stage: 'unknown',
                },
              });
              return buildHumanErrorResponse({
                message:
                  'Scaffold failed while creating your initiative hierarchy.',
                error,
              });
            }
          })
    );

    /**
     * get_task_with_context - Fetch a task plus hydrated context pointers.
     */
    if (shouldRegister('get_task_with_context'))
    this.server.registerTool(
      'get_task_with_context',
      {
        title: 'Get task with context',
        description:
          'Fetch a task with hydrated context attachments (entities, artifacts, plan sessions). USE WHEN: agent needs full task context before executing, or user wants task details. NEXT: Use entity_action to update task status. DO NOT USE: for listing tasks — use list_entities type=task instead.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          task_id: z.string().min(1).describe('Task ID'),
          hydrate: z
            .boolean()
            .optional()
            .describe(
              'Whether to hydrate entity/artifact/plan_session context pointers (default true)'
            ),
          max_chars: z
            .number()
            .min(1000)
            .max(50000)
            .optional()
            .describe(
              'Approximate max characters for hydrated context payload (default 20000)'
            ),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'get_task_with_context',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'read tasks',
          });
          if (authResponse) return authResponse;

          const hydrate = args.hydrate !== false;

          const fetchEntity = async (type: string, id: string) => {
            const params = new URLSearchParams();
            params.set('type', type);
            params.set('id', id);
            params.set('limit', '1');
            const response = await callOrgxApiJson(
              this.env,
              `/api/entities?${params.toString()}`,
              undefined,
              { userId: resolvedUserId }
            );
            const payload = (await response.json()) as {
              type: string;
              data: Array<Record<string, unknown>>;
            };
            return payload.data?.[0] ?? null;
          };

          const taskRow = await fetchEntity('task', String(args.task_id));
          if (!taskRow) {
            return this.toolError(`Task not found: ${args.task_id}`);
          }

          const context = Array.isArray((taskRow as any).context)
            ? ((taskRow as any).context as unknown[])
            : [];

          if (!hydrate || context.length === 0) {
            const payload = { task: taskRow, context, hydrated_context: [] };
            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('get_task_with_context', payload),
                },
              ],
              structuredContent: payload,
            };
          }
          const hydrationAccess = await resolveHydrationAccessContext(
            this.env,
            resolvedUserId!
          );
          const maxChars = resolveHydrationMaxChars(
            args.max_chars,
            hydrationAccess.tier
          );
          const hydratedResult = await hydrateTaskContext({
            context,
            fetchEntity,
            maxChars,
          });
          const { hydrated, truncated, usedChars } = applyHydrationAccessTier({
            hydrated: hydratedResult.hydrated,
            maxChars,
            tier: hydrationAccess.tier,
            truncated: hydratedResult.truncated,
          });

          const payload = {
            task: taskRow,
            context,
            hydrated_context: hydrated,
            truncated,
            max_chars: maxChars,
            used_chars: usedChars,
            context_access_tier: hydrationAccess.tier,
            context_plan: hydrationAccess.plan,
          };

          return {
            content: [
              {
                type: 'text',
                text: formatForLLM('get_task_with_context', payload),
              },
            ],
            structuredContent: payload,
          };
        })
    );

    /**
     * batch_delete_entities - Delete multiple entities in one tool call.
     */
    if (shouldRegister('batch_delete_entities'))
    this.server.registerTool(
      'batch_delete_entities',
      {
        title: 'Batch delete entities',
        description:
          "Delete multiple entities in one call (hard delete). USE WHEN: user explicitly wants to remove entities permanently. NEXT: Verify deletion succeeded. DO NOT USE: for archiving or pausing — use entity_action instead.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          entities: z
            .array(
              z.object({
                type: lifecycleEntityTypeEnum.describe('Entity type'),
                id: z.string().min(1).describe('Entity ID'),
              })
            )
            .min(1)
            .max(100),
          concurrency: z
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe('Parallel deletion concurrency (default 8)'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Continue deleting remaining entities after an error'),
          note: z.string().optional().describe('Optional reason note'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'batch_delete_entities',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'batch delete entities',
          });
          if (authResponse) return authResponse;

          const continueOnError = args.continue_on_error !== false;
          const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 20));
          const entities = args.entities as Array<{ type: string; id: string }>;

          const results: Array<Record<string, unknown>> = new Array(
            entities.length
          );
          let nextIndex = 0;
          let shouldStop = false;

          const worker = async () => {
            while (true) {
              if (shouldStop && !continueOnError) return;
              const index = nextIndex++;
              if (index >= entities.length) return;

              const target = entities[index];
              try {
                const response = await callOrgxApiJson(
                  this.env,
                  `/api/entities/${target.type}/${target.id}/delete`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      note: args.note,
                      reason: args.note,
                    }),
                  },
                  { userId: resolvedUserId ?? null }
                );
                const payload = (await response.json()) as Record<
                  string,
                  unknown
                >;
                results[index] = {
                  index,
                  success: true,
                  type: target.type,
                  id: target.id,
                  data: payload,
                };
              } catch (error) {
                results[index] = {
                  index,
                  success: false,
                  type: target.type,
                  id: target.id,
                  error: error instanceof Error ? error.message : String(error),
                };
                shouldStop = true;
              }
            }
          };

          const workerCount = Math.min(concurrency, entities.length);
          await Promise.all(
            Array.from({ length: workerCount }, () => worker())
          );

          const deleted = results.filter((result) => result?.success === true);
          const failed = results.filter((result) => result?.success !== true);
          const summary = `Deleted ${deleted.length}/${
            entities.length
          } entities${failed.length > 0 ? ` (${failed.length} failed)` : ''}.`;

          return {
            content: [{ type: 'text', text: summary }],
            structuredContent: {
              summary,
              total: entities.length,
              deleted_count: deleted.length,
              failed_count: failed.length,
              results,
            },
          };
        })
    );

    /**
     * batch_action - Execute lifecycle actions on multiple entities in one call.
     */
    if (shouldRegister('batch_action'))
    this.server.registerTool(
      'batch_action',
      {
        title: 'Batch entity actions',
        description:
          "Execute actions on multiple entities in one call (pause, launch, complete, resume, etc.). USE WHEN: bulk state changes like pausing multiple initiatives or completing multiple tasks. ACCEPTS: short ID prefixes (8+ chars) — no need to look up full UUIDs. Supports the same launch/pause aliases as entity_action. NEXT: Verify all actions succeeded. DO NOT USE: for deletes — use batch_delete_entities instead.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          actions: z
            .array(
              z.object({
                type: lifecycleEntityTypeEnum.describe('Entity type'),
                id: z.string().min(1).describe('Entity ID (full UUID or short prefix 8+ hex chars)'),
                action: z.string().min(1).describe('Action to execute (pause, launch, complete, resume, etc.). launch and pause are resolved per entity type.'),
                note: z.string().optional().describe('Optional note/reason for this action'),
                force: z
                  .boolean()
                  .optional()
                  .describe('Force action when server supports override semantics'),
              })
            )
            .min(1)
            .max(100)
            .describe('List of lifecycle actions to execute in bulk.'),
          concurrency: z
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe('Parallel action concurrency (default 8)'),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Continue processing remaining actions after an error (default true)'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'batch_action',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'batch entity actions',
          });
          if (authResponse) return authResponse;

          const continueOnError = args.continue_on_error !== false;
          const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 20));
          const actions = args.actions as Array<{
            type: string;
            id: string;
            action: string;
            note?: string;
            force?: boolean;
          }>;

          const results: Array<Record<string, unknown>> = new Array(
            actions.length
          );
          let nextIndex = 0;
          let shouldStop = false;

          const worker = async () => {
            while (true) {
              if (shouldStop && !continueOnError) return;
              const index = nextIndex++;
              if (index >= actions.length) return;

              const target = actions[index];
              try {
                const resolvedAction = resolveLifecycleActionAlias(
                  target.type,
                  target.action
                );
                const response = await callOrgxApiJson(
                  this.env,
                  `/api/entities/${target.type}/${target.id}/${resolvedAction}`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      note: target.note,
                      reason: target.note,
                      force: target.force,
                    }),
                  },
                  { userId: resolvedUserId ?? null }
                );
                const payload = (await response.json()) as Record<
                  string,
                  unknown
                >;
                const success = payload.success !== false && !payload.error;
                results[index] = {
                  index,
                  success,
                  type: target.type,
                  id: target.id,
                  action: resolvedAction,
                  requested_action: target.action,
                  message: payload.message ?? payload.error ?? undefined,
                  transition: payload.transition ?? undefined,
                };
                if (!success) shouldStop = true;
              } catch (error) {
                results[index] = {
                  index,
                  success: false,
                  type: target.type,
                  id: target.id,
                  action: resolveLifecycleActionAlias(
                    target.type,
                    target.action
                  ),
                  requested_action: target.action,
                  error: error instanceof Error ? error.message : String(error),
                };
                shouldStop = true;
              }
            }
          };

          const workerCount = Math.min(concurrency, actions.length);
          await Promise.all(
            Array.from({ length: workerCount }, () => worker())
          );

          const succeeded = results.filter((r) => r?.success === true);
          const failed = results.filter((r) => r?.success !== true);

          // Build a compact summary. Group by action for readability.
          const actionCounts = new Map<string, number>();
          for (const r of succeeded) {
            const key = `${r.action}`;
            actionCounts.set(key, (actionCounts.get(key) ?? 0) + 1);
          }
          const actionSummary = Array.from(actionCounts.entries())
            .map(([action, count]) => `${action}: ${count}`)
            .join(', ');

          const summary = failed.length > 0
            ? `Completed ${succeeded.length}/${actions.length} actions (${failed.length} failed). ${actionSummary}`
            : `${actionSummary || 'All'} — ${succeeded.length}/${actions.length} succeeded.`;
          const failedDetails =
            failed.length > 0
              ? `\n\nfailed:\n${failed
                  .slice(0, 10)
                  .map((item) => {
                    const message =
                      typeof item.error === 'string'
                        ? item.error
                        : typeof item.message === 'string'
                        ? item.message
                        : 'unknown error';
                    return `- [${item.index}] ${item.type} ${item.id} ${item.action}: ${message}`;
                  })
                  .join('\n')}${
                  failed.length > 10
                    ? `\n... and ${failed.length - 10} more failure(s)`
                    : ''
                }`
              : '';

          return {
            content: [{ type: 'text', text: `${summary}${failedDetails}` }],
            structuredContent: {
              summary,
              total: actions.length,
              succeeded: succeeded.length,
              failed: failed.length,
              results,
            },
          };
        })
    );

    /**
     * update_entity - Update any entity type by ID
     */
    if (shouldRegister('update_entity'))
    this.server.registerTool(
      'update_entity',
      {
        title: 'Update an entity',
        description: `Update an existing entity. Only include fields you want to change. USE WHEN: modifying entity fields (title, description, priority, etc.). NEXT: Confirm changes to user. DO NOT USE: for status changes — use entity_action instead.`,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          type: entityTypeEnum.describe('Entity type to update'),
          id: z.string().describe('Entity ID'),
          title: z.string().optional().describe('New title/name'),
          name: z.string().optional().describe('New name'),
          summary: z.string().optional().describe('New summary'),
          description: z.string().optional().describe('New description'),
          context: z
            .array(z.record(z.unknown()))
            .optional()
            .describe(
              'Optional context attachments (initiative, workstream, milestone, task). Each entry is a pointer with a relevance note.'
            ),
          status: z.string().optional().describe('New status'),
          due_date: z.string().optional().describe('New due date (YYYY-MM-DD)'),
          sequence: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'New execution order for initiative/workstream/milestone/task (lower runs first)'
            ),
          priority: z
            .enum(['low', 'medium', 'high', 'urgent'])
            .optional()
            .describe('New priority'),
          agent_domain: z
            .string()
            .optional()
            .describe(
              'Agent domain for streams (engineering, marketing, sales, operations, design, product, orchestration)'
            ),
          auto_continue: z
            .boolean()
            .optional()
            .describe('Whether the stream should auto-run when ready'),
          proof_profile: z
            .enum(['full', 'subcomponent', 'release', 'external_artifact'])
            .optional()
            .describe(
              'Proof-chain profile (task/milestone only). Controls completion evidence required before the entity can be marked complete. "full" = independent artifact + quality_score + rubric; "subcomponent" = parent ships proof via milestone ship_batch; "release" = external ship event closes the loop; "external_artifact" = artifact lives outside OrgX, link only. See https://mcp.useorgx.com/docs/proof-chain.'
            ),
          // Skill-specific fields
          prompt_template: z
            .string()
            .optional()
            .describe(SKILL_PROMPT_TEMPLATE_SAFETY_DESCRIPTION),
          trigger_keywords: z
            .array(z.string())
            .optional()
            .describe('Updated keywords (for skills)'),
          trigger_domains: z
            .array(z.string())
            .optional()
            .describe('Updated domains (for skills)'),
          checklist: z
            .array(
              z.object({ item: z.string(), critical: z.boolean().optional() })
            )
            .optional()
            .describe('Updated checklist (for skills)'),
          // Plan session fields
          current_plan: z
            .string()
            .optional()
            .describe('Updated plan content (for plan_session)'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const { type, id, ...updates } = args;

          // Resolve userId for auth propagation
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;

          const authResponse = buildAuthRequiredResponse({
            toolId: 'update_entity',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'update entities',
          });
          if (authResponse) return authResponse;

          // Build payload, gating fields to types whose tables have them
          const {
            due_date,
            sequence,
            priority,
            agent_domain,
            auto_continue,
            prompt_template,
            proof_profile,
            ...safeUpdates
          } = updates as Record<string, unknown>;

          const payload: Record<string, unknown> = {
            type,
            id,
            ...safeUpdates,
          };

          // proof_profile (tasks/milestones only) merges into metadata.
          if (
            typeof proof_profile === 'string' &&
            (type === 'task' || type === 'milestone')
          ) {
            const existingMetadata =
              (payload.metadata as Record<string, unknown> | undefined) ?? {};
            payload.metadata = {
              ...existingMetadata,
              proof_profile,
            };
          }

          if (prompt_template !== undefined) {
            if (type !== 'skill') {
              return this.toolError(
                'prompt_template can only be updated on skill entities',
                { code: 'invalid_skill_prompt_template', status: 400 }
              );
            }

            try {
              payload.prompt_template = validateSkillPromptTemplate(
                prompt_template as string
              );
            } catch (error) {
              return this.toolError(
                error instanceof Error
                  ? error.message
                  : 'Invalid skill prompt_template',
                { code: 'invalid_skill_prompt_template', status: 400 }
              );
            }
          }

          // due_date exists on: milestones, workstream_tasks
          if (
            due_date !== undefined &&
            (type === 'task' || type === 'milestone')
          ) {
            payload.due_date = due_date;
          }
          // sequence exists on: initiatives, workstreams, milestones, workstream_tasks
          if (
            sequence !== undefined &&
            (type === 'initiative' ||
              type === 'workstream' ||
              type === 'milestone' ||
              type === 'task')
          ) {
            payload.sequence = sequence;
          }
          // priority exists on: workstreams, milestones, workstream_tasks, decisions
          if (
            priority !== undefined &&
            (type === 'workstream' ||
              type === 'milestone' ||
              type === 'task' ||
              type === 'decision')
          ) {
            payload.priority = priority;
          }
          if (type === 'stream') {
            if (agent_domain !== undefined) payload.agent_domain = agent_domain;
            if (auto_continue !== undefined) payload.auto_continue = auto_continue;
          }

          const response = await callOrgxApiJson(
            this.env,
            '/api/entities',
            {
              method: 'PATCH',
              body: JSON.stringify(payload),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as {
            type: string;
            data: { id: string; title?: string; name?: string };
          };

          const name = result.data.title ?? result.data.name ?? 'entity';
          const link = entityLinkMarkdown(type, result.data.id, name);
          return {
            content: [
              {
                type: 'text',
                text: `✓ Updated ${type}: ${link}`,
              },
            ],
          };
        })
    );

    // =========================================================================
    // CONSOLIDATED TOOLS
    // workspace, configure_org, and stats are handled inline below
    // =========================================================================

    /**
     * configure_org - Consolidated org setup, agent config, and policy management
     */
    if (shouldRegister('configure_org'))
    this.server.registerTool(
      'configure_org',
      {
        title: 'Configure Organization',
        description:
          'Check setup status, configure agents, or set org policies. action=status for progress, action=configure_agent to set agent preferences, action=set_policy for org-wide rules.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          action: z.enum(['status', 'configure_agent', 'set_policy']).describe('Configuration operation'),
          agent_type: z.enum(['product', 'engineering', 'marketing', 'sales', 'operations', 'design', 'orchestrator']).optional().describe('Agent type (configure_agent only)'),
          trust_level: z.enum(['strict', 'balanced', 'autonomous']).optional().describe('Agent autonomy level (configure_agent only)'),
          focus_areas: z.array(z.string()).optional().describe('Agent focus areas (configure_agent only)'),
          approval_required: z.array(z.string()).optional().describe('Actions requiring approval (configure_agent only)'),
          skip_approval: z.array(z.string()).optional().describe('Actions without approval (configure_agent only)'),
          policy_type: z.enum(CONFIGURE_ORG_POLICY_TYPES).optional().describe('Policy type (set_policy only)'),
          config: z.record(z.any()).optional().describe('Policy configuration (set_policy only)'),
          workspace_id: z.string().optional().describe('Workspace UUID to scope policy overrides (set_policy only)'),
          command_center_id: z.string().optional().describe('Deprecated alias for workspace_id (set_policy only)'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'configure_org',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'check organization setup',
          });
          if (authResponse) return authResponse;

          switch (args.action) {
            case 'status': {
              const response = await callOrgxApiJson(
                this.env,
                '/api/setup/status',
                undefined,
                { userId: resolvedUserId }
              );
              const status = (await response.json()) as {
                onboarding_complete: boolean;
                progress_pct: number;
                steps: Array<{ id: string; title: string; completed: boolean; required: boolean }>;
                coverage: {
                  agents: { configured: number; total: number };
                  policies: { configured: number; total: number };
                  integrations: { connected: number; available: number };
                };
                next_step: { id: string; title: string; description: string } | null;
                achievements: Array<{ id: string; name: string; earned_at: string }>;
              };

              const filled = Math.round(status.progress_pct / 10);
              const progressBar = '━'.repeat(filled) + '░'.repeat(10 - filled);
              const stepsDisplay = status.steps
                .map((s) => `${s.completed ? '☑️' : '◻️'} ${s.title}${s.required ? ' *' : ''}`)
                .join('\n');
              const { agents, policies, integrations } = status.coverage;
              const coverageDisplay = [
                `👥 Agents: ${agents.configured}/${agents.total}`,
                `📋 Policies: ${policies.configured}/${policies.total}`,
                `🔗 Integrations: ${integrations.connected}/${integrations.available}`,
              ].join('\n');

              let text = `🏗️ Org Setup: ${status.progress_pct}% complete\n${progressBar}\n\n`;
              text += `**Steps:**\n${stepsDisplay}\n\n`;
              text += `**Coverage:**\n${coverageDisplay}`;
              if (status.next_step) {
                text += `\n\n**Recommended Next:**\n${status.next_step.title}\n${status.next_step.description}`;
              }
              if (status.achievements.length > 0) {
                text += `\n\n**Achievements:** ${status.achievements.map((a) => a.name).join(', ')}`;
              }
              return { content: [{ type: 'text', text }] };
            }

            case 'configure_agent': {
              const authResponse = buildAuthRequiredResponse({
                toolId: 'configure_org',
                securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
                userId: resolvedUserId,
                serverUrl: this.env.MCP_SERVER_URL,
                featureDescription: 'configure agents',
              });
              if (authResponse) return authResponse;

              const response = await callOrgxApiJson(
                this.env,
                '/api/setup/agents',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    agent_type: args.agent_type,
                    trust_level: args.trust_level ?? 'balanced',
                    focus_areas: args.focus_areas ?? [],
                    approval_required: args.approval_required ?? [],
                    skip_approval: args.skip_approval ?? [],
                  }),
                },
                { userId: resolvedUserId }
              );
              const result = (await response.json()) as {
                agent_type: string;
                configured: boolean;
                coverage_pct: number;
                agent_name?: string;
              };

              const agentNames: Record<string, string> = {
                product: 'Pace', engineering: 'Eli', marketing: 'Mark',
                sales: 'Sage', operations: 'Orion', design: 'Dana', orchestrator: 'Xandy',
              };
              const displayName = result.agent_name ?? agentNames[args.agent_type ?? ''] ?? args.agent_type;

              return {
                content: [{
                  type: 'text',
                  text: `✓ Configured ${displayName} (${args.agent_type}) agent\n\nAgent coverage now: ${result.coverage_pct}%`,
                }],
              };
            }

            case 'set_policy': {
              const authResponse = buildAuthRequiredResponse({
                toolId: 'configure_org',
                securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
                userId: resolvedUserId,
                serverUrl: this.env.MCP_SERVER_URL,
                featureDescription: 'set organization policies',
              });
              if (authResponse) return authResponse;

              const workspaceResolution = resolveConfigureOrgWorkspaceId(
                args,
                this.sessionContext.workspaceId
              );
              if (workspaceResolution.error) {
                return this.toolError(workspaceResolution.error);
              }

              const response = await callOrgxApiJson(
                this.env,
                '/api/setup/policies',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    policy_type: args.policy_type,
                    config: args.config,
                    ...(workspaceResolution.workspaceId
                      ? { workspace_id: workspaceResolution.workspaceId }
                      : {}),
                  }),
                },
                { userId: resolvedUserId }
              );
              const result = (await response.json()) as {
                policy_type?: string;
                config?: Record<string, unknown>;
                workspace_id?: string | null;
              };
              return {
                content: [
                  {
                    type: 'text',
                    text: describeAppliedPolicy(
                      result.policy_type ?? args.policy_type,
                      result.config ?? args.config,
                      result.workspace_id ?? workspaceResolution.workspaceId
                    ),
                  },
                ],
              };
            }

            default:
              return this.toolError(`Unknown configure_org action: ${args.action}`);
          }
        })
    );

    /**
     * stats - Consolidated personal and session stats
     */
    if (shouldRegister('stats'))
    this.server.registerTool(
      'stats',
      {
        title: 'Stats',
        description:
          'Get productivity stats, achievements, and streaks. scope=personal for your stats, scope=session for current session diagnostics. Read-only.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          scope: z
            .enum(['personal', 'session'])
            .default('personal')
            .describe(
              'Whether to return personal stats or current-session diagnostics.'
            ),
          timeframe: z
            .enum(['today', 'week', 'month', 'all_time'])
            .optional()
            .describe('Time window for the requested statistics.'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'stats',
            securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'view your stats',
          });
          if (authResponse) return authResponse;

          const scope = args.scope ?? 'personal';

          if (scope === 'session') {
            return {
              content: [{
                type: 'text',
                text:
                  `📊 **Session Stats**\n\n` +
                  `🔄 Tools available: 15+\n` +
                  `⏱️ Session active\n` +
                  `🎯 Entities: command_center, initiative, milestone, workstream, task, objective, playbook, decision\n\n` +
                  `*Tip: Use \`list_entities\` with pagination to browse your data, or \`configure_org action=status\` to see what to configure next.*`,
              }],
            };
          }

          // scope === 'personal'
          const params = new URLSearchParams();
          if (args.timeframe) params.set('timeframe', args.timeframe);

          const response = await callOrgxApiJson(
            this.env,
            `/api/stats/me?${params.toString()}`,
            undefined,
            { userId: resolvedUserId }
          );
          const statsData = (await response.json()) as {
            timeframe: string;
            productivity: {
              initiatives_launched: number;
              tasks_completed: number;
              decisions_made: number;
              avg_time_to_launch_days: number;
            };
            org_coverage: {
              agents_configured: number;
              agents_total: number;
              policies_set: number;
              policies_total: number;
            };
            streaks: { current: number; longest: number; last_active: string };
            achievements: Array<{ id: string; name: string; description: string; earned_at: string }>;
          };

          const { productivity: p, streaks: s, org_coverage: c, achievements } = statsData;

          let text = `📊 **Your Stats** (${statsData.timeframe})\n\n`;
          text += `**Productivity:**\n`;
          text += `• Initiatives launched: ${p.initiatives_launched}\n`;
          text += `• Tasks completed: ${p.tasks_completed}\n`;
          text += `• Decisions made: ${p.decisions_made}\n`;
          text += `• Avg time to launch: ${p.avg_time_to_launch_days.toFixed(1)} days\n\n`;
          text += `**Org Coverage:**\n`;
          text += `• Agents: ${c.agents_configured}/${c.agents_total}\n`;
          text += `• Policies: ${c.policies_set}/${c.policies_total}\n\n`;
          text += `**Streaks:**\n`;
          text += `🔥 Current: ${s.current} days | Best: ${s.longest} days\n\n`;

          if (achievements.length > 0) {
            text += `**Achievements (${achievements.length}):**\n`;
            text += achievements.slice(0, 5).map((a) => `🏆 ${a.name}`).join('\n');
            if (achievements.length > 5) text += `\n... and ${achievements.length - 5} more`;
          }

          return { content: [{ type: 'text', text }] };
        })
    );

    /**
     * workspace - Consolidated workspace list, get, set, and create
     */
    if (shouldRegister('workspace'))
    this.server.registerTool(
      'workspace',
      {
        title: 'Workspace',
        description:
          'Create, list, get, or set the active workspace. action=create creates a workspace and makes it active by default; action=list shows all; action=get returns current; action=set switches active.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
        inputSchema: {
          action: z
            .enum(['list', 'get', 'set', 'create'])
            .describe(
              'list=show all, get=current, set=switch active, create=new workspace'
            ),
          workspace_id: z.string().optional().describe('Workspace UUID to switch to (action=set only)'),
          name: z.string().optional().describe('Workspace name (action=create)'),
          title: z.string().optional().describe('Alias for name (action=create)'),
          description: z
            .string()
            .optional()
            .describe('Workspace narrative/description (action=create)'),
          tagline: z.string().optional().describe('Short workspace tagline (action=create)'),
          narrative: z
            .string()
            .optional()
            .describe('Workspace identity narrative (action=create)'),
          key_metrics: z
            .array(z.string())
            .optional()
            .describe('Workspace identity metrics (action=create)'),
          roadmap_url: z.string().optional().describe('Roadmap URL (action=create)'),
          source_links: z
            .array(z.string())
            .optional()
            .describe('Source links for workspace identity (action=create)'),
          set_active: z
            .boolean()
            .optional()
            .describe('Whether to make the new workspace active. Defaults true.'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.authRequired },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;

          const authResponse = buildAuthRequiredResponse({
            toolId: 'workspace',
            securitySchemes: SECURITY_SCHEMES.authRequired,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'manage workspaces',
          });
          if (authResponse) return authResponse;

          switch (args.action) {
            case 'list': {
              const response = await callOrgxApiJson(
                this.env,
                '/api/entities?type=workspace&limit=50',
                undefined,
                { userId: resolvedUserId }
              );
              const result = (await response.json()) as {
                data: Array<{
                  id: string;
                  name: string;
                  slug: string | null;
                  description: string | null;
                  is_default: boolean;
                  project_id: string | null;
                  created_at: string;
                }>;
              };

              if (!result.data?.length) {
                return {
                  content: [{
                    type: 'text',
                    text: `📭 **No workspaces found**\n\nYou don't have any workspaces yet. Use \`workspace action=create name="Your Workspace"\` to organize initiatives and agents.`,
                  }],
                };
              }

              const workspaceLines = result.data
                .map((ws) => {
                  const defaultBadge = ws.is_default ? ' ⭐' : '';
                  return `• **${ws.name}**${defaultBadge} (\`${ws.id}\`)\n   ${ws.description || 'No description'}`;
                })
                .join('\n\n');

              const currentWorkspace = this.sessionContext?.workspaceId;
              const currentLine = currentWorkspace
                ? `\n\n🎯 **Current workspace:** \`${currentWorkspace}\``
                : '\n\n💡 *Use `workspace action=set` to select a workspace for subsequent operations.*';

              return {
                content: [{
                  type: 'text',
                  text: `🏢 **Your Workspaces** (${result.data.length})\n\n${workspaceLines}${currentLine}`,
                }],
                structuredContent: {
                  _action: 'list',
                  workspaces: result.data,
                  current_workspace_id: currentWorkspace ?? null,
                },
              };
            }

            case 'get': {
              const workspaceId = this.sessionContext?.workspaceId;
              const workspaceName = this.sessionContext?.workspaceName;

              if (!workspaceId) {
                return {
                  content: [{
                    type: 'text',
                    text:
                      `ℹ️ **No workspace set**\n\n` +
                      `Operations will use your default workspace. Use \`workspace action=list\` to see options, ` +
                      `then \`workspace action=set\` to select one, or \`workspace action=create name="Your Workspace"\` to create one.`,
                  }],
                  structuredContent: { _action: 'get', workspace_id: null, workspace_name: null },
                };
              }

              let wsStats = { initiatives: 0, agents: 0, pending_decisions: 0 };
              try {
                const response = await callOrgxApiJson(
                  this.env,
                  `/api/v1/workspaces/${workspaceId}/dashboard/pulse`,
                  undefined,
                  { userId: resolvedUserId }
                );
                const data = (await response.json()) as Record<string, number>;
                wsStats = {
                  initiatives: data.initiatives_count ?? 0,
                  agents: data.active_agents ?? 0,
                  pending_decisions: data.pending_decisions ?? 0,
                };
              } catch {
                // Stats unavailable
              }

              const liveUrl = buildLiveUrl(undefined, undefined, { workspace: workspaceId });

              return {
                content: [{
                  type: 'text',
                  text:
                    `🎯 **Current Workspace: ${workspaceName}**\n\n` +
                    `ID: \`${workspaceId}\`\n\n` +
                    `📊 **Stats:**\n` +
                    `• Initiatives: ${wsStats.initiatives}\n` +
                    `• Active agents: ${wsStats.agents}\n` +
                    `• Pending decisions: ${wsStats.pending_decisions}\n\n` +
                    `📺 Live view: ${liveUrl}`,
                }],
                structuredContent: {
                  _action: 'get',
                  workspace_id: workspaceId,
                  workspace_name: workspaceName,
                  stats: wsStats,
                  live_url: liveUrl,
                },
              };
            }

            case 'set': {
              if (!args?.workspace_id) {
                return { content: [{ type: 'text', text: '❌ workspace_id is required' }] };
              }

              const response = await callOrgxApiJson(
                this.env,
                '/api/entities?type=workspace&limit=50',
                undefined,
                { userId: resolvedUserId }
              );
              if (!response.ok) {
                return {
                  content: [{
                    type: 'text',
                    text: `❌ **Failed to fetch workspaces**\n\nCouldn't retrieve workspace list. Please try again.`,
                  }],
                };
              }

              const result = (await response.json()) as {
                data: Array<{ id: string; name: string; description: string | null }>;
              };
              const workspace = result.data?.find(
                (ws) => ws.id === args.workspace_id || ws.id.startsWith(args.workspace_id!)
              );

              if (!workspace) {
                return {
                  content: [{
                    type: 'text',
                    text: `❌ **Workspace not found**\n\nCouldn't find workspace \`${args.workspace_id}\`. Use \`workspace action=list\` to see available options.`,
                  }],
                };
              }

              this.sessionContext = {
                ...this.sessionContext,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
              };
              await this.saveSessionContext();

              const liveUrl = buildLiveUrl(undefined, undefined, { workspace: workspace.id });

              return {
                content: [{
                  type: 'text',
                  text:
                    `✅ **Workspace set: ${workspace.name}**\n\n` +
                    `All subsequent operations will be scoped to this workspace.\n\n` +
                    `📺 Live view: ${liveUrl}`,
                }],
                structuredContent: {
                  _action: 'set',
                  workspace_id: workspace.id,
                  workspace_name: workspace.name,
                  live_url: liveUrl,
                },
              };
            }

            case 'create': {
              const createBody = buildWorkspaceCreateBody(
                args as Record<string, unknown>
              );
              if (!createBody.ok) {
                return this.toolError(createBody.error, {
                  code: 'invalid_workspace_payload',
                  status: 400,
                });
              }

              const response = await callOrgxApiJson(
                this.env,
                '/api/workspaces',
                {
                  method: 'POST',
                  body: JSON.stringify(createBody.body),
                },
                { userId: resolvedUserId }
              );
              const result = (await response.json()) as {
                workspace?: {
                  id?: string;
                  name?: string;
                  slug?: string | null;
                  description?: string | null;
                  is_default?: boolean;
                  created_at?: string;
                };
              };

              const workspace = result.workspace;
              if (
                !workspace ||
                typeof workspace.id !== 'string' ||
                typeof workspace.name !== 'string'
              ) {
                return this.toolError(
                  'Workspace was created but the response did not include id/name',
                  { code: 'invalid_workspace_response', status: 502 }
                );
              }

              if (createBody.setActive) {
                this.sessionContext = {
                  ...this.sessionContext,
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                };
                await this.saveSessionContext();
              }

              const liveUrl = buildLiveUrl(undefined, undefined, {
                workspace: workspace.id,
              });
              const slugLine = workspace.slug
                ? `Slug: \`${workspace.slug}\`\n`
                : '';
              const defaultLine =
                typeof workspace.is_default === 'boolean'
                  ? `Default workspace: ${workspace.is_default ? 'yes' : 'no'}\n`
                  : '';
              const activeLine = createBody.setActive
                ? 'This is now the active workspace for subsequent MCP calls.\n\n'
                : 'This workspace was created but not set active.\n\n';

              return {
                content: [
                  {
                    type: 'text',
                    text:
                      `✅ **Workspace created: ${workspace.name}**\n\n` +
                      `ID: \`${workspace.id}\`\n` +
                      slugLine +
                      defaultLine +
                      activeLine +
                      `📺 Live view: ${liveUrl}`,
                  },
                ],
                structuredContent: {
                  _action: 'create',
                  workspace_id: workspace.id,
                  workspace_name: workspace.name,
                  slug: workspace.slug ?? null,
                  is_default: workspace.is_default ?? null,
                  created_at: workspace.created_at ?? null,
                  set_active: createBody.setActive,
                  live_url: liveUrl,
                },
              };
            }

            default:
              return this.toolError(`Unknown workspace action: ${args.action}`);
          }
        })
    );

    // =========================================================================
    // INTELLIGENCE FLYWHEEL TOOLS
    // @see Intelligence Flywheel Architecture — MCP Tools inventory
    // =========================================================================
    this.registerFlywheelTools(allowedTools);
  }

  /**
   * Register Intelligence Flywheel tools.
   *
   * 7 new tools that serve two audiences:
   * - Humans: ROI proof, trust visibility, morning briefs
   * - Agents: self-serve trust context, baselines, learnings
   *
   * @see Intelligence Flywheel Architecture — MCP Tools inventory
   */
  private registerFlywheelTools(allowedTools: Set<string> | null) {
    const shouldRegister = (toolId: string) =>
      !allowedTools || allowedTools.has(toolId);

    // --- get_outcome_attribution ---
    if (shouldRegister('get_outcome_attribution'))
    this.server.registerTool(
      'get_outcome_attribution',
      {
        title: 'Get Outcome Attribution',
        description:
          compatibilityAliasDescription(
            'outcomeAttribution',
            'ROI summary from the economic ledger. Returns cost/value/ROI by agent, capability, and time period.'
          ),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          workspace_id: z.string().describe('Workspace ID'),
          period: z
            .enum(['7d', '30d', '90d'])
            .default('30d')
            .describe('Time period for ROI calculation.'),
          agent_type: z.string().optional().describe('Optional agent type filter.'),
          capability_key: z
            .string()
            .optional()
            .describe('Optional capability key filter.'),
        },
        _meta: { 'openai/readOnlyHint': true },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');

          const response = await callOrgxApiJson(
            this.env,
            `/api/flywheel/attribution?workspace_id=${wsId}&period=${args.period ?? '30d'}${args.agent_type ? `&agent_type=${args.agent_type}` : ''}${args.capability_key ? `&capability_key=${args.capability_key}` : ''}`,
            undefined,
            { userId: this.resolveUserId() }
          );
          const result = await response.json() as Record<string, unknown>;

          return {
            content: [{ type: 'text' as const, text: formatForLLM('get_outcome_attribution', result) }],
            structuredContent: result,
          };
        })
    );

    // --- configure_outcome_type ---
    if (shouldRegister('configure_outcome_type'))
    this.server.registerTool(
      'configure_outcome_type',
      {
        title: 'Configure Outcome Type',
        description:
          'Create or approve a workspace outcome type before recording custom baseline, audit, or quality-gate outcomes.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          workspace_id: z
            .string()
            .optional()
            .describe('Workspace ID. Defaults to active MCP workspace when omitted.'),
          workspaceId: z
            .string()
            .optional()
            .describe('CamelCase alias for workspace_id.'),
          key: z
            .string()
            .describe('Outcome type key, normalized server-side to snake_case.'),
          display_name: z
            .string()
            .optional()
            .describe('Human-facing outcome type label.'),
          displayName: z
            .string()
            .optional()
            .describe('CamelCase alias for display_name.'),
          unit: z
            .enum(['usd', 'hours', 'count', 'percent'])
            .default('count')
            .describe('Measurement unit for this outcome type.'),
          value_semantics: z
            .enum(['revenue', 'time_saved', 'risk_reduced', 'quality_improved'])
            .default('quality_improved')
            .describe('How the value should be interpreted by ROI/proof loops.'),
          valueSemantics: z
            .enum(['revenue', 'time_saved', 'risk_reduced', 'quality_improved'])
            .optional()
            .describe('CamelCase alias for value_semantics.'),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId =
            ((args.workspace_id as string | undefined) ??
              (args.workspaceId as string | undefined) ??
              this.sessionContext?.workspaceId) ?? null;
          if (!wsId) return this.toolError('workspace_id required');

          const key = typeof args.key === 'string' ? args.key.trim() : '';
          if (!key) {
            return this.toolError('key required', {
              code: 'invalid_input',
              status: 400,
              details: {
                suggested_next_calls: [
                  {
                    tool: 'orgx_describe_tool',
                    args: { tool_id: 'configure_outcome_type' },
                  },
                ],
              },
            });
          }

          const body = {
            workspace_id: wsId,
            key,
            display_name:
              (args.display_name as string | undefined) ??
              (args.displayName as string | undefined),
            unit: (args.unit as string | undefined) ?? 'count',
            value_semantics:
              (args.value_semantics as string | undefined) ??
              (args.valueSemantics as string | undefined) ??
              'quality_improved',
          };

          try {
            const response = await callOrgxApiJson(
              this.env,
              '/api/flywheel/outcome-types',
              {
                method: 'POST',
                body: JSON.stringify(body),
              },
              { userId: this.resolveUserId() }
            );
            const result = (await response.json()) as Record<string, unknown>;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatForLLM('configure_outcome_type', result),
                },
              ],
              structuredContent: result,
            };
          } catch (error) {
            return this.toolError(
              error instanceof Error ? error.message : String(error),
              {
                code: 'configure_outcome_type_failed',
                status:
                  error instanceof OrgXApiError ? error.statusCode : undefined,
                details: buildFailureDetails({
                  toolId: 'configure_outcome_type',
                  error,
                  args,
                }),
              }
            );
          }
        })
    );

    // --- record_outcome ---
    if (shouldRegister('record_outcome'))
    this.server.registerTool(
      'record_outcome',
      {
        title: 'Record Outcome',
        description:
          'Record a business outcome. Triggers attribution inference to connect outcomes to receipts. If the outcome type is unknown, call configure_outcome_type first.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          workspace_id: z
            .string()
            .optional()
            .describe('Workspace ID. Defaults to active MCP workspace when omitted.'),
          workspaceId: z
            .string()
            .optional()
            .describe('CamelCase alias for workspace_id.'),
          outcome_type_key: z
            .string()
            .optional()
            .describe('Outcome type key, such as deal_closed or meeting_booked.'),
          outcomeTypeKey: z
            .string()
            .optional()
            .describe('CamelCase alias for outcome_type_key.'),
          outcome_value: z
            .number()
            .optional()
            .describe('Optional numeric value in the outcome’s native unit.'),
          outcomeValue: z
            .number()
            .optional()
            .describe('CamelCase alias for outcome_value.'),
          source: z
            .enum(['manual', 'agent_self_report', 'crm_webhook', 'linear_sync'])
            .default('manual')
            .describe('System that observed or reported the outcome.'),
          source_id: z
            .string()
            .optional()
            .describe('Optional external source ID for deduplication.'),
          sourceId: z
            .string()
            .optional()
            .describe('CamelCase alias for source_id.'),
          occurred_at: z
            .string()
            .optional()
            .describe('Optional ISO timestamp for when the outcome occurred.'),
          occurredAt: z
            .string()
            .optional()
            .describe('CamelCase alias for occurred_at.'),
          metadata: z
            .record(z.unknown())
            .optional()
            .describe('Optional structured context attached to the outcome record.'),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const normalized = normalizeRecordOutcomeArgs(
            args,
            this.sessionContext?.workspaceId ?? null
          );
          const wsId = normalized.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');
          if (
            typeof normalized.body.outcome_type_key !== 'string' ||
            normalized.body.outcome_type_key.trim().length === 0
          ) {
            return this.toolError('outcome_type_key required', {
              code: 'invalid_input',
              status: 400,
              details: {
                suggested_next_calls: [
                  { tool: 'orgx_describe_tool', args: { tool_id: 'record_outcome' } },
                ],
              },
            });
          }

          try {
            const response = await callOrgxApiJson(
              this.env,
              '/api/flywheel/outcomes',
              {
                method: 'POST',
                body: JSON.stringify({
                  ...normalized.body,
                  workspace_id: wsId,
                }),
              },
              { userId: this.resolveUserId() }
            );
            const result = (await response.json()) as Record<string, unknown>;
            return {
              content: [{ type: 'text' as const, text: formatForLLM('record_outcome', result) }],
              structuredContent: result,
            };
          } catch (error) {
            return this.toolError(
              error instanceof Error ? error.message : String(error),
              {
                code: 'record_outcome_failed',
                status:
                  error instanceof OrgXApiError ? error.statusCode : undefined,
                details: buildFailureDetails({
                  toolId: 'record_outcome',
                  error,
                  args,
                }),
              }
            );
          }
        })
    );

    // --- resume_agent_run ---
    // Complementary to the TTL cron that auto-closes stale reporting runs
    // (see orgx/app/api/internal/cron/close-stale-reporting-runs). Lets a
    // user (or agent) bring a paused/auto-closed run back to running with
    // one call. Safe to call on any paused/blocked/queued run, not just
    // auto-closed ones.
    if (shouldRegister('resume_agent_run'))
    this.server.registerTool(
      'resume_agent_run',
      {
        title: 'Resume Agent Run',
        description:
          'Resume a paused or auto-closed agent run. Flips status back to running, clears TTL auto-close markers, and appends a resume_history entry. USE WHEN: the user wants to continue a reporting session that was auto-closed by the stale-TTL cron, or reactivate any paused run. DO NOT USE: to restart a completed/failed/cancelled run — those are terminal.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          run_id: z.string().min(1).describe('Agent run UUID to resume'),
          note: z
            .string()
            .optional()
            .describe('Optional note appended to resume_history for audit'),
        },
        _meta: {
          'openai/toolInvocation/invoking': 'Resuming run...',
          'openai/toolInvocation/invoked': 'Run resumed',
          securitySchemes: SECURITY_SCHEMES.authRequired,
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId =
            this.props?.userId ?? this.sessionAuth?.userId;
          const authResponse = buildAuthRequiredResponse({
            toolId: 'resume_agent_run',
            securitySchemes: SECURITY_SCHEMES.authRequired,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'resume an agent run',
          });
          if (authResponse) return authResponse;

          const body: Record<string, unknown> = {};
          if (
            typeof args.note === 'string' &&
            args.note.trim().length > 0
          ) {
            body.note = args.note.trim();
          }

          const response = await callOrgxApiJson(
            this.env,
            `/api/agent-runs/${encodeURIComponent(args.run_id)}/resume`,
            {
              method: 'POST',
              body: JSON.stringify(body),
            },
            { userId: resolvedUserId }
          );
          const result = (await response.json()) as Record<string, unknown>;
          const noop = result.noop === true;
          const wasAutoClosed = result.was_auto_closed === true;
          const priorStatus = result.prior_status;
          const summary = noop
            ? `Run ${args.run_id} is already running.`
            : wasAutoClosed
            ? `Resumed run ${args.run_id} (was auto-closed from '${priorStatus}').`
            : `Resumed run ${args.run_id} (was '${priorStatus}').`;

          return {
            content: [{ type: 'text' as const, text: summary }],
            structuredContent: result,
          };
        })
    );

    // --- get_my_trust_context ---
    if (shouldRegister('get_my_trust_context'))
    this.server.registerTool(
      'get_my_trust_context',
      {
        title: 'Get My Trust Context',
        description:
          'Agent-facing: trust level per capability, promotion requirements, receipt evidence. Returns full trust context for self-awareness.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          workspace_id: z.string().describe('Workspace ID.'),
          agent_type: z.string().describe('Agent type to fetch trust data for.'),
        },
        _meta: { 'openai/readOnlyHint': true },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');

          const response = await callOrgxApiJson(
            this.env,
            `/api/flywheel/trust?workspace_id=${wsId}&agent_type=${args.agent_type}`,
            undefined,
            { userId: this.resolveUserId() }
          );
          const result = await response.json() as Record<string, unknown>;
          return {
            content: [{ type: 'text' as const, text: formatForLLM('get_my_trust_context', result) }],
            structuredContent: result,
          };
        })
    );

    // --- orgx_free_audit ---
    if (shouldRegister('orgx_free_audit')) {
      this.server.registerTool(
        'orgx_free_audit',
        {
          title: 'OrgX Free Audit',
          description:
            'Run a free autonomy benchmark from trust, proof, ROI, and workspace signals. Returns Proof Score, Context Debt, Autonomy Maturity, ROI Visibility, and next recommendations without starting an autonomous session or consuming agent credits.',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          inputSchema: {
            workspace_id: z.string().describe('Workspace ID to audit.'),
            agent_type: z
              .string()
              .default('orchestrator')
              .describe('Agent type to benchmark trust against.'),
            period: z
              .enum(['7d', '30d', '90d'])
              .default('30d')
              .describe('ROI attribution period used for ROI Visibility.'),
            include_raw_signals: z
              .boolean()
              .default(false)
              .describe(
                'Include raw upstream signal payloads for debugging and verification.'
              ),
          },
          _meta: { 'openai/readOnlyHint': true },
        },
        async (args) =>
          this.withOrgx(async () => {
            const wsId =
              (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
            if (!wsId) return this.toolError('workspace_id required');
            const resolvedUserId = this.resolveUserId();
            const agentType =
              typeof args.agent_type === 'string' && args.agent_type.trim()
                ? args.agent_type.trim()
                : 'orchestrator';
            const period = ((args.period as OrgxFreeAuditPeriod | undefined) ??
              '30d') as OrgxFreeAuditPeriod;
            const encodedWorkspaceId = encodeURIComponent(wsId);
            const encodedAgentType = encodeURIComponent(agentType);

            const [trustContext, outcomeAttribution, workspacePulse] =
              await Promise.all([
                this.fetchOrgxJsonOrNull<Record<string, unknown>>(
                  `/api/flywheel/trust?workspace_id=${encodedWorkspaceId}&agent_type=${encodedAgentType}`,
                  resolvedUserId
                ),
                this.fetchOrgxJsonOrNull<Record<string, unknown>>(
                  `/api/flywheel/attribution?workspace_id=${encodedWorkspaceId}&period=${period}`,
                  resolvedUserId
                ),
                this.fetchOrgxJsonOrNull<Record<string, unknown>>(
                  `/api/v1/workspaces/${encodedWorkspaceId}/dashboard/pulse`,
                  resolvedUserId
                ),
              ]);

            const result = buildOrgxFreeAudit({
              workspaceId: wsId,
              agentType,
              period,
              generatedAt: new Date().toISOString(),
              trustContext,
              outcomeAttribution,
              workspacePulse,
              includeRawSignals: args.include_raw_signals === true,
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatOrgxFreeAuditSummary(result),
                },
              ],
              structuredContent: result,
            };
          })
      );
    }

    // --- start_autonomous_session ---
    if (shouldRegister('start_autonomous_session')) {
    const startAutonomousSessionDefinition = FLYWHEEL_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'start_autonomous_session'
    );
    const startAutonomousSessionSecuritySchemes =
      startAutonomousSessionDefinition?.securitySchemes ??
      SECURITY_SCHEMES.authRequired;
    this.server.registerTool(
      'start_autonomous_session',
      {
        title: 'Start Autonomous Session',
        description:
          'Start an autonomous execution session with budget guardrails. Creates a session that produces receipts while executing eligible work.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        inputSchema: autonomousSessionInputShape,
        _meta: {
          'mcp/securitySchemes': startAutonomousSessionSecuritySchemes,
        },
      },
      async (args) => {
        const resolvedUserId = this.resolveUserId();
        const authResponse = buildAuthRequiredResponse({
          toolId: 'start_autonomous_session',
          securitySchemes: startAutonomousSessionSecuritySchemes,
          userId: resolvedUserId ?? undefined,
          serverUrl: this.env.MCP_SERVER_URL,
          featureDescription: 'start autonomous sessions',
        });
        if (authResponse) return authResponse;

        const planResponse = await checkToolPlanAccess({
          env: this.env,
          userId: resolvedUserId ?? null,
          feature: 'start_autonomous_session',
        });
        if (planResponse) return planResponse;

        return this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');
          const payloadResult = normalizeAutonomousSessionArgs({
            ...args,
            workspace_id: wsId,
          });
          if (!payloadResult.ok) {
            return this.toolError(payloadResult.error.message, {
              code: payloadResult.error.code,
              status: payloadResult.error.status,
              details: { issues: payloadResult.error.details },
            });
          }

          const response = await callOrgxApiJson(
            this.env,
            '/api/flywheel/sessions',
            {
              method: 'POST',
              body: JSON.stringify(payloadResult.payload),
            },
            { userId: resolvedUserId ?? undefined }
          );
          const result = await response.json() as Record<string, unknown>;
          return {
            content: [{ type: 'text' as const, text: formatForLLM('start_autonomous_session', result) }],
            structuredContent: result,
          };
        })
      }
    );
    }

    // --- review_artifact ---
    // Action widget for approving/rejecting production artifacts.
    // Fetches the next in-review artifact for the caller's workspace
    // (optionally filtered by entity_id) and attaches the artifact-review
    // widget with the artifact as structuredContent.artifact.
    if (shouldRegister('review_artifact'))
      registerAppTool(
        this.server,
        'review_artifact',
        {
          title: 'Review Artifact',
          description:
            'Surface the next artifact awaiting review. Renders the artifact-review widget with a preview, version filmstrip, and hold-to-approve / request-changes actions. USE WHEN the user asks to review work, approve a deliverable, or handle pending artifact reviews. DO NOT USE for listing all artifacts — use list_entities type=artifact instead.',
          inputSchema: this.withClientContext({
            artifact_id: z
              .string()
              .optional()
              .describe('Specific artifact ID to review. Defaults to the next in_review artifact.'),
            entity_id: z
              .string()
              .optional()
              .describe('Scope to artifacts attached to this entity (initiative, workstream, milestone, or task).'),
            workspace_id: z
              .string()
              .optional()
              .describe('Workspace UUID. Defaults to the session workspace.'),
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
          },
          _meta: {
            'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.artifactReview,
            'openai/toolInvocation/invoking': 'Loading artifact for review...',
            'openai/toolInvocation/invoked': 'Artifact ready to review',
            'openai/visibility': 'public',
            'mcp/securitySchemes': SECURITY_SCHEMES.entityWriteRequiresAuth,
            ui: { resourceUri: WIDGET_URIS.artifactReview },
          },
        },
        async (args: Record<string, unknown>) =>
          this.withOrgx(async () => {
            const authResponse = buildAuthRequiredResponse({
              toolId: 'review_artifact',
              securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
              userId: this.resolveUserId() ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL ?? undefined,
              featureDescription: 'review artifacts',
            });
            if (authResponse) return authResponse;

            const explicitArtifactId =
              typeof args.artifact_id === 'string' && args.artifact_id.trim()
                ? args.artifact_id.trim()
                : null;

            const wsId =
              (args.workspace_id as string | undefined) ??
              this.sessionContext?.workspaceId ??
              null;

            const params = new URLSearchParams();
            params.set('type', 'artifact');
            params.set('limit', '1');
            if (explicitArtifactId) {
              params.set('id', explicitArtifactId);
            } else {
              params.set('status', 'in_review');
            }
            if (typeof args.entity_id === 'string' && args.entity_id.trim()) {
              params.set('entity_id', args.entity_id.trim());
            }
            if (wsId) params.set('workspace_id', wsId);

            const response = await callOrgxApiJson(
              this.env,
              `/api/entities?${params.toString()}`,
              undefined,
              { userId: this.resolveUserId() }
            );
            const result = (await response.json()) as {
              data?: Array<Record<string, unknown>>;
            };
            const artifact = Array.isArray(result.data) ? result.data[0] : null;

            if (!artifact) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No artifacts currently awaiting review.',
                  },
                ],
                structuredContent: { artifact: null },
              };
            }

            const name =
              typeof artifact.name === 'string'
                ? artifact.name
                : typeof artifact.title === 'string'
                ? (artifact.title as string)
                : 'artifact';

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Artifact ready for review: **${name}** (status: ${artifact.status ?? 'in_review'}). Approve or request changes inline.`,
                },
              ],
              structuredContent: { artifact },
            };
          })
      );

    // --- get_morning_brief ---
    if (shouldRegister('get_morning_brief'))
      registerAppTool(
        this.server,
        'get_morning_brief',
        {
          title: 'Get Morning Brief',
          description:
            `Curated receipts, exceptions, ROI delta, and value signals from the most recent autonomous session. The brief IS curated receipts, not a separate data structure. ${preferredToolCallout(
              'outcomeAttribution'
            )}`,
          inputSchema: this.withClientContext({
            workspace_id: z
              .string()
              .describe('Workspace UUID to load the morning brief for'),
            session_id: z
              .string()
              .optional()
              .describe('Specific autonomous session ID; defaults to the most recent session'),
          }),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          _meta: {
            'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.morningBrief,
            'openai/toolInvocation/invoking': 'Loading morning brief...',
            'openai/toolInvocation/invoked': 'Morning brief ready',
            'openai/readOnlyHint': true,
            'openai/visibility': 'public',
            'mcp/securitySchemes': [
              { type: 'oauth2', scopes: ['initiatives:read'] },
            ],
            ui: { resourceUri: WIDGET_URIS.morningBrief },
          },
        },
        async (args: Record<string, unknown>) =>
          this.withOrgx(async () => {
            const authResponse = buildAuthRequiredResponse({
              toolId: 'get_morning_brief',
              securitySchemes: [
                { type: 'oauth2', scopes: ['initiatives:read'] },
              ],
              userId: this.resolveUserId() ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL ?? undefined,
              featureDescription: 'view your OrgX morning brief',
            });
            if (authResponse) return authResponse;

            const wsId =
              (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
            if (!wsId) return this.toolError('workspace_id required');
            const resolvedUserId = this.resolveUserId();

            const response = await callOrgxApiJson(
              this.env,
              `/api/flywheel/briefs?workspace_id=${wsId}${args.session_id ? `&session_id=${args.session_id}` : ''}`,
              undefined,
              { userId: resolvedUserId ?? undefined }
            );
            const result = (await response.json()) as Record<string, unknown>;
            const [outcomeAttribution, workspacePulse] = await Promise.all([
              this.fetchOrgxJsonOrNull<Record<string, unknown>>(
                `/api/flywheel/attribution?workspace_id=${wsId}&period=30d`,
                resolvedUserId
              ),
              this.fetchOrgxJsonOrNull<Record<string, unknown>>(
                `/api/v1/workspaces/${wsId}/dashboard/pulse`,
                resolvedUserId
              ),
            ]);
            const valueDashboard = buildMorningBriefValueDashboard({
              brief: result,
              outcomeAttribution,
              workspacePulse,
            });

            const sourceClient = resolveSourceClientFromContext(args._context);
            const activationEvents = await this.recordMcpActivationObservation({
              toolId: 'get_morning_brief',
              args: args as Record<string, unknown>,
              data: result,
              userId: resolvedUserId,
              sourceClient,
              workspaceId: wsId,
              initiativeId: this.sessionContext?.initiativeId ?? null,
            });
            const activationPayload = this.buildClientActivationPayload({
              sourceClient,
              events: activationEvents,
            });
            const payload = {
              ...result,
              value_dashboard: valueDashboard,
              ...(outcomeAttribution
                ? { outcome_attribution: outcomeAttribution }
                : {}),
              ...(workspacePulse
                ? {
                    workspace_pulse: {
                      stats:
                        typeof workspacePulse.stats === 'object' &&
                        workspacePulse.stats
                          ? workspacePulse.stats
                          : null,
                      generatedAt:
                        typeof workspacePulse.generatedAt === 'string'
                          ? workspacePulse.generatedAt
                          : null,
                    },
                  }
                : {}),
              ...(activationPayload.experience
                ? { client_activation: activationPayload.experience }
                : {}),
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    formatMorningBriefSummary(payload) + activationPayload.text,
                },
              ],
              structuredContent: payload,
            };
          })
      );

    // --- get_relevant_learnings ---
    if (shouldRegister('get_relevant_learnings'))
    this.server.registerTool(
      'get_relevant_learnings',
      {
        title: 'Get Relevant Learnings',
        description:
          'Agent-facing: organizational learnings relevant to a capability or task context. One agent\'s discovery benefits all agents.',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          workspace_id: z.string().describe('Workspace ID.'),
          capability_key: z.string().optional().describe('Optional capability key filter.'),
          keywords: z
            .array(z.string())
            .optional()
            .describe('Optional keywords for semantic matching.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe('Maximum number of learnings to return.'),
        },
        _meta: { 'openai/readOnlyHint': true },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');

          const response = await callOrgxApiJson(
            this.env,
            `/api/flywheel/learnings?workspace_id=${wsId}${args.capability_key ? `&capability_key=${args.capability_key}` : ''}&limit=${args.limit ?? 5}`,
            undefined,
            { userId: this.resolveUserId() }
          );
          const result = await response.json() as Record<string, unknown>;
          return {
            content: [{ type: 'text' as const, text: formatForLLM('get_relevant_learnings', result) }],
            structuredContent: result,
          };
        })
    );

    // --- submit_learning ---
    if (shouldRegister('submit_learning'))
    this.server.registerTool(
      'submit_learning',
      {
        title: 'Submit Learning',
        description:
          'Agent-facing: submit a discovery as an org learning. Enters org_learnings after confidence validation.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          workspace_id: z.string().describe('Workspace ID.'),
          learning_type: z
            .enum([
              'failure_pattern',
              'success_pattern',
              'cost_optimization',
              'quality_heuristic',
            ])
            .describe('Type of learning being submitted.'),
          summary: z.string().describe('Human-readable learning summary.'),
          capability_key: z
            .string()
            .optional()
            .describe('Optional capability key the learning applies to.'),
          evidence_receipt_ids: z
            .array(z.string())
            .optional()
            .describe('Optional receipt IDs that support the learning.'),
          keywords: z
            .array(z.string())
            .optional()
            .describe('Optional semantic keywords for future matching.'),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');
          const { workspace_id: _workspaceId, ...restArgs } = args;

          const response = await callOrgxApiJson(
            this.env,
            '/api/flywheel/learnings',
            {
              method: 'POST',
              body: JSON.stringify({
                ...restArgs,
                workspace_id: wsId,
              }),
            },
            { userId: this.resolveUserId() }
          );
          const result = await response.json() as Record<string, unknown>;
          return {
            content: [{ type: 'text' as const, text: formatForLLM('submit_learning', result) }],
            structuredContent: result,
          };
        })
    );

    // --- save_artifact (DEPRECATED) ---
    // DEPRECATED: The previous schema (type: 'document'|'code'|'data'|'decision'|'analysis')
    // produced 400 errors on the server, which expects entity-scoped attach payloads
    // (entity_type, entity_id, artifact_type). This tool now transparently routes to the
    // same backend as `entity_action action=attach`. Prefer `entity_action action=attach`
    // for new code.
    if (shouldRegister('save_artifact'))
    this.server.registerTool(
      'save_artifact',
      {
        title: 'Save Artifact (deprecated)',
        description:
          'DEPRECATED: Use entity_action action=attach instead. This tool still works as a thin compatibility wrapper that attaches an artifact to a task, milestone, initiative, workstream, project, or decision. USE WHEN: legacy clients still call save_artifact. NEXT: Prefer entity_action action=attach for new code — it exposes the full attachment surface (preview_markdown, status, metadata, created_by_*). DO NOT USE: for generic entity creation — use create_entity instead.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          title: z.string().describe('Artifact title (maps to `name` on the attach payload)'),
          // Legacy enum kept for backwards compatibility but no longer constrained:
          // server only cares about `artifact_type` (free string like "eng.diff_pack").
          // Accept the old legacy values OR any new free-form code — either parses to
          // a valid artifact_type string below.
          type: z
            .string()
            .optional()
            .describe(
              'Legacy artifact category (document|code|data|decision|analysis) OR a free-form artifact_type code (e.g. eng.diff_pack). If omitted, defaults to "note".'
            ),
          artifact_type: z
            .string()
            .optional()
            .describe(
              'Preferred: explicit artifact type code matching the server taxonomy (e.g. eng.diff_pack, launch.launch_brief). Overrides `type` when both are set.'
            ),
          entity_type: z
            .enum(['project', 'initiative', 'workstream', 'milestone', 'task', 'decision'])
            .optional()
            .describe('Target entity type to attach to. Falls back to inferring from taskId / initiativeId.'),
          entity_id: z
            .string()
            .optional()
            .describe('Target entity UUID. Falls back to taskId or initiativeId.'),
          content: z
            .string()
            .optional()
            .describe(
              'Optional full artifact content. Stored as preview_markdown (truncated to 25k chars).'
            ),
          artifact_url: z
            .string()
            .optional()
            .describe('Internal artifact URL (required unless external_url is provided).'),
          external_url: z
            .string()
            .optional()
            .describe('External artifact URL (required unless artifact_url is provided).'),
          sessionId: z
            .string()
            .optional()
            .describe('Agent session ID (stored on metadata.session_id).'),
          taskId: z
            .string()
            .optional()
            .describe('Legacy alias: OrgX task entity UUID to link this artifact to.'),
          initiativeId: z
            .string()
            .optional()
            .describe('Legacy alias: OrgX initiative UUID to link this artifact to.'),
          user_id: z.string().optional().describe('Optional user id override'),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.resolveUserId(
            typeof args.user_id === 'string' ? args.user_id : undefined
          );

          // Resolve entity_type / entity_id with legacy fallbacks
          const taskId =
            typeof args.taskId === 'string' && args.taskId.trim().length > 0
              ? args.taskId.trim()
              : null;
          const initiativeId =
            typeof args.initiativeId === 'string' && args.initiativeId.trim().length > 0
              ? args.initiativeId.trim()
              : null;
          const explicitEntityId =
            typeof args.entity_id === 'string' && args.entity_id.trim().length > 0
              ? args.entity_id.trim()
              : null;
          const entityType =
            args.entity_type ??
            (taskId ? 'task' : initiativeId ? 'initiative' : undefined);
          const entityId = explicitEntityId ?? taskId ?? initiativeId ?? null;

          if (!entityType || !entityId) {
            return this.toolError(
              'save_artifact requires entity_type + entity_id (or legacy taskId / initiativeId). Prefer entity_action action=attach.',
              { code: 'invalid_input', status: 400 }
            );
          }

          // Resolve artifact_type: explicit wins over legacy `type`, with a safe default.
          const artifactType =
            (typeof args.artifact_type === 'string' && args.artifact_type.trim()) ||
            (typeof args.type === 'string' && args.type.trim()) ||
            'note';

          // Require at least one URL — mirrors server-side rule.
          if (!args.artifact_url && !args.external_url) {
            return this.toolError(
              'save_artifact requires artifact_url or external_url. Prefer entity_action action=attach.',
              { code: 'invalid_input', status: 400 }
            );
          }

          const previewMarkdown =
            typeof args.content === 'string' && args.content.length > 0
              ? args.content.slice(0, 25_000)
              : undefined;
          const metadata: Record<string, unknown> = {};
          if (args.sessionId) metadata.session_id = args.sessionId;
          if (args.type && args.type !== artifactType) {
            // Preserve legacy category for downstream analytics.
            metadata.legacy_type = args.type;
          }

          const attachPayload = buildEntityActionAttachPayload({
            type: entityType,
            id: entityId,
            name: args.title,
            artifact_type: artifactType,
            artifact_url: args.artifact_url,
            external_url: args.external_url,
            preview_markdown: previewMarkdown,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          });

          const response = await callOrgxApiJson(
            this.env,
            '/api/client/artifacts',
            {
              method: 'POST',
              body: JSON.stringify(attachPayload),
            },
            resolvedUserId ? { userId: resolvedUserId } : undefined
          );

          const result = (await response.json()) as {
            ok?: boolean;
            skipped?: boolean;
            reason?: string;
            artifact?: Record<string, unknown>;
          };
          const artifactId =
            result.artifact && typeof result.artifact.id === 'string'
              ? result.artifact.id
              : undefined;

          return {
            content: [
              {
                type: 'text' as const,
                text: artifactId
                  ? `Artifact "${args.title}" attached with id ${artifactId} (save_artifact is deprecated — prefer entity_action action=attach)`
                  : `Artifact "${args.title}" attached (save_artifact is deprecated — prefer entity_action action=attach)`,
              },
            ],
            structuredContent: result,
          };
        })
    );
  }

  private registerResources() {
    // Register initiative resource (existing)
    const template = new ResourceTemplate('orgx://initiative/{id}', {
      list: undefined,
    });
    this.server.resource('initiative', template, async (_uri, variables) => {
      const response = await callOrgxApiJson(
        this.env,
        `/api/initiatives/${variables.id}`
      );
      const initiative = (await response.json()) as OrgXInitiative;
      const markdown = formatInitiativeMarkdown(initiative);
      return {
        contents: [
          {
            uri: `orgx://initiative/${initiative.id}`,
            mimeType: 'text/markdown',
            text: markdown,
          },
        ],
      };
    });

    // Register widget HTML resources (text/html;profile=mcp-app) for all MCP Apps hosts
    this.registerWidgetResources();

    // Register downloadable skill pack resources
    this.registerSkillResources();
  }

  /**
   * Register downloadable skill pack resources.
   * These skills can be installed to enhance OrgX MCP workflows.
   */
  private registerSkillResources() {
    // Downloadable skill packs for OrgX MCP
    const skillPacks = [
      {
        id: 'morning-briefing',
        name: 'Morning Briefing',
        version: '1.0.0',
        description:
          'Get your daily OrgX briefing - morning brief value signals, pending decisions via list_entities, blocked work, agent status, and initiative health.',
        domain: 'operations',
        requiredTools: [
          'mcp__orgx__get_morning_brief',
          'mcp__orgx__get_agent_status',
          'mcp__orgx__list_entities',
          'mcp__orgx__get_initiative_pulse',
        ],
      },
      {
        id: 'initiative-kickoff',
        name: 'Initiative Kickoff',
        version: '1.0.0',
        description:
          'From a one-line goal, creates a complete initiative with milestones, workstreams, and agent assignments.',
        domain: 'product',
        requiredTools: [
          'mcp__orgx__create_entity',
          'mcp__orgx__list_entities',
          'mcp__orgx__spawn_agent_task',
          'mcp__orgx__entity_action',
          'mcp__orgx__configure_org',
        ],
      },
      {
        id: 'bulk-create',
        name: 'Bulk Create',
        version: '1.0.0',
        description:
          'Create multiple tasks or milestones from a markdown checklist with automatic priority detection.',
        domain: 'operations',
        requiredTools: [
          'mcp__orgx__create_entity',
          'mcp__orgx__list_entities',
          'mcp__orgx__update_entity',
        ],
      },
    ];

    // Register skill catalog resource
    this.server.registerResource(
      'skill-catalog',
      'orgx://skills/catalog',
      { description: 'List of downloadable OrgX skill packs' },
      async () => {
        const catalog = skillPacks.map((skill) => ({
          id: skill.id,
          name: skill.name,
          version: skill.version,
          description: skill.description,
          domain: skill.domain,
          downloadUrl: `https://mcp.useorgx.com/skills/${skill.id}/download`,
          requiredTools: skill.requiredTools,
        }));

        return {
          contents: [
            {
              uri: 'orgx://skills/catalog',
              mimeType: 'application/json',
              text: JSON.stringify(
                { skills: catalog, total: catalog.length },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // Register individual skill resources
    for (const skill of skillPacks) {
      this.server.registerResource(
        `skill-${skill.id}`,
        `orgx://skills/${skill.id}`,
        { description: `${skill.name} skill pack` },
        async () => {
          // Fetch skill content from OrgX API
          try {
            const response = await callOrgxApiJson(
              this.env,
              `/api/skills/packs/${skill.id}`
            );
            const skillData = await response.json();
            return {
              contents: [
                {
                  uri: `orgx://skills/${skill.id}`,
                  mimeType: 'application/json',
                  text: JSON.stringify(skillData, null, 2),
                },
              ],
            };
          } catch {
            // Return basic skill info if API fails
            return {
              contents: [
                {
                  uri: `orgx://skills/${skill.id}`,
                  mimeType: 'application/json',
                  text: JSON.stringify(
                    {
                      id: skill.id,
                      name: skill.name,
                      version: skill.version,
                      description: skill.description,
                      domain: skill.domain,
                      requiredTools: skill.requiredTools,
                      status: 'available',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }
      );
    }
  }

  /**
   * Register widget HTML resources for ChatGPT App rendering.
   * Widgets receive data via structuredContent and window.openai.toolOutput.
   */
  private registerWidgetResources() {
    const widgetMeta = buildWidgetMeta(this.env);
    const mcpAppsMeta = buildMcpAppsMeta(this.env);
    const mcpAppsContentMeta = { ...widgetMeta, ...mcpAppsMeta };

    for (const widget of WIDGET_RESOURCES) {
      registerAppResource(
        this.server,
        widget.name,
        widget.uri,
        {
          description: widget.title,
          _meta: mcpAppsContentMeta,
        },
        async () =>
          this.buildWidgetResourceResponse(
            widget.uri,
            widget.title,
            RESOURCE_MIME_TYPE,
            mcpAppsContentMeta
          )
      );

      const widgetTemplateUri = toVersionTolerantWidgetResourceUri(widget.uri);
      this.server.registerResource(
        `${widget.name}-legacy-version`,
        new ResourceTemplate(widgetTemplateUri, { list: undefined }),
        {
          description: `${widget.title} (version-tolerant)`,
          mimeType: RESOURCE_MIME_TYPE,
          _meta: mcpAppsContentMeta,
        },
        async (uri) =>
          this.buildWidgetResourceResponse(
            uri.toString(),
            widget.title,
            RESOURCE_MIME_TYPE,
            mcpAppsContentMeta
          )
      );

      const outputTemplateUri = toSkybridgeResourceUri(widget.uri);
      this.server.registerResource(
        `${widget.name}-skybridge`,
        outputTemplateUri,
        {
          description: `${widget.title} (ChatGPT)`,
          mimeType: SKYBRIDGE_MIME_TYPE,
          _meta: widgetMeta,
        },
        async () =>
          this.buildWidgetResourceResponse(
            widget.uri,
            widget.title,
            SKYBRIDGE_MIME_TYPE,
            widgetMeta,
            outputTemplateUri
          )
      );

      const outputTemplateResourceUri =
        toVersionTolerantWidgetResourceUri(outputTemplateUri);
      this.server.registerResource(
        `${widget.name}-skybridge-legacy-version`,
        new ResourceTemplate(outputTemplateResourceUri, { list: undefined }),
        {
          description: `${widget.title} (ChatGPT, version-tolerant)`,
          mimeType: SKYBRIDGE_MIME_TYPE,
          _meta: widgetMeta,
        },
        async (uri) =>
          this.buildWidgetResourceResponse(
            toWidgetHtmlResourceUri(uri.toString()),
            widget.title,
            SKYBRIDGE_MIME_TYPE,
            widgetMeta,
            uri.toString()
          )
      );
    }
  }

  private async buildWidgetResourceResponse(
    widgetUri: string,
    widgetTitle: string,
    mimeType: string,
    meta: Record<string, unknown>,
    responseUri = widgetUri
  ) {
    const widgetBaseUrl = resolveWidgetBaseUrl(this.env);
    const { widgetFile, query } = parseWidgetResourceUri(widgetUri);
    const widgetPath = `/${widgetFile}${query}`;
    const assetUrl = new URL(`${widgetFile}${query}`, widgetBaseUrl).toString();

    let assetStatus: number | null = null;
    let apiStatus: number | null = null;
    let source: 'assets' | 'api' | 'fallback' = 'assets';
    let assetFetchError: string | null = null;

    this.appendWidgetDebugEvent({
      phase: 'resource_read_start',
      resourceUri: responseUri,
      mimeType,
      details: {
        widgetFile,
        assetUrl,
      },
    });

    try {
      let html: string | null = null;
      try {
        const assetResponse = await fetch(assetUrl, {
          headers: { accept: 'text/html,application/xhtml+xml,*/*' },
        });
        assetStatus = assetResponse.status;
        if (assetResponse.ok) {
          html = await assetResponse.text();
          source = 'assets';
        }
      } catch (error) {
        assetFetchError = error instanceof Error ? error.message : String(error);
      }

      if (!html) {
        const response = await callOrgxApiRaw(
          this.env,
          `/api/chatgpt/widgets${widgetPath}`,
          undefined,
          {
            accept: 'text/html,application/xhtml+xml,*/*',
          }
        );
        apiStatus = response.status;
        html = await response.text();
        source = 'api';
      }

      const htmlWithAbsoluteAssets = rewriteWidgetHtmlAssetUrls(
        html,
        widgetBaseUrl
      );
      const assetUrlsRewritten = htmlWithAbsoluteAssets !== html;
      let responseHtml = htmlWithAbsoluteAssets;
      let interactionKitInlined = false;
      let faviconStripped = false;

      if (mimeType === RESOURCE_MIME_TYPE) {
        let interactionKitCss: string | null = null;
        let interactionKitJs: string | null = null;

        if (responseHtml.includes('interaction-kit.css')) {
          try {
            interactionKitCss = await fetch(
              new URL('shared/interaction-kit.css', widgetBaseUrl).toString(),
              { headers: { accept: 'text/css,*/*' } }
            ).then(async (response) => (response.ok ? response.text() : null));
          } catch {
            interactionKitCss = null;
          }
        }

        if (responseHtml.includes('interaction-kit.js')) {
          try {
            interactionKitJs = await fetch(
              new URL('shared/interaction-kit.js', widgetBaseUrl).toString(),
              { headers: { accept: 'text/javascript,application/javascript,*/*' } }
            ).then(async (response) => (response.ok ? response.text() : null));
          } catch {
            interactionKitJs = null;
          }
        }

        // Inline any shared-component module the widget references. Claude's
        // widget sandbox treats the resource document as self-contained, so
        // external fetches of our own shared modules may not resolve. These
        // paths are the enforceable shared-layer contract — add new shared
        // modules to MCP_APPS_SHARED_COMPONENT_PATHS in widgetConfig.ts.
        const sharedComponents: Record<string, string | null> = {};
        for (const path of MCP_APPS_SHARED_COMPONENT_PATHS) {
          if (!responseHtml.includes(path)) continue;
          try {
            const accept = path.endsWith('.css')
              ? 'text/css,*/*'
              : 'text/javascript,application/javascript,*/*';
            const assetResponse = await fetch(
              new URL(path, widgetBaseUrl).toString(),
              { headers: { accept } }
            );
            sharedComponents[path] = assetResponse.ok
              ? await assetResponse.text()
              : null;
          } catch {
            sharedComponents[path] = null;
          }
        }

        const sanitizedHtml = sanitizeMcpAppsHtml(responseHtml, {
          interactionKitCss,
          interactionKitJs,
          sharedComponents,
        });
        faviconStripped = sanitizedHtml !== responseHtml && !sanitizedHtml.includes('rel="icon"');
        interactionKitInlined =
          sanitizedHtml.includes('data-inline-asset="interaction-kit.css"') ||
          sanitizedHtml.includes('data-inline-asset="interaction-kit.js"');
        responseHtml = sanitizedHtml;
      }

      this.appendWidgetDebugEvent({
        phase: 'resource_read_complete',
        resourceUri: responseUri,
        mimeType,
        details: {
          source,
          assetStatus,
          apiStatus,
          assetFetchError,
          assetUrlsRewritten,
          interactionKitInlined,
          faviconStripped,
          htmlBytes: responseHtml.length,
        },
      });

      return {
        contents: [
          {
            uri: responseUri,
            mimeType,
            text: responseHtml,
            _meta: meta,
          },
        ],
      };
    } catch (error) {
      source = 'fallback';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.appendWidgetDebugEvent({
        phase: 'resource_read_error',
        resourceUri: responseUri,
        mimeType,
        details: {
          source,
          assetStatus,
          apiStatus,
          assetFetchError,
          error: errorMessage,
        },
      });

      const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${widgetTitle}</title>
    <style>
      :root {
        --app-color-bg: #ffffff;
        --app-color-surface: #ffffff;
        --app-color-surface-elevated: #f7f7f8;
        --app-color-text: #0d0d0d;
        --app-color-text-secondary: #6e6e80;
        --app-color-border: #e5e5e5;
        --app-color-danger-bg: #fef2f2;
        --app-color-danger-text: #991b1b;
        --app-radius-md: 8px;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --app-color-bg: #212121;
          --app-color-surface: #2f2f2f;
          --app-color-surface-elevated: #424242;
          --app-color-text: #ececf1;
          --app-color-text-secondary: #8e8ea0;
          --app-color-border: #424242;
          --app-color-danger-bg: #7f1d1d;
          --app-color-danger-text: #fca5a5;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        background: var(--app-color-bg);
        color: var(--app-color-text);
      }
      .container { max-width: 480px; margin: 0 auto; }
      .card {
        background: var(--app-color-surface);
        border: 1px solid var(--app-color-border);
        border-radius: var(--app-radius-md);
        padding: 16px;
      }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .skeleton {
        background: linear-gradient(
          90deg,
          var(--app-color-surface-elevated) 0%,
          var(--app-color-bg) 50%,
          var(--app-color-surface-elevated) 100%
        );
        background-size: 200% 100%;
        animation: shimmer 1.8s infinite ease-in-out;
        border-radius: 6px;
      }
      .row { display: flex; gap: 12px; align-items: center; }
      .line { height: 12px; width: 100%; }
      .line.short { width: 45%; }
      .line.medium { width: 70%; }
      .spacer { height: 10px; }
      .alert {
        display: none;
        background: var(--app-color-danger-bg);
        color: var(--app-color-danger-text);
        border-radius: var(--app-radius-md);
        padding: 10px 12px;
        margin-top: 12px;
        font-size: 0.875rem;
        line-height: 1.4;
      }
      .alert strong { display: block; font-weight: 600; margin-bottom: 2px; }
      @media (prefers-reduced-motion: reduce) {
        .skeleton { animation: none; }
      }
    </style>
  </head>
  <body>
    <div class="container" role="region" aria-label="OrgX widget">
      <div class="card" role="status" aria-live="polite" aria-label="Loading widget">
        <div class="row">
          <div class="skeleton line short"></div>
        </div>
        <div class="spacer"></div>
        <div class="skeleton line"></div>
        <div class="spacer"></div>
        <div class="skeleton line medium"></div>
        <div id="fallback-alert" class="alert" role="alert">
          <strong>Couldn’t load this widget</strong>
          Please try again in a moment.
        </div>
      </div>
    </div>
    <script>
      setTimeout(function () {
        var el = document.getElementById('fallback-alert');
        if (el) el.style.display = 'block';
      }, 2500);
    </script>
  </body>
</html>`;

      return {
        contents: [
          {
            uri: responseUri,
            mimeType,
            text: fallbackHtml,
            _meta: meta,
          },
        ],
      };
    }
  }

  private registerPrompts() {
    const argsSchema = {
      initiative_name: z.string().min(1),
    };
    this.server.registerPrompt(
      'create-roadmap',
      {
        description:
          'Create an initiative plus supporting milestones and tasks',
        argsSchema,
      },
      async (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Create an initiative called "${args.initiative_name}" with 3 milestones and tasks. Use create_initiative, then create_milestone + create_task tools.`,
            },
          },
        ],
      })
    );

    // Plan feature prompt - guides the AI through the planning workflow
    const planFeatureSchema = {
      feature: z.string().min(1),
    };
    this.server.registerPrompt(
      'plan_feature',
      {
        description:
          'Plan a feature with automatic improvement suggestions and pattern learning. Use this when the user wants to plan a new feature.',
        argsSchema: planFeatureSchema,
      },
      async (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are helping the user plan a feature: "${args.feature}"

REQUIRED WORKFLOW:
1. First, call start_plan_session with feature_name="${args.feature}"
2. Draft an initial plan for the feature with sections:
   - ## Overview (what and why)
   - ## Technical Approach (how)
   - ## Implementation Steps (ordered tasks)
   - ## Edge Cases & Error Handling
   - ## Testing Strategy
3. Call improve_plan with the draft to get suggestions based on the user's patterns
4. Present the improved plan with suggestions incorporated
5. For each significant edit the user makes, call record_plan_edit to capture it
6. When the user approves the plan, ask if they want to start implementing
7. When implementation is done, call complete_plan with a summary of files changed

KEY BEHAVIORS:
- Always involve OrgX MCP in planning - it learns from the user's style
- Show suggestions with their source ("From your API patterns" etc.)
- Ask clarifying questions before diving into technical details
- If improve_plan returns skills from past sessions, mention this explicitly
- Keep track of the session_id from start_plan_session

The goal is to help the user create high-quality plans while learning their preferences.`,
            },
          },
        ],
      })
    );

    // Get my patterns prompt - helps users discover their learned patterns
    this.server.registerPrompt(
      'get_my_patterns',
      {
        description: 'Discover your learned planning patterns and skills',
        argsSchema: {},
      },
      async () => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Help the user understand their planning patterns.

1. Call list_plan_skills to get their saved patterns
2. Summarize what patterns they have by domain (API, database, frontend, etc.)
3. Mention which skills are most used
4. Suggest areas where they might want to create new skills

If they have no skills yet, explain how the system learns:
- Complete plan sessions to capture edit patterns
- The system notices repeated edits and suggests skills
- Skills can also be created manually

Offer to help them create a skill if they describe a pattern they want to remember.`,
            },
          },
        ],
      })
    );

    // Thursday E2E prompt — agent loop + widgets + context survival.
    // This is intentionally deterministic so it can be run live without hand-editing.
    const thursdayDemoSchema = {
      initiative_title: z
        .string()
        .optional()
        .describe('Optional custom initiative title for the run'),
    };

    const thursdayHandler = async (args: { initiative_title?: string }) => {
      const initiativeTitle =
        (typeof args.initiative_title === 'string' &&
          args.initiative_title.trim().length > 0 &&
          args.initiative_title.trim()) ||
        'Thursday E2E';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Run the OrgX MCP E2E flow end-to-end (Agent Loop + MCP Apps + Context Survival). This uses real OrgX APIs (no mocks).

Rules:
- Use returned IDs from tool JSON; do not invent IDs.
- Keep narration short; rely on widgets for the details.

Steps:
1) Ensure a workspace is set:
	   - Call \`workspace action=get\`
	   - If none is set, call \`workspace action=list\`, choose the one with \`is_default=true\` (or the first), then call \`workspace action=set\`.
3) Call \`scaffold_initiative\` to create an initiative titled "${initiativeTitle}" with 2 workstreams, each with 1 milestone and 2 tasks.
	   - Make the 4 tasks correspond to: (a) widgets render, (b) decision approve loop, (c) spawn agent task, (d) context survival proof.
	   - Capture the created task IDs from the scaffold JSON so you can update progress as you go.
4) Call \`get_initiative_pulse\` WITHOUT passing \`initiative_id\` (prove context survival via session defaults).
5) Create a pending decision under that initiative via \`create_entity\` (type=decision) titled "Approve next step" with a short summary and priority=high.
6) Call \`list_entities\` with \`type=decision\`, \`status=pending\`, and \`limit=10\` so the Decisions widget renders, then call \`approve_decision\` for the decision you just created.
	   - Mark the corresponding scaffolded task \`in_progress\` then \`done\` using \`update_entity\` (type=task).
7) Call \`spawn_agent_task\` to assign \`engineering-agent\` a small task linked to the initiative, but OMIT \`initiative_id\` (prove context survival).
8) Call \`get_agent_status\` and \`get_initiative_pulse\` to show the loop in motion.
	   - Mark remaining scaffolded tasks \`in_progress\` / \`done\` as each step completes using \`update_entity\`.
9) In 2-3 sentences: summarize what just happened and where to click (\`live_url\`) if someone loses context mid-session.`,
            },
          },
        ],
      };
    };

    this.server.registerPrompt(
      'thursday-e2e',
      {
        description:
          'E2E run: agent loop + MCP Apps widgets + context survival (real data)',
        argsSchema: thursdayDemoSchema,
      },
      thursdayHandler
    );

    // Backwards-compat alias for older docs/clients.
    this.server.registerPrompt(
      'thursday-e2e-demo',
      {
        description: 'Alias for thursday-e2e',
        argsSchema: thursdayDemoSchema,
      },
      thursdayHandler
    );
  }
}

const sseHandler = OrgXMcp.serveSSE('/sse');
const httpHandler = OrgXMcp.serve('/mcp');

const rateLimitedHttpHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const rateLimit = await checkEdgeRateLimit(request, env);
    if (!rateLimit.allowed) {
      return buildRateLimitedResponse(rateLimit, env.ORGX_WEB_URL);
    }

    const response = await httpHandler.fetch(request, env, ctx);
    return withCorsAndHeaders(response, rateLimit.headers);
  },
};

/**
 * Expose httpHandler for use by authHandler.ts (WebSocket + root URL routing)
 */
export function getHttpHandler() {
  return rateLimitedHttpHandler;
}

/**
 * Expose sseHandler for use by authHandler.ts (root URL SSE routing)
 */
export function getSseHandler() {
  return rateLimitedSseHandler;
}

// =============================================================================
// SSE POST→MCP REWRITE HANDLER
// OpenAI MCP client compatibility: POST /sse → /mcp
// =============================================================================

const rateLimitedSseHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const rateLimit = await checkEdgeRateLimit(request, env);
    if (!rateLimit.allowed) {
      return buildRateLimitedResponse(rateLimit, env.ORGX_WEB_URL);
    }

    // POST /sse → rewrite to /mcp (OpenAI client sends JSON-RPC to /sse)
    if (request.method === 'POST') {
      console.info('[mcp] route POST /sse -> /mcp (http JSON-RPC)');
      const rewritten = new URL(request.url);
      rewritten.pathname = '/mcp';
      const cloned = request.clone();
      const httpReq = new Request(rewritten.toString(), {
        method: cloned.method,
        headers: cloned.headers,
        body: cloned.body,
      });
      const response = await httpHandler.fetch(httpReq, env, ctx);
      return withCorsAndHeaders(response, rateLimit.headers);
    }

    // GET /sse → SSE transport (default behavior)
    const resp = await sseHandler.fetch(request, env, ctx);
    return withCorsAndHeaders(withSseKeepAlive(resp), rateLimit.headers);
  },
};

// =============================================================================
// OAUTH PROVIDER (DEFAULT EXPORT)
//
// Wraps the entire worker with OAuth 2.1 token validation.
// - /mcp, /sse, / → validated by provider, then forwarded to handlers
// - /token, /register → auto-generated by provider
// - /.well-known/* → auto-generated by provider
// - Everything else → authHandler (Clerk flow, health, landing, codex, etc.)
// =============================================================================

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    '/mcp': rateLimitedHttpHandler,
    '/sse': rateLimitedSseHandler,
  },
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 3600, // 1 hour
  refreshTokenTTL: 30 * 24 * 3600, // 30 days
  scopesSupported: [...OAUTH_SCOPES_SUPPORTED],
});

/**
 * Run-token fast path: detached agent runtimes (e2b/CLI) authenticate to the
 * MCP endpoint with a per-run, user-scoped bearer that the OAuth provider would
 * reject (it isn't an OAuth access token). Verify it here, inject the resolved
 * identity as `props`, and delegate straight to the MCP handler — bypassing the
 * OAuth provider. Only our own `oxrun1.` tokens are intercepted, so OAuth
 * bearers are untouched.
 */
async function tryRunTokenAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp' && url.pathname !== '/sse') return null;

  const header = request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  if (!isRunMcpToken(token)) return null;

  const payload = await verifyRunMcpToken(
    token,
    runMcpTokenSecret(env),
    Date.now()
  );
  if (!payload) return null;

  (ctx as unknown as { props?: OrgXMcpProps }).props = {
    userId: payload.uid,
    scope: 'mcp:run',
    ...(payload.wid ? { workspace_id: payload.wid } : {}),
    authSource: 'run_token',
  };

  const handler =
    url.pathname === '/sse' ? getSseHandler() : getHttpHandler();
  const response = await handler.fetch(request, env, ctx);
  return withSecurityHeaders(response);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const runTokenResponse = await tryRunTokenAuth(request, env, ctx);
    if (runTokenResponse) return runTokenResponse;

    const response = await oauthProvider.fetch(request, env, ctx);
    return withSecurityHeaders(response);
  },
};
