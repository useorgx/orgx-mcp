/**
 * Client session identity — the conversation link ambient work was missing.
 *
 * `_context` is a transport parameter, so the client-integration path strips it
 * before forwarding a tool call to the OrgX API. That strip is correct for the
 * parameter as a whole, but `_context.conversation.id` is the ONLY carrier of
 * the client conversation the work happened in — dropping it is why every
 * ambient emission was recorded "without a linked conversation session".
 *
 * This module lifts that identity into a small, explicitly-shaped `session`
 * field the reporting endpoints accept (optional and additive: a server that
 * predates the field ignores unknown keys, since the reporting request schemas
 * are non-strict zod objects). The same identity is mirrored into `metadata`
 * so it survives even against a server deployment that has not shipped the
 * typed field yet — `metadata` is already free-form on those endpoints.
 *
 * Pure and deterministic: no IO, no worker state.
 */

/**
 * Wire shape of the optional `session` field on reporting requests. Mirrors
 * `reportingSessionContextSchema` in the OrgX repo exactly — every bound below
 * is that schema's bound, because a value that overruns one (or an
 * `orgx_session_id` that is not a uuid) fails validation for the WHOLE call,
 * not just the field.
 */
export type ClientSessionIdentity = {
  /** Client conversation id, or the MCP session id when the client sent none. */
  conversation_id: string;
  /** A previously-returned OrgX conversation_sessions.id — uuid or omitted. */
  orgx_session_id?: string;
  /** How the client names itself. */
  client_name?: string;
  /** Human-readable conversation title, when the client knows one. */
  title?: string;
};

/**
 * Everything else we know about the session. Deliberately NOT part of the
 * typed `session` field — it rides in the metadata mirror so widening the
 * server contract is never a prerequisite for keeping the detail.
 */
export type ClientSessionIdentityDetail = {
  conversation_id_source: 'client_context' | 'mcp_session';
  mcp_session_id?: string;
  conversation_started_at?: string;
  client_version?: string;
  client_platform?: string;
  unverified_orgx_session_id?: string;
};

export type ResolvedClientSessionIdentity = {
  session: ClientSessionIdentity;
  detail: ClientSessionIdentityDetail;
};

/**
 * Reporting tools whose request schema carries the optional `session` field.
 * `session` lives on the shared `runContextBaseSchema`, so every tool listed
 * here was verified to derive from it (plus the execution-graph event schema,
 * which declares it directly). Widening this set requires re-checking that the
 * destination schema really does extend that base.
 */
export const CLIENT_SESSION_IDENTITY_TOOL_IDS = new Set([
  'orgx_emit_activity',
  'orgx_emit_execution_graph',
  'orgx_apply_changeset',
  'orgx_request_question',
]);

/** Bounds copied from reportingSessionContextSchema. */
const MAX_CONVERSATION_ID_LENGTH = 255;
const MAX_CLIENT_NAME_LENGTH = 60;
const MAX_TITLE_LENGTH = 300;
/** Detail-mirror strings are free-form; bound them anyway. */
const MAX_DETAIL_LENGTH = 300;

/** `orgx_session_id` is uuid-typed server-side: send it only when it is one. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Build the session identity for one tool call.
 *
 * `conversation_id` prefers the client's own conversation id. When the agent
 * sent no `_context` (the common case — it is optional and most agents omit
 * it), the MCP session id stands in: for streamable-HTTP MCP one session is
 * one conversation, and a stable id the server can group by is strictly better
 * than none. `conversation_id_source` records which of the two it was, so no
 * consumer has to guess whether the client actually declared it.
 *
 * Returns null when there is no usable identity at all.
 */
export function buildClientSessionIdentity(params: {
  context?: unknown;
  clientName?: string | null;
  clientVersion?: string | null;
  mcpSessionId?: string | null;
}): ResolvedClientSessionIdentity | null {
  const context = asRecord(params.context);
  const client = asRecord(context.client);
  const conversation = asRecord(context.conversation);
  const session = asRecord(context.session);

  const contextConversationId = readString(
    conversation.id,
    MAX_CONVERSATION_ID_LENGTH
  );
  const mcpSessionId = readString(
    params.mcpSessionId,
    MAX_CONVERSATION_ID_LENGTH
  );
  const conversationId = contextConversationId ?? mcpSessionId;
  if (!conversationId) return null;

  const clientName =
    readString(params.clientName, MAX_CLIENT_NAME_LENGTH) ??
    readString(client.name, MAX_CLIENT_NAME_LENGTH);
  const clientVersion =
    readString(params.clientVersion, MAX_DETAIL_LENGTH) ??
    readString(client.version, MAX_DETAIL_LENGTH);
  const title = readString(conversation.title, MAX_TITLE_LENGTH);
  const startedAt = readString(conversation.startedAt, MAX_DETAIL_LENGTH);
  const platform = readString(client.platform, MAX_DETAIL_LENGTH);
  // Non-uuid values are dropped rather than sent: the field is uuid-typed and
  // a bad one fails validation for the entire emission.
  const rawOrgxSessionId = readString(
    session.orgxSessionId,
    MAX_CONVERSATION_ID_LENGTH
  );
  const orgxSessionId =
    rawOrgxSessionId && UUID_RE.test(rawOrgxSessionId)
      ? rawOrgxSessionId
      : undefined;

  return {
    session: {
      conversation_id: conversationId,
      ...(orgxSessionId ? { orgx_session_id: orgxSessionId } : {}),
      ...(clientName ? { client_name: clientName } : {}),
      ...(title ? { title } : {}),
    },
    detail: {
      conversation_id_source: contextConversationId
        ? 'client_context'
        : 'mcp_session',
      ...(mcpSessionId ? { mcp_session_id: mcpSessionId } : {}),
      ...(startedAt ? { conversation_started_at: startedAt } : {}),
      ...(clientVersion ? { client_version: clientVersion } : {}),
      ...(platform ? { client_platform: platform } : {}),
      // Kept verbatim when the agent sent a non-uuid orgx session id, so the
      // value is still recoverable even though it cannot ride the typed field.
      ...(rawOrgxSessionId && !orgxSessionId
        ? { unverified_orgx_session_id: rawOrgxSessionId }
        : {}),
    },
  };
}

/**
 * Attach the session identity to an outbound reporting body.
 *
 * Strictly additive and non-destructive:
 *  - an explicit agent-supplied `session` is never overwritten;
 *  - `metadata` is merged, never replaced, and an existing `metadata.session`
 *    wins over the derived one.
 */
export function withClientSessionIdentity(
  body: Record<string, unknown>,
  identity: ResolvedClientSessionIdentity | null
): Record<string, unknown> {
  if (!identity) return body;

  const next: Record<string, unknown> = { ...body };

  if (
    !next.session ||
    typeof next.session !== 'object' ||
    Array.isArray(next.session)
  ) {
    next.session = identity.session;
  }

  const metadata = asRecord(next.metadata);
  if (
    !metadata.session ||
    typeof metadata.session !== 'object' ||
    Array.isArray(metadata.session)
  ) {
    next.metadata = {
      ...metadata,
      session: { ...identity.session, ...identity.detail },
    };
  }

  return next;
}
