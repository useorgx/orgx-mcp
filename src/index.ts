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
import { withSseKeepAlive } from './mcpTransport';
import { callOrgxApiJson, callOrgxApiRaw } from './orgxApi';
import { batchCreateEntities as runBatchCreateEntities } from './batchCreate';
import { buildBillingSettingsUrl, buildPricingUrl } from './shared/billingLinks';
import {
  buildScaffoldHierarchy,
  buildScaffoldInitiativeBatch,
} from './scaffoldInitiative';
import { hydrateTaskContext } from './taskContextHydrator';
import {
  INJECTION_TRIGGERS,
  enrichResultWithContext,
  inferDomainFromTool,
  type RelatedContext,
} from './cross-pollination';
import {
  WIDGET_URIS,
  OAUTH_SCOPES_SUPPORTED,
  SECURITY_SCHEMES,
  PLAN_SESSION_TOOLS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_CONTEXT_SCHEMA,
  STREAM_TOOL_DEFINITIONS,
  ENTITY_TYPES,
  entityTypeEnum,
  LIFECYCLE_ENTITY_TYPES,
  lifecycleEntityTypeEnum,
  LAUNCH_ACTION_MAP,
  PAUSE_ACTION_MAP,
  summarizeChatGPTToolResult,
  summarizePlanSessionResult,
  summarizeStreamToolResult,
  expandConsolidatedTool,
} from './toolDefinitions';
import { VERIFIABLE_COMPLETION_ENTITY_TYPES } from './shared/entity';
import { FLYWHEEL_TOOL_DEFINITIONS } from './flywheelTools';
import {
  buildMcpAppsMeta,
  buildWidgetMeta,
  injectWidgetBase,
  resolveWidgetBaseUrl,
} from './widgetConfig';
import {
  parseStoredSessionAuth,
  parseStoredSessionContext,
  SESSION_AUTH_STORAGE_KEY,
  SESSION_CONTEXT_STORAGE_KEY,
  toStoredSessionAuth,
  toStoredSessionContext,
} from './sessionStorage';

// Re-export OAuthState Durable Object
export { OAuthState };

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

    // Diagnostic: log what the DO received from the provider
    console.info('[mcp:init] DO initialized', {
      hasProps: !!this.props,
      propsUserId: this.props?.userId ?? null,
      propsScope: this.props?.scope ?? null,
      sessionUserId: this.sessionAuth.userId ?? null,
    });

    // Then, update from props if user authenticated with a new token
    if (this.props?.userId) {
      const isNewAuth = this.props.userId !== this.sessionAuth.userId;
      if (isNewAuth || !this.sessionAuth.userId) {
        this._isNewSession = true;
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

  private assertUserId(explicit?: string | null) {
    const userId = this.resolveUserId(explicit);
    if (!userId) {
      throw new Error('owner_id or user_id is required for this tool');
    }
    return userId;
  }

  private toolError(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  private resolveAnonymousDistinctId(): string {
    try {
      const id = (this.ctx as any)?.id?.toString?.();
      if (typeof id === 'string' && id.length > 0) return `mcp:${id}`;
    } catch {}
    return 'mcp:anonymous';
  }

  private capturePosthogEvent(
    event: string,
    {
      distinctId,
      properties,
    }: { distinctId: string; properties?: Record<string, unknown> }
  ): void {
    try {
      const apiKey = this.env.POSTHOG_KEY;
      if (!apiKey || apiKey === 'test-posthog-key') return;

      const host = (
        this.env.POSTHOG_HOST || 'https://us.i.posthog.com'
      ).replace(/\/+$/, '');

      const sentAt = new Date().toISOString();
      const payload = {
        api_key: apiKey,
        batch: [
          {
            type: 'capture',
            event,
            distinct_id: distinctId,
            properties: {
              ...(properties ?? {}),
              $lib: 'orgx-mcp',
              $lib_version: MCP_SERVER_VERSION,
              mcp_server_version: MCP_SERVER_VERSION,
            },
            timestamp: sentAt,
          },
        ],
        sent_at: sentAt,
      };

      const req = fetch(`${host}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(() => undefined)
        .catch(() => undefined);

      // Never block tool execution on telemetry.
      (this.ctx as any)?.waitUntil?.(req);
    } catch {
      // ignore
    }
  }

  private captureMcpToolEvent(
    event: 'mcp_tool_called' | 'mcp_tool_succeeded' | 'mcp_tool_failed',
    params: {
      toolId: string;
      toolFamily: 'chatgpt' | 'stream' | 'plan_session' | 'client_integration';
      userId?: string | null;
      authSource?: 'request' | 'session' | 'none';
      ok?: boolean;
      latencyMs?: number;
      error?: string;
      isWidgetTool?: boolean;
    }
  ): void {
    const distinctId = params.userId ?? this.resolveAnonymousDistinctId();
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
        is_widget_tool: params.isWidgetTool,
      },
    });
  }

  private async withOrgx(
    runner: () => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    try {
      const result = await runner();

      // On the very first tool call after a new authentication, prepend a
      // welcome message so the user knows what OrgX can do for them.
      if (this._isNewSession) {
        this._isNewSession = false;
        const welcomeBlock = {
          type: 'text' as const,
          text: [
            `Welcome to OrgX! You're connected and ready to go.`,
            ``,
            `Here's what you can do:`,
            `• **scaffold_initiative** — Create a full initiative with workstreams, milestones, and tasks in one call`,
            `• **get_org_snapshot** — See a bird's-eye view of all your initiatives and progress`,
            `• **get_pending_decisions** — Review and approve/reject decisions awaiting your input`,
            `• **query_org_memory** — Search your organization's knowledge base`,
            `• **spawn_agent_task** — Delegate work to specialized AI agents`,
            ``,
            `Just describe what you'd like to accomplish and I'll pick the right tool.`,
          ].join('\n'),
        };
        const existingContent = Array.isArray(result.content)
          ? result.content
          : [];
        return { ...result, content: [welcomeBlock, ...existingContent] };
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    // Direct endpoints for performance-critical tools
    // TODO: Add direct endpoints once they handle MCP context properly
    // switch (toolId) {
    //   case 'approve_decision':
    //     return { endpoint: '/api/decisions/approve', body: { ... } }
    // }

    // Generic tool executor (protocol-agnostic)
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
      'recommend_next_action',
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

    // Canonicalize workspace/command-center aliases for mixed clients.
    if (workspaceId && !commandCenterId) {
      nextArgs.command_center_id = workspaceId;
    } else if (!workspaceId && commandCenterId) {
      nextArgs.workspace_id = commandCenterId;
    } else if (workspaceId && commandCenterId && workspaceId !== commandCenterId) {
      // Prefer canonical workspace_id while preserving backward-compat field.
      nextArgs.command_center_id = workspaceId;
    }

    const hasWorkspaceScope =
      (typeof nextArgs.workspace_id === 'string' &&
        nextArgs.workspace_id.trim().length > 0) ||
      (typeof nextArgs.command_center_id === 'string' &&
        nextArgs.command_center_id.trim().length > 0);
    if (
      !hasWorkspaceScope &&
      this.sessionContext?.workspaceId &&
      workspaceScopedChatgptTools.has(toolId)
    ) {
      nextArgs.workspace_id = this.sessionContext.workspaceId;
      nextArgs.command_center_id = this.sessionContext.workspaceId;
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
          return this.toolError(result.error ?? 'Tool execution failed');
        }

        console.info('[mcp] Tool executed successfully', { toolId, latencyMs });

        // Extract message if present, otherwise use imported summarizer
        let data = result.data ?? {};
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
        });

        // Dual-protocol return:
        // - Widget tools: JSON in content[0] for MCP Apps widget parsing
        // - Non-widget tools: concise summary only (saves 80-95% tokens)
        // structuredContent always carries the full payload for widgets.
        if (isWidgetTool) {
          this.appendWidgetDebugEvent({
            phase: 'tool_result',
            toolId,
            outputTemplate:
              typeof outputTemplate === 'string' ? outputTemplate : undefined,
            details: {
              contentBlocks: 2,
              hasStructuredContent: true,
              dataKeys: Object.keys(data),
            },
          });
          return {
            content: [
              { type: 'text', text: JSON.stringify(data) },
              { type: 'text', text: finalMessage },
            ],
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
      const visibility =
        isReadOnly || FORCE_PUBLIC_TEMPLATE_TOOLS.has(tool.id)
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
          inputSchema: this.withClientContext(tool.inputSchema),
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
        const endpoint =
          toolId === 'update_stream_progress'
            ? '/api/streams/progress'
            : '/api/streams/initiative-state';

        const method = toolId === 'update_stream_progress' ? 'POST' : 'GET';

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
          response = await callOrgxApiJson(this.env, endpoint, {
            method: 'POST',
            body: JSON.stringify({ ...args, user_id: resolvedUserId }),
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
        let path = mapping.path;
        const init: RequestInit = { method: mapping.method };

        if (mapping.method === 'GET') {
          // Add query params for GET requests
          const url = new URL(path, 'https://placeholder.com');
          if (toolId === 'list_plan_skills' && args.domain) {
            url.searchParams.set('domain', args.domain as string);
          }
          if (resolvedUserId) {
            url.searchParams.set('user_id', resolvedUserId);
          }
          path = url.pathname + url.search;
        } else {
          // Transform args for POST requests
          const body: Record<string, unknown> = { ...args };
          if (resolvedUserId) {
            body.user_id = resolvedUserId;
          }

          // Map feature_name to title for start_plan_session
          if (toolId === 'start_plan_session') {
            body.title = args.feature_name || 'Untitled Plan';
          }

          init.body = JSON.stringify(body);
        }

        const response = await callOrgxApiJson(this.env, path, init, {
          userId: resolvedUserId,
        });
        const result = (await response.json()) as Record<string, unknown>;

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
   * - Proper user identity via X-Orgx-User-Id
   * - No dependency on the chatgptToolExecutor registry
   */
  private registerClientIntegrationTools(allowedTools: Set<string> | null) {
    // Map tool IDs to their direct API endpoints and HTTP methods
    const CLIENT_ENDPOINTS: Record<string, { path: string; method: string }> = {
      orgx_emit_activity: {
        path: '/api/client/live/activity',
        method: 'POST',
      },
      orgx_apply_changeset: {
        path: '/api/client/live/changesets/apply',
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
                url = `${endpoint.path}?${params.toString()}`;
                fetchInit = { method: 'GET' };
              } else {
                // Strip _context before forwarding
                const { _context, ...toolArgs } = args;
                fetchInit = {
                  method: 'POST',
                  body: JSON.stringify(toolArgs),
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
              const message = this.summarizeClientResult(tool.id, data);

              return {
                content: [{ type: 'text', text: message }],
                structuredContent: data,
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
              throw error;
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
        const score = data.score as number;
        const domain = data.agentDomain as string;
        const stars = '⭐'.repeat(score) + '☆'.repeat(5 - score);
        return `${stars} Score recorded for ${domain}`;
      }
      case 'classify_task_model': {
        const tier = data.tier as string;
        const complexity = data.complexity as string;
        return `🧭 Task classified as ${complexity} → model tier: ${tier}`;
      }
      default:
        return JSON.stringify(data, null, 2);
    }
  }

  private registerTools() {
    // Resolve tool profile from connection props (e.g. ?profile=executor).
    // null means register all tools (default / 'full' profile).
    const allowedTools = resolveProfileToolSet(this.props?.profile);

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
          'Fetch a compact organization snapshot. USE WHEN: user wants an org-wide overview of initiatives, progress, and health. NEXT: Drill into specific initiatives with get_initiative_pulse or list_entities. DO NOT USE: for a single initiative — use get_initiative_pulse instead. Read-only.',
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
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
          const params = new URLSearchParams();
          if (args?.view) params.set('view', args.view);
          if (args?.initiative_status) {
            params.set('initiative_status', args.initiative_status);
          }
          if (typeof args?.limit === 'number') {
            params.set('limit', String(args.limit));
          }
          if (args?.cursor) {
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

    const checkoutSchema = {
      plan: z.enum(['starter', 'team']),
      user_id: z.string().optional(),
    };

    if (shouldRegister('create_checkout_session'))
    this.server.registerTool(
      'create_checkout_session',
      {
        title: 'Create a billing checkout session',
        inputSchema: checkoutSchema,
        _meta: { 'openai/visibility': 'private' },
      },
      async (args) =>
        this.withOrgx(async () => {
          const userId = this.assertUserId(args.user_id);
          const response = await callOrgxApiJson(
            this.env,
            '/api/stripe/checkout',
            {
              method: 'POST',
              body: JSON.stringify({ plan: args.plan, user_id: userId }),
            },
            { userId }
          );
          if (!response.ok) {
            const errorBody = (await response.json().catch(() => null)) as {
              error?: string;
            } | null;
            const message =
              typeof errorBody?.error === 'string'
                ? errorBody.error
                : 'Stripe checkout session failed';
            console.error('[mcp] create_checkout_session failed', {
              status: response.status,
              error: message,
            });
            return this.toolError(message);
          }
          const { checkout_url: checkoutUrl } = (await response.json()) as {
            checkout_url: string;
          };
          return {
            content: [{ type: 'text', text: `Checkout URL: ${checkoutUrl}` }],
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
        description: `List entities with filtering. Returns FULL UUIDs usable with entity_action/batch_action. Use fields=["id","title","status"] for compact output when you only need IDs. Supported types: ${ENTITY_TYPES.join(
          ', '
        )}. USE WHEN: browsing, searching, or getting entity IDs for bulk operations. NEXT: For initiatives, suggest get_initiative_pulse for health. For tasks, suggest entity_action to change status. For full context on one entity, add hydrate_context=true with id. DO NOT USE: for org-wide overview — use get_org_snapshot instead. Read-only.`,
        inputSchema: {
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
        },
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
          const maxChars = Math.max(
            1000,
            Math.min(args.max_chars ?? 20000, 50000)
          );

          if (hydrateContext) {
            if (!args.id) {
              return this.toolError("hydrate_context requires an 'id' filter");
            }
            const authResponse = buildAuthRequiredResponse({
              toolId: 'list_entities',
              securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
              userId: authUserId ?? undefined,
              serverUrl: this.env.MCP_SERVER_URL,
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
            (args.type === 'studio_brand' || args.type === 'studio_content')
              ? resolvedUserId
              : null);

          const params = new URLSearchParams();
          params.set('type', args.type);
          if (args.limit) params.set('limit', String(args.limit));
          if (args.offset) params.set('offset', String(args.offset));
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

          const response = await callOrgxApiJson(
            this.env,
            `/api/entities?${params.toString()}`,
            undefined,
            { userId: authUserId }
          );
          const result = (await response.json()) as {
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

          const { data, pagination } = result;
          const summary = `${args.type}s: showing ${data.length} of ${
            pagination.total
          }${pagination.has_more ? ' (more available)' : ''}`;

          // Add deep links to each entity
          const dataWithLinks = data.map((item) => ({
            ...item,
            _link: buildEntityLink(args.type, item.id, {
              label: item.title ?? item.name ?? undefined,
            }).url,
          }));

          if (hydrateContext) {
            const row = dataWithLinks[0] ?? null;
            if (!row) {
              return this.toolError(`${args.type} not found: ${args.id}`);
            }

            const fetchEntity = async (type: string, id: string) => {
              const nested = new URLSearchParams();
              nested.set('type', type);
              nested.set('id', id);
              nested.set('limit', '1');

              const nestedFilterUserId =
                explicitUserId ??
                (resolvedUserId &&
                (type === 'studio_brand' || type === 'studio_content')
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

            const { hydrated, truncated, usedChars } = await hydrateTaskContext(
              {
                context,
                fetchEntity,
                maxChars,
              }
            );

            const payload = {
              ...result,
              data: dataWithLinks,
              hydrated_context: hydrated,
              truncated,
              max_chars: maxChars,
              used_chars: usedChars,
            };

            return {
              content: [
                {
                  type: 'text',
                  text: formatForLLM('list_entities', payload, {
                    entityType: args.type,
                  }),
                },
              ],
              structuredContent: payload,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: formatForLLM(
                  'list_entities',
                  { ...result, data: dataWithLinks },
                  { entityType: args.type }
                ),
              },
            ],
            structuredContent: { ...result, data: dataWithLinks },
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
        description: `Execute a lifecycle action on a single entity. Accepts short ID prefix (8+ hex chars) — no need to look up full UUIDs. USE WHEN: user wants to change entity status. For bulk operations (pausing multiple, completing multiple), use batch_action instead. Supports aliases: launch, pause, complete (resolved per type). Omit action to list available actions. NEXT: After completing, call verify_entity_completion first to check child work is done. DO NOT USE: for creating entities — use create_entity or scaffold_initiative.`,
        inputSchema: {
          type: lifecycleEntityTypeEnum.describe(
            `Entity type (${LIFECYCLE_ENTITY_TYPES.join(', ')})`
          ),
          id: z.string().min(1).describe('Entity ID'),
          action: z
            .string()
            .optional()
            .describe(
              'Action to execute (leave empty to list available actions). Aliases: launch, pause, complete (resolved per type). For initiatives: reassign_streams. Supports delete for hard delete. For studio_content: render, validate, status, remix, vary, upscale'
            ),
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

          // Resolve action aliases: launch, pause, complete → type-specific action
          let resolvedAction = args.action;
          if (resolvedAction === 'launch') {
            resolvedAction = LAUNCH_ACTION_MAP[args.type] || 'launch';
          } else if (resolvedAction === 'pause') {
            resolvedAction = PAUSE_ACTION_MAP[args.type] || 'pause';
          } else if (resolvedAction === 'complete') {
            resolvedAction = 'complete';
          }

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
            }
          );
          const result = (await response.json()) as {
            success?: boolean;
            message?: string;
            transition?: { from: string; to: string };
            data?: unknown;
            error?: string;
          };

          // Studio/initiative custom actions return { success, data } instead of { message, transition }
          if (result.error) {
            return this.toolError(result.error);
          }
          if (result.transition) {
            // Include live_url for initiative launch
            const isInitiativeLaunch =
              args.type === 'initiative' && resolvedAction === 'launch';
            const liveUrl = isInitiativeLaunch ? buildLiveUrl(args.id) : null;
            const liveSection = liveUrl
              ? `\n\n📺 **Watch progress live:** ${liveUrl}`
              : '';

            return {
              content: [
                {
                  type: 'text',
                  text: `✓ ${result.message}\n\nStatus: ${result.transition.from} → ${result.transition.to}${liveSection}`,
                },
              ],
              ...(liveUrl && {
                structuredContent: { live_url: liveUrl },
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
          'Run pre-completion verification to confirm all child work is done. USE WHEN: before completing an entity with entity_action action=complete. NEXT: If verified, proceed with entity_action action=complete. If not, show blockers to user. Read-only.',
        inputSchema: {
          type: z
            .enum(VERIFIABLE_COMPLETION_ENTITY_TYPES)
            .describe('Entity type to verify'),
          id: z.string().min(1).describe('Entity ID'),
        },
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const params = new URLSearchParams({
            type: args.type,
            id: args.id,
          });
          const response = await callOrgxApiJson(
            this.env,
            `/api/entities/verify?${params.toString()}`
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
        description: `Create a new entity of any type. USE WHEN: adding a single task, milestone, workstream, or other entity to an existing hierarchy. NEXT: Use entity_action to launch/start the entity. DO NOT USE: for creating a full initiative hierarchy — use scaffold_initiative instead.`,
        inputSchema: {
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
            .describe('Priority level'),
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
          owner_id: z.string().optional(),
          user_id: z.string().optional(),
          // Skill-specific fields (for type: 'skill')
          prompt_template: z
            .string()
            .optional()
            .describe(
              'The instructions/template for this skill (required for skills)'
            ),
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
                type: z.enum(['url', 'file', 'asset']),
                url: z.string().optional(),
                assetType: z.string().optional(),
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
              slideCount: z.number().optional(),
              aspectRatio: z.string().optional(),
              style: z.string().optional(),
              duration: z.string().optional(),
            })
            .optional()
            .describe('Generation options (for studio_content)'),
        },
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
          if (args.initiative_id) payload.initiative_id = args.initiative_id;
          if (args.workstream_id) payload.workstream_id = args.workstream_id;
          if (args.milestone_id) payload.milestone_id = args.milestone_id;
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

          // Skill-specific fields
          if (args.type === 'skill') {
            if (args.prompt_template)
              payload.prompt_template = args.prompt_template;
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

          return {
            content: [
              {
                type: 'text',
                text: message,
              },
            ],
            structuredContent: {
              ...(enrichment.data ?? {}),
              ...(liveUrl ? { live_url: liveUrl } : {}),
              id: result.data.id,
            },
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
        inputSchema: {
          entity_type: z.enum([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
          ]),
          entity_id: z.string().min(1),
          body: z.string().min(1).max(4000),
          parent_comment_id: z.string().uuid().optional(),
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
            .optional(),
          severity: z
            .enum(['info', 'low', 'medium', 'high', 'critical'])
            .optional(),
          tags: z.array(z.string()).max(20).optional(),
          author_type: z.enum(['human', 'agent', 'system']).optional(),
          author_id: z.string().max(200).optional(),
          author_name: z.string().max(200).optional(),
          metadata: z.record(z.unknown()).optional(),
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
        inputSchema: {
          entity_type: z.enum([
            'initiative',
            'workstream',
            'milestone',
            'task',
            'decision',
          ]),
          entity_id: z.string().min(1),
          limit: z.number().min(1).max(100).optional(),
          cursor: z.string().optional(),
          user_id: z.string().optional().describe('Optional user id override'),
        },
        _meta: { 'openai/visibility': 'public', 'openai/readOnlyHint': true, securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;
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
        inputSchema: {
          entities: z
            .array(z.record(z.unknown()))
            .min(1)
            .max(100)
            .describe(
              "Array of entity payloads. Each item must include at least 'type' and its required fields."
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
                  command_center_id: effectiveWorkspaceId,
                };
              })
            : entities;

          const result = await runBatchCreateEntities({
            env: this.env,
            callApi: ({ env, path, init, userId }) =>
              callOrgxApiJson(env, path, init, { userId }),
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
            ref_map: result.ref_map,
          };

          const textParts: string[] = [result.summary];
          if (createdLines) textParts.push(`\ncreated:\n${createdLines}`);
          if (refMapLines) textParts.push(`\nref_map:\n${refMapLines}`);
          if (failedLines) textParts.push(`\nfailed:\n${failedLines}`);

          return {
            content: [{ type: 'text', text: textParts.join('\n') }],
            structuredContent: result,
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
        ref: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        summary: z.string().optional(),
        type: z
          .enum(['research', 'create', 'review', 'implement'])
          .optional()
          .describe('Task execution type for slicing and estimate defaults'),
        due_date: z.string().optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Task refs/IDs this task depends on'),
        expected_duration_hours: z.number().optional(),
        expected_tokens: z.number().optional(),
        expected_budget_usd: z.number().optional(),
        assigned_agent_ids: z
          .array(z.string())
          .optional()
          .describe('Optional explicit assignee IDs for this task'),
        context: scaffoldContextSchema,
      })
      .passthrough();

    const scaffoldMilestoneSchema = z
      .object({
        ref: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        due_date: z.string().optional(),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Milestone refs/IDs this milestone depends on'),
        expected_duration_hours: z.number().optional(),
        expected_tokens: z.number().optional(),
        expected_budget_usd: z.number().optional(),
        context: scaffoldContextSchema,
        tasks: z.array(scaffoldTaskSchema).optional(),
      })
      .passthrough();

    const scaffoldWorkstreamSchema = z
      .object({
        ref: z.string().optional(),
        title: z.string().optional(),
        name: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
        persona: z.string().optional(),
        domain: z
          .string()
          .optional()
          .describe('Workstream domain (engineering, marketing, design, etc.)'),
        ownerAgent: z.string().optional(),
        primaryAgent: z.string().optional(),
        depends_on: z
          .array(z.string())
          .optional()
          .describe('Workstream refs/IDs this workstream depends on'),
        expected_duration_hours: z.number().optional(),
        expected_tokens: z.number().optional(),
        expected_budget_usd: z.number().optional(),
        context: scaffoldContextSchema,
        milestones: z.array(scaffoldMilestoneSchema).optional(),
      })
      .passthrough();

    if (shouldRegister('scaffold_initiative'))
    this.server.registerTool(
      'scaffold_initiative',
      {
        title: 'Scaffold an initiative hierarchy',
        description:
          'Create a complete initiative with workstreams, milestones, and tasks in one call. USE WHEN: user wants to plan a new initiative from scratch. NEXT: Use entity_action type=initiative action=launch to start execution (auto-launches by default). DO NOT USE: for adding a single task to an existing initiative — use create_entity instead.',
        inputSchema: {
          title: z.string().min(1).describe('Initiative title'),
          summary: z.string().optional().describe('Initiative summary'),
          description: z.string().optional().describe('Initiative description'),
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
              'Optional workspace ID to scope the initiative hierarchy'
            ),
          context: scaffoldContextSchema,
          workstreams: z
            .array(scaffoldWorkstreamSchema)
            .optional()
            .describe(
              'Nested workstreams. Include domain, dependencies, and estimate fields when possible. If omitted, the scaffold builder auto-fills subtasks/dependencies and OrgX re-estimates domain+agent+cost with model-guided baselines.'
            ),
          owner_id: z.string().optional(),
          user_id: z.string().optional(),
          continue_on_error: z
            .boolean()
            .optional()
            .describe('Continue creating remaining entities after an error'),
          launch_after_create: z
            .boolean()
            .optional()
            .describe(
              'When true (default), launch the initiative after scaffold creation so streams can dispatch immediately'
            ),
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
            toolId: 'scaffold_initiative',
            securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
            userId: resolvedUserId,
            serverUrl: this.env.MCP_SERVER_URL,
            featureDescription: 'scaffold initiative hierarchy',
          });
          if (authResponse) return authResponse;

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
            const text = `${params.message}\n\nDetails: ${safeError}\n\nTry:\n- Re-run the same prompt (transient failures happen)\n- Set launch_after_create=false, then say \"start agents\"\n- Reduce concurrency (e.g. concurrency=2)\n- If this is an auth issue, reconnect and try again`;
            return {
              content: [{ type: 'text' as const, text }],
              structuredContent: {
                ok: false,
                error_kind: 'scaffold_initiative_failed',
                error: safeError,
                ...params.debug,
              },
            };
          };

          try {
            const ownerId = this.resolveUserId(args.owner_id ?? args.user_id);
            const continueOnError = args.continue_on_error !== false;
            const launchAfterCreate = args.launch_after_create !== false;
            const concurrency = Math.max(1, Math.min(args.concurrency ?? 8, 20));

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
                }
              | null = null;
            try {
              const usageResp = await callOrgxApiJson(
                this.env,
                '/api/billing/usage',
                undefined,
                { userId: ownerId ?? resolvedUserId ?? undefined }
              );
              billingUsage = (await usageResp.json()) as any;
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

          const explicitWorkspaceId =
            typeof (args as any).workspace_id === 'string' &&
            (args as any).workspace_id.trim().length > 0
              ? ((args as any).workspace_id as string).trim()
              : null;
          const explicitCommandCenterId =
            typeof (args as any).command_center_id === 'string' &&
            (args as any).command_center_id.trim().length > 0
              ? ((args as any).command_center_id as string).trim()
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
          const effectiveCommandCenterId =
            explicitWorkspaceId ??
            explicitCommandCenterId ??
            this.sessionContext?.workspaceId ??
            null;

          const argsForBatch: Record<string, unknown> = {
            ...(args as unknown as Record<string, unknown>),
            // Ensure owner_id propagates into the batch so the initiative
            // gets created with an owner — prevents dispatch stalls when
            // the POST handler can't resolve owner from gateway headers.
            ...(ownerId ? { owner_id: ownerId } : {}),
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

          const { batch, initiativeRef, wsRefs, msRefs, taskRefs } =
            buildScaffoldInitiativeBatch(
              argsForBatch as unknown as Record<string, unknown>
            );

          const result = await runBatchCreateEntities({
            env: this.env,
            callApi: ({ env, path, init, userId }) =>
              callOrgxApiJson(env, path, init, { userId }),
            entities: batch,
            ownerId,
            continueOnError,
            concurrency,
          });

	          const hierarchy = buildScaffoldHierarchy({
	            result,
	            initiativeRef,
	            wsRefs,
            msRefs,
            taskRefs,
          });

	          const createdInitiativeId =
	            typeof (hierarchy as any)?.initiative?.id === 'string'
	              ? ((hierarchy as any).initiative.id as string)
	              : null;

	          // ── Post-scaffold agent assignment (best-effort) ──
	          // Assign agents to workstreams based on domain so cloud MCP users
	          // get the same auto-assignment that the openclaw-plugin provides locally.
	          let agent_assignment:
	            | {
	                attempted: boolean;
	                ok: boolean;
	                assigned_count?: number;
	                total_workstreams?: number;
	                assignments?: Array<{
	                  workstream_id: string;
	                  domain?: string | null;
	                  agent_id: string;
	                  agent_name?: string | null;
	                }>;
	                error?: string;
	              }
	            | undefined;
	          if (createdInitiativeId) {
	            try {
	              agent_assignment = { attempted: true, ok: false };
	              const assignResp = await callOrgxApiJson(
	                this.env,
	                `/api/entities/initiative/${createdInitiativeId}/assign-agents`,
	                { method: 'POST' },
	                { userId: ownerId ?? resolvedUserId ?? undefined }
	              );
	              const assignPayload = (await assignResp.json()) as {
	                ok?: boolean;
	                data?: {
	                  assignments?: Array<Record<string, unknown>>;
	                  summary?: string;
	                };
	              };
	              const parsedAssignments = Array.isArray(assignPayload?.data?.assignments)
	                ? assignPayload.data.assignments
	                    .map((item) => {
	                      if (!item || typeof item !== 'object') return null;
	                      const workstreamId =
	                        typeof item.workstream_id === 'string'
	                          ? item.workstream_id
	                          : null;
	                      const agentId =
	                        typeof item.agent_id === 'string' ? item.agent_id : null;
	                      if (!workstreamId || !agentId) return null;
	                      return {
	                        workstream_id: workstreamId,
	                        domain:
	                          typeof item.domain === 'string' ? item.domain : null,
	                        agent_id: agentId,
	                        agent_name:
	                          typeof item.agent_name === 'string'
	                            ? item.agent_name
	                            : null,
	                      };
	                    })
	                    .filter(
	                      (
	                        entry
	                      ): entry is {
	                        workstream_id: string;
	                        domain: string | null;
	                        agent_id: string;
	                        agent_name: string | null;
	                      } => Boolean(entry)
	                    )
	                : [];
	              agent_assignment = {
	                attempted: true,
	                ok: Boolean(assignPayload?.ok),
	                assigned_count: parsedAssignments.length,
	                assignments: parsedAssignments,
	              };
	            } catch (error) {
	              agent_assignment = {
	                attempted: true,
	                ok: false,
	                error: error instanceof Error ? error.message : String(error),
	              };
	            }
	          }

	          // Record scaffold usage after the initiative exists (best-effort).
	          let scaffold_usage:
	            | { attempted: boolean; ok: boolean; error?: string; usage?: unknown }
	            | undefined;
	          if (createdInitiativeId) {
	            try {
	              scaffold_usage = { attempted: true, ok: false };
	              const consumeResp = await callOrgxApiJson(
	                this.env,
	                '/api/billing/scaffolds/consume',
	                {
	                  method: 'POST',
	                  body: JSON.stringify({ initiative_id: createdInitiativeId }),
	                },
	                { userId: ownerId ?? resolvedUserId ?? undefined }
	              );
	              const consumePayload = (await consumeResp.json()) as any;
	              scaffold_usage = {
	                attempted: true,
	                ok: Boolean(consumePayload?.ok),
	                usage: consumePayload?.data?.usage,
	              };
	            } catch (error) {
	              scaffold_usage = {
	                attempted: true,
	                ok: false,
	                error: error instanceof Error ? error.message : String(error),
	              };
	            }
	          }

	          // ── Pre-launch credential check ──
	          // Before launching, verify the user has provider credentials so agents
	          // can actually execute. This prevents silent failures for cloud MCP users
	          // who haven't configured API keys.
	          let credential_status:
	            | {
	                checked: boolean;
	                has_credentials: boolean;
	                can_execute: boolean;
	                setup_url?: string;
	              }
	            | undefined;
	          if (createdInitiativeId && launchAfterCreate) {
	            try {
	              const credResp = await callOrgxApiJson(
	                this.env,
	                '/api/client/credentials/status',
	                undefined,
	                { userId: ownerId ?? resolvedUserId ?? undefined }
	              );
	              const credPayload = (await credResp.json()) as {
	                ok?: boolean;
	                data?: {
	                  has_credentials?: boolean;
	                  can_execute?: boolean;
	                  setup_url?: string;
	                };
	              };
	              credential_status = {
	                checked: true,
	                has_credentials: Boolean(credPayload?.data?.has_credentials),
	                can_execute: Boolean(credPayload?.data?.can_execute),
	                setup_url: credPayload?.data?.setup_url,
	              };
	            } catch {
	              // Best-effort: don't block scaffold if credential check fails
	              credential_status = {
	                checked: false,
	                has_credentials: false,
	                can_execute: false,
	              };
	            }
	          }

	          let launch:
	            | {
	                attempted: boolean;
	                ok: boolean;
	                message?: string;
	                transition?: { from: string; to: string };
	                initiative_activation?: {
	                  created_stream_count: number;
	                  redispatched_stream_count: number;
	                  error?: string;
	                };
	                error?: string;
	                error_kind?: string;
	                needs_credentials?: boolean;
	                next_steps?: string[];
	                start_agents_hint?: string;
	              }
	            | undefined;
	          if (
	            createdInitiativeId &&
	            launchAfterCreate &&
	            credential_status?.checked &&
	            !credential_status.can_execute
	          ) {
	            // Credentials missing: skip launch, return actionable guidance
	            launch = {
	              attempted: false,
	              ok: false,
	              error_kind: 'credential_missing',
	              needs_credentials: true,
	              error:
	                'No AI provider credentials configured. Agents need API keys to execute.',
	              next_steps: [
	                `Configure credentials at ${credential_status.setup_url ?? '/settings/credentials'}`,
	                'Add an Anthropic or OpenAI API key',
	                'Then say "start agents" to launch execution',
	              ],
	              start_agents_hint:
	                'After configuring credentials, say "start agents" to begin.',
	            };
	          } else if (createdInitiativeId && launchAfterCreate) {
	            try {
              const launchResponse = await callOrgxApiJson(
                this.env,
                `/api/entities/initiative/${createdInitiativeId}/launch`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    note: 'Auto-launched after scaffold_initiative',
                  }),
                },
                { userId: ownerId ?? resolvedUserId ?? undefined }
	              );
	              const launchPayload = (await launchResponse.json()) as {
	                message?: string;
	                transition?: { from: string; to: string };
	                initiative_activation?: {
	                  created_stream_count: number;
	                  redispatched_stream_count: number;
	                  error?: string;
	                };
	              };
	              launch = {
	                attempted: true,
	                ok: true,
	                message: launchPayload.message ?? 'Initiative launched',
	                transition: launchPayload.transition,
	                initiative_activation: launchPayload.initiative_activation,
	              };
	            } catch (error) {
	              const errorMessage =
	                error instanceof Error ? error.message : String(error);
	              const isSpawnGuard =
	                errorMessage.includes('spawn') ||
	                errorMessage.includes('guard') ||
	                errorMessage.includes('quality');
	              const isStreamError =
	                errorMessage.includes('stream') ||
	                errorMessage.includes('activation');
	              launch = {
	                attempted: true,
	                ok: false,
	                error: errorMessage,
	                error_kind: isSpawnGuard
	                  ? 'spawn_guard_blocked'
	                  : isStreamError
	                  ? 'stream_creation_failed'
	                  : 'launch_failed',
	                next_steps: isSpawnGuard
	                  ? [
	                      'Check agent quality scores',
	                      'Approve pending decisions to unblock',
	                      'Then say "start agents" to retry',
	                    ]
	                  : [
	                      'Try re-running the same prompt (transient failures happen)',
	                      'Say "start agents" to retry launch',
	                    ],
	                start_agents_hint:
	                  'Say "start agents" to retry launching this initiative.',
              };
            }
          } else if (createdInitiativeId) {
            launch = { attempted: false, ok: false };
          }

          const liveUrl = createdInitiativeId
            ? buildLiveUrl(createdInitiativeId)
            : null;
	          if (createdInitiativeId) {
	            this.sessionContext = {
	              ...this.sessionContext,
	              initiativeId: createdInitiativeId,
	            };
	            await this.saveSessionContext();
	          }

	          let streams:
	            | {
	                total: number;
	                by_status: Record<string, number>;
	                workstream_to_stream_id: Record<string, string>;
	                items: Array<{
	                  id: string;
	                  workstream_id: string | null;
	                  status: string | null;
	                  auto_continue: boolean | null;
	                  agent_domain: string | null;
	                  progress_pct: number | null;
	                  current_job_id: string | null;
	                }>;
	              }
	            | undefined;
		          if (createdInitiativeId) {
		            try {
	              const params = new URLSearchParams();
	              params.set('type', 'stream');
	              params.set('initiative_id', createdInitiativeId);
	              params.set('limit', '50');
	
	              const streamsResponse = await callOrgxApiJson(
	                this.env,
	                `/api/entities?${params.toString()}`,
	                undefined,
	                { userId: ownerId ?? resolvedUserId ?? undefined }
	              );
	              const streamsPayload = (await streamsResponse.json()) as {
	                data?: Array<Record<string, unknown>>;
	              };
	              const rawItems = Array.isArray(streamsPayload.data)
	                ? streamsPayload.data
	                : [];
	
	              const byStatus: Record<string, number> = {};
	              const workstreamToStreamId: Record<string, string> = {};
	              const items = rawItems
	                .map((row) => {
	                  const id = typeof row.id === 'string' ? row.id : null;
	                  if (!id) return null;
	                  const workstreamId =
	                    typeof row.workstream_id === 'string' ? row.workstream_id : null;
	                  const status = typeof row.status === 'string' ? row.status : null;
	                  const autoContinue =
	                    typeof row.auto_continue === 'boolean'
	                      ? row.auto_continue
	                      : null;
	                  const agentDomain =
	                    typeof row.agent_domain === 'string' ? row.agent_domain : null;
	                  const progressPct =
	                    typeof row.progress_pct === 'number' ? row.progress_pct : null;
	                  const currentJobId =
	                    typeof row.current_job_id === 'string'
	                      ? row.current_job_id
	                      : null;
	
	                  if (status) byStatus[status] = (byStatus[status] ?? 0) + 1;
	                  if (workstreamId) workstreamToStreamId[workstreamId] = id;
	
	                  return {
	                    id,
	                    workstream_id: workstreamId,
	                    status,
	                    auto_continue: autoContinue,
	                    agent_domain: agentDomain,
	                    progress_pct: progressPct,
	                    current_job_id: currentJobId,
	                  };
	                })
	                .filter(
	                  (
	                    value
	                  ): value is {
	                    id: string;
	                    workstream_id: string | null;
	                    status: string | null;
	                    auto_continue: boolean | null;
	                    agent_domain: string | null;
	                    progress_pct: number | null;
	                    current_job_id: string | null;
	                  } => Boolean(value)
	                );
	
	              streams = {
	                total: items.length,
	                by_status: byStatus,
	                workstream_to_stream_id: workstreamToStreamId,
	                items,
	              };
                    } catch {
                      // Best-effort: scaffolding should not fail just because we can't
                      // snapshot streams for the response.
                    }
                  }

            let fallback_agent_dispatch:
              | {
                  attempted: boolean;
                  ok: boolean;
                  agent?: string;
                  message?: string;
                  error?: string;
                  tool_result?: unknown;
                }
              | undefined;

            // Fallback: if launch succeeded but didn't create/dispatch streams (or streams are
            // otherwise unavailable), spawn a single agent task so users immediately see
            // "agents do work after scaffold" even if the stream coordinator isn't firing.
            if (
              createdInitiativeId &&
              launchAfterCreate &&
              launch?.attempted &&
              launch.ok &&
              (streams?.total ?? 0) === 0
            ) {
              const workstreams = Array.isArray((hierarchy as any)?.workstreams)
                ? ((hierarchy as any).workstreams as Array<Record<string, unknown>>)
                : [];

              const firstWs = workstreams[0] ?? null;
              const wsLabel =
                firstWs &&
                (typeof firstWs.title === 'string'
                  ? firstWs.title
                  : typeof firstWs.name === 'string'
                  ? firstWs.name
                  : null);

              const wsHint =
                firstWs &&
                (typeof (firstWs as any).domain === 'string'
                  ? String((firstWs as any).domain)
                  : typeof (firstWs as any).persona === 'string'
                  ? String((firstWs as any).persona)
                  : wsLabel);
              const normalizedHint =
                typeof wsHint === 'string' ? wsHint.toLowerCase() : '';

              const assignedAgent =
                Array.isArray(agent_assignment?.assignments) &&
                agent_assignment.assignments.length > 0
                  ? agent_assignment.assignments[0]?.agent_id
                  : null;

              const agent =
                typeof assignedAgent === 'string' && assignedAgent.length > 0
                  ? assignedAgent
                  : normalizedHint.includes('engineering') ||
                normalizedHint.includes('build') ||
                normalizedHint.includes('dev')
                  ? 'engineering-agent'
                  : normalizedHint.includes('product')
                  ? 'product-agent'
                  : normalizedHint.includes('design') ||
                    normalizedHint.includes('brand')
                  ? 'design-agent'
                  : normalizedHint.includes('sales')
                  ? 'sales-agent'
                  : normalizedHint.includes('ops') ||
                    normalizedHint.includes('operation')
                  ? 'operations-agent'
                  : 'operations-agent';

              try {
                fallback_agent_dispatch = { attempted: true, ok: false, agent };
                const task = wsLabel
                  ? `Start work on the "${wsLabel}" workstream.`
                  : 'Start work on the first workstream in this initiative.';
                const toolExecResponse = await callOrgxApiJson(
                  this.env,
                  `/api/tools/execute`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      tool_id: 'spawn_agent_task',
                      user_id: ownerId ?? resolvedUserId ?? undefined,
                      args: {
                        agent,
                        task,
                        initiative_id: createdInitiativeId,
                        context:
                          'Auto-started after scaffold as a fallback path when stream dispatch is unavailable.',
                        wait_for_completion: false,
                      },
                    }),
                  },
                  { userId: ownerId ?? resolvedUserId ?? undefined }
                );
                const toolExecPayload = (await toolExecResponse.json()) as any;
                fallback_agent_dispatch = {
                  attempted: true,
                  ok: Boolean(toolExecPayload?.ok),
                  agent,
                  message:
                    typeof toolExecPayload?.data?.message === 'string'
                      ? toolExecPayload.data.message
                      : undefined,
                  tool_result: toolExecPayload,
                };
              } catch (error) {
                fallback_agent_dispatch = {
                  attempted: true,
                  ok: false,
                  agent,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }

			          const machinePayload = {
			            summary: result.summary,
			            live_url: liveUrl ?? undefined,
			            agent_assignment,
			            credential_status,
			            launch,
			            streams,
	                billing_usage: billingUsage ?? undefined,
	                scaffold_usage,
	                fallback_agent_dispatch,
			            hierarchy,
			            created: result.created,
			            failed: result.failed,
		            ref_map: result.ref_map,
	          };

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
		              ? `\n\n⚠️ Credentials required: ${launch.next_steps?.join('. ') ?? 'Configure AI provider keys at /settings/credentials'}`
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
		              : launch.needs_credentials
		                ? `\n\nLaunch: skipped (credentials required)${credentialWarning}${agentAssignmentSummary}`
		                : '\n\nLaunch: skipped (launch_after_create=false)'
		            : '';

              return {
                content: [
                  {
                    type: 'text',
                    text: `${result.summary}${
                      liveUrl ? `\n\n📺 Live view: ${liveUrl}` : ''
                    }${launchSummary}`,
                  },
                ],
                structuredContent: machinePayload,
              };
            } catch (error) {
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
          const maxChars = Math.max(
            1000,
            Math.min(args.max_chars ?? 20000, 50000)
          );

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
          const { hydrated, truncated, usedChars } = await hydrateTaskContext({
            context,
            fetchEntity,
            maxChars,
          });

          const payload = {
            task: taskRow,
            context,
            hydrated_context: hydrated,
            truncated,
            max_chars: maxChars,
            used_chars: usedChars,
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
          "Execute actions on multiple entities in one call (pause, launch, complete, resume, etc.). USE WHEN: bulk state changes like pausing multiple initiatives or completing multiple tasks. ACCEPTS: short ID prefixes (8+ chars) — no need to look up full UUIDs. NEXT: Verify all actions succeeded. DO NOT USE: for deletes — use batch_delete_entities instead.",
        inputSchema: {
          actions: z
            .array(
              z.object({
                type: lifecycleEntityTypeEnum.describe('Entity type'),
                id: z.string().min(1).describe('Entity ID (full UUID or short prefix 8+ hex chars)'),
                action: z.string().min(1).describe('Action to execute (pause, launch, complete, resume, etc.)'),
                note: z.string().optional().describe('Optional note/reason for this action'),
              })
            )
            .min(1)
            .max(100),
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
                const response = await callOrgxApiJson(
                  this.env,
                  `/api/entities/${target.type}/${target.id}/${target.action}`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      note: target.note,
                      reason: target.note,
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
                  action: target.action,
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
                  action: target.action,
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

          return {
            content: [{ type: 'text', text: summary }],
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
          // Skill-specific fields
          prompt_template: z
            .string()
            .optional()
            .describe('Updated template (for skills)'),
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
            ...safeUpdates
          } = updates as Record<string, unknown>;

          const payload: Record<string, unknown> = {
            type,
            id,
            ...safeUpdates,
          };

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
        inputSchema: {
          action: z.enum(['status', 'configure_agent', 'set_policy']).describe('Configuration operation'),
          agent_type: z.enum(['product', 'engineering', 'marketing', 'sales', 'operations', 'design', 'orchestrator']).optional().describe('Agent type (configure_agent only)'),
          trust_level: z.enum(['strict', 'balanced', 'autonomous']).optional().describe('Agent autonomy level (configure_agent only)'),
          focus_areas: z.array(z.string()).optional().describe('Agent focus areas (configure_agent only)'),
          approval_required: z.array(z.string()).optional().describe('Actions requiring approval (configure_agent only)'),
          skip_approval: z.array(z.string()).optional().describe('Actions without approval (configure_agent only)'),
          policy_type: z.enum(['approvals', 'notifications', 'working_hours', 'budget']).optional().describe('Policy type (set_policy only)'),
          config: z.record(z.any()).optional().describe('Policy configuration (set_policy only)'),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
          const resolvedUserId = this.props?.userId ?? this.sessionAuth?.userId;

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
                }
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
              const response = await callOrgxApiJson(
                this.env,
                '/api/setup/policies',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    policy_type: args.policy_type,
                    config: args.config,
                  }),
                }
              );
              await response.json();
              return {
                content: [{ type: 'text', text: `✓ Applied ${args.policy_type} policy` }],
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
        inputSchema: {
          scope: z.enum(['personal', 'session']).default('personal'),
          timeframe: z.enum(['today', 'week', 'month', 'all_time']).optional(),
        },
        _meta: { securitySchemes: SECURITY_SCHEMES.readOptionalAuth },
      },
      async (args) =>
        this.withOrgx(async () => {
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
            `/api/stats/me?${params.toString()}`
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
     * workspace - Consolidated workspace list, get, and set
     */
    if (shouldRegister('workspace'))
    this.server.registerTool(
      'workspace',
      {
        title: 'Workspace',
        description:
          'List, get, or set the active workspace. action=list to see all, action=get for current, action=set to switch.',
        inputSchema: {
          action: z.enum(['list', 'get', 'set']).describe('list=show all, get=current, set=switch active'),
          workspace_id: z.string().optional().describe('Workspace UUID to switch to (action=set only)'),
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
                '/api/entities?type=command_center&limit=50',
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
                    text: `📭 **No workspaces found**\n\nYou don't have any command centers set up yet. Create one to organize your initiatives and agents.`,
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
                      `then \`workspace action=set\` to select one.`,
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
                '/api/entities?type=command_center&limit=50',
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
          'ROI summary from the economic ledger. Returns cost/value/ROI by agent, capability, and time period.',
        inputSchema: {
          workspace_id: z.string().describe('Workspace ID'),
          period: z.enum(['7d', '30d', '90d']).default('30d'),
          agent_type: z.string().optional(),
          capability_key: z.string().optional(),
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

    // --- record_outcome ---
    if (shouldRegister('record_outcome'))
    this.server.registerTool(
      'record_outcome',
      {
        title: 'Record Outcome',
        description:
          'Record a business outcome. Triggers attribution inference to connect outcomes to receipts.',
        inputSchema: {
          workspace_id: z.string(),
          outcome_type_key: z.string(),
          outcome_value: z.number().optional(),
          source: z.enum(['manual', 'agent_self_report', 'crm_webhook', 'linear_sync']).default('manual'),
          source_id: z.string().optional(),
          occurred_at: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');
          const { workspace_id: _workspaceId, ...restArgs } = args;

          const response = await callOrgxApiJson(
            this.env,
            '/api/flywheel/outcomes',
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
            content: [{ type: 'text' as const, text: formatForLLM('record_outcome', result) }],
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
        inputSchema: {
          workspace_id: z.string(),
          agent_type: z.string(),
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

    // --- start_autonomous_session ---
    if (shouldRegister('start_autonomous_session'))
    this.server.registerTool(
      'start_autonomous_session',
      {
        title: 'Start Autonomous Session',
        description:
          'Start an autonomous execution session with budget guardrails. Creates a session that produces receipts while executing eligible work.',
        inputSchema: {
          workspace_id: z.string(),
          session_type: z.enum(['overnight', 'weekend', 'scheduled', 'manual']).default('manual'),
          max_cost_usd: z.number().positive().default(5.0),
          max_receipts: z.number().int().positive().default(50),
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');
          const { workspace_id: _workspaceId, ...restArgs } = args;

          const response = await callOrgxApiJson(
            this.env,
            '/api/flywheel/sessions',
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
            content: [{ type: 'text' as const, text: formatForLLM('start_autonomous_session', result) }],
            structuredContent: result,
          };
        })
    );

    // --- get_morning_brief ---
    if (shouldRegister('get_morning_brief'))
    this.server.registerTool(
      'get_morning_brief',
      {
        title: 'Get Morning Brief',
        description:
          'Curated receipts + exceptions + ROI delta from the most recent autonomous session. The brief IS curated receipts, not a separate data structure.',
        inputSchema: {
          workspace_id: z.string(),
          session_id: z.string().optional(),
        },
        _meta: {
          'openai/readOnlyHint': true,
          'ui/outputTemplate': WIDGET_URIS.morningBrief,
        },
      },
      async (args) =>
        this.withOrgx(async () => {
          const wsId = (args.workspace_id as string) ?? this.sessionContext?.workspaceId;
          if (!wsId) return this.toolError('workspace_id required');

          const response = await callOrgxApiJson(
            this.env,
            `/api/flywheel/briefs?workspace_id=${wsId}${args.session_id ? `&session_id=${args.session_id}` : ''}`,
            undefined,
            { userId: this.resolveUserId() }
          );
          const result = await response.json() as Record<string, unknown>;
          return {
            content: [{ type: 'text' as const, text: formatForLLM('get_morning_brief', result) }],
            structuredContent: result,
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
        inputSchema: {
          workspace_id: z.string(),
          capability_key: z.string().optional(),
          keywords: z.array(z.string()).optional(),
          limit: z.number().int().min(1).max(20).default(5),
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
        inputSchema: {
          workspace_id: z.string(),
          learning_type: z.enum(['failure_pattern', 'success_pattern', 'cost_optimization', 'quality_heuristic']),
          summary: z.string(),
          capability_key: z.string().optional(),
          evidence_receipt_ids: z.array(z.string()).optional(),
          keywords: z.array(z.string()).optional(),
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
          'Get your daily OrgX briefing - pending decisions, blocked work, agent status, and initiative health.',
        domain: 'operations',
        requiredTools: [
          'mcp__orgx__get_pending_decisions',
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
    const widgets = [
      {
        name: 'decisions-widget',
        uri: WIDGET_URIS.decisions,
        title: 'Pending Decisions Widget',
      },
      {
        name: 'agent-status-widget',
        uri: WIDGET_URIS.agentStatus,
        title: 'Agent Status Widget',
      },
      {
        name: 'search-results-widget',
        uri: WIDGET_URIS.searchResults,
        title: 'Search Results Widget',
      },
      {
        name: 'initiative-pulse-widget',
        uri: WIDGET_URIS.initiativePulse,
        title: 'Initiative Pulse Widget',
      },
      {
        name: 'task-spawned-widget',
        uri: WIDGET_URIS.taskSpawned,
        title: 'Task Spawned Widget',
      },
      {
        name: 'test-minimal-widget',
        uri: WIDGET_URIS.testMinimal,
        title: 'Minimal Test Widget (no external deps)',
      },
    ] as const;

    const widgetBaseUrl = resolveWidgetBaseUrl(this.env);
    const widgetMeta = buildWidgetMeta(this.env);
    const mcpAppsMeta = buildMcpAppsMeta(this.env);
    const contentMeta = { ...widgetMeta, ...mcpAppsMeta };

    for (const widget of widgets) {
      const widgetFile = widget.uri.replace('ui://widget/', '');
      const widgetPath = `/${widgetFile}`;
      const assetUrl = new URL(widgetFile, widgetBaseUrl).toString();

      registerAppResource(
        this.server,
        widget.name,
        widget.uri,
        {
          description: widget.title,
          _meta: contentMeta,
        },
          async () => {
            let assetStatus: number | null = null;
            let apiStatus: number | null = null;
            let source: 'assets' | 'api' | 'fallback' = 'assets';
            let assetFetchError: string | null = null;

            this.appendWidgetDebugEvent({
              phase: 'resource_read_start',
              resourceUri: widget.uri,
              mimeType: RESOURCE_MIME_TYPE,
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
                assetFetchError =
                  error instanceof Error ? error.message : String(error);
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

              const htmlWithBase = injectWidgetBase(html, widgetBaseUrl);
              const baseInjected = htmlWithBase !== html;

              this.appendWidgetDebugEvent({
                phase: 'resource_read_complete',
                resourceUri: widget.uri,
                mimeType: RESOURCE_MIME_TYPE,
                details: {
                  source,
                  assetStatus,
                  apiStatus,
                  assetFetchError,
                  baseInjected,
                  htmlBytes: htmlWithBase.length,
                },
              });

              // MCP Apps spec requires exactly 1 content item per resource.
              return {
                contents: [
                  {
                    uri: widget.uri,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: htmlWithBase,
                    _meta: contentMeta,
                  },
                ],
              };
            } catch (error) {
              source = 'fallback';
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              this.appendWidgetDebugEvent({
                phase: 'resource_read_error',
                resourceUri: widget.uri,
                mimeType: RESOURCE_MIME_TYPE,
                details: {
                  source,
                  assetStatus,
                  apiStatus,
                  assetFetchError,
                  error: errorMessage,
                },
              });

              // Fallback: Return a simple placeholder
              // UX: Use a ChatGPT-style skeleton first, then show a helpful error
              // if we still can't load (avoids an infinite "loading..." state).
              const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OrgX Widget</title>
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
      // If we hit this fallback, show a helpful message after a short delay.
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
                    uri: widget.uri,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: fallbackHtml,
                    _meta: contentMeta,
                  },
                ],
              };
            }
          }
        );
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
6) Call \`get_pending_decisions\` (limit=10) so the Decisions widget renders, then call \`approve_decision\` for the decision you just created.
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

/**
 * Expose httpHandler for use by authHandler.ts (WebSocket + root URL routing)
 */
export function getHttpHandler() {
  return httpHandler;
}

/**
 * Expose sseHandler for use by authHandler.ts (root URL SSE routing)
 */
export function getSseHandler() {
  return sseHandler;
}

// =============================================================================
// SSE POST→MCP REWRITE HANDLER
// OpenAI MCP client compatibility: POST /sse → /mcp
// =============================================================================

const sseWithPostRewrite = {
  async fetch(
    request: Request,
    env: any,
    ctx: ExecutionContext
  ): Promise<Response> {
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
      return httpHandler.fetch(httpReq, env, ctx);
    }

    // GET /sse → SSE transport (default behavior)
    const resp = await sseHandler.fetch(request, env, ctx);
    return withSseKeepAlive(resp);
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

export default new OAuthProvider({
  apiHandlers: {
    '/mcp': httpHandler,
    '/sse': sseWithPostRewrite,
  },
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 3600, // 1 hour
  refreshTokenTTL: 30 * 24 * 3600, // 30 days
  scopesSupported: [...OAUTH_SCOPES_SUPPORTED],
});
