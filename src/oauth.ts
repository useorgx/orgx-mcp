/**
 * OAuth State Durable Object — Legacy
 *
 * Kept for wrangler migration compatibility (tag "v2" references OAuthState).
 * The OAuthProvider from @cloudflare/workers-oauth-provider now handles all
 * OAuth flows, token management, and client registration via KV storage.
 *
 * This DO is no longer actively used. It can be removed in a future migration
 * once the "v2" migration tag is superseded.
 */

import { DurableObject } from 'cloudflare:workers';

// =============================================================================
// TYPES (simplified — only what's needed for the DO class and Env interface)
// =============================================================================

export interface OAuthEnv {
  ORGX_API_URL: string;
  ORGX_WEB_URL: string;
  ORGX_SERVICE_KEY: string;
  MCP_JWT_SECRET: string;
  MCP_SERVER_URL: string;
  AUTH_SERVER_URL: string;
  OAUTH_STATE: DurableObjectNamespace;
}

// =============================================================================
// OAUTH STATE DURABLE OBJECT (kept for migration tag "v2")
// =============================================================================

export class OAuthState extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: OAuthEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Initialize schema (idempotent — safe to keep for existing DOs)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT NOT NULL,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        grant_types TEXT NOT NULL,
        response_types TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorization_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_email TEXT,
        scope TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_email TEXT,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS oauth_state_params (
        state_key TEXT PRIMARY KEY,
        state_data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    // Legacy DO — no longer accepts requests
    return Response.json(
      {
        error: 'deprecated',
        message:
          'OAuthState DO is deprecated. OAuth is now handled by OAuthProvider.',
      },
      { status: 410 }
    );
  }
}
