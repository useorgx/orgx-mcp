import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type TextContent = Extract<CallToolResult['content'][number], { type: 'text' }>;

export type PayloadNormalizationWarning = {
  path: string;
  from: string;
  to: string;
  reason: string;
};

export type FailureDiagnostic = {
  code: string;
  reason: string;
  safe_to_retry: boolean;
  corrected_payload?: Record<string, unknown>;
  valid_values?: readonly string[];
  suggested_next_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
  security_note?: string;
};

function compactString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function pickString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = compactString(record[key]);
    if (value) return value;
  }
  return null;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\boxk[-_][A-Za-z0-9._-]{8,}\b/g, 'oxk_...redacted')
    .replace(/\bgh[oprsu]_[A-Za-z0-9_]{8,}\b/g, 'gh_...redacted')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ...redacted')
    .replace(/"authorization"\s*:\s*"[^"]+"/gi, '"authorization":"...redacted"')
    .replace(/authorization:\s*[^,\s]+/gi, 'authorization: ...redacted')
    .replace(/column\s+"[^"]+"\s+does not exist/gi, 'backend compatibility field is unavailable')
    .replace(/relation\s+"[^"]+"\s+does not exist/gi, 'backend data path is unavailable')
    .replace(/table\s+"[^"]+"\s+does not exist/gi, 'backend data path is unavailable');
}

export function buildJsonFirstContentBlocks(params: {
  data: Record<string, unknown>;
  summary: string;
  widgetHtml?: string | null;
}): TextContent[] {
  const blocks: TextContent[] = [
    { type: 'text', text: JSON.stringify(params.data) },
    { type: 'text', text: params.summary },
  ];
  if (params.widgetHtml) {
    blocks.push({ type: 'text', text: params.widgetHtml });
  }
  return blocks;
}

export function buildClientAwareContentBlocks(params: {
  data: Record<string, unknown>;
  summary: string;
  sourceClient?: string | null;
  widgetHtml?: string | null;
}): TextContent[] {
  const sourceClient = params.sourceClient?.trim().toLowerCase() ?? '';
  if (sourceClient === 'claude' || sourceClient === 'claude-code') {
    return [{ type: 'text', text: params.summary }];
  }
  return buildJsonFirstContentBlocks(params);
}

export function normalizeEntityCreatePayloadForAgents(
  entity: Record<string, unknown>,
  pathPrefix: string
): { entity: Record<string, unknown>; warnings: PayloadNormalizationWarning[] } {
  const next: Record<string, unknown> = { ...entity };
  const warnings: PayloadNormalizationWarning[] = [];
  const type = compactString(next.type);

  const rewrite = (
    key: string,
    from: string,
    to: string,
    reason: string
  ) => {
    if (next[key] !== from) return;
    next[key] = to;
    warnings.push({ path: `${pathPrefix}.${key}`, from, to, reason });
  };

  if (type === 'task') {
    rewrite('priority', 'urgent', 'high', 'OrgX task priority accepts low|medium|high; high is the urgent-equivalent.');
    rewrite('status', 'active', 'in_progress', 'OrgX task status uses in_progress for active execution.');
  }

  if (type === 'milestone') {
    rewrite('status', 'active', 'in_progress', 'OrgX milestone status uses in_progress, not active.');
  }

  if (type === 'decision') {
    rewrite('status', 'active', 'pending', 'OrgX decision status uses pending for unresolved decisions.');
  }

  if (type === 'blocker') {
    rewrite('status', 'active', 'open', 'OrgX blocker status uses open for active blockers.');
  }

  if (type === 'artifact') {
    rewrite('status', 'active', 'draft', 'OrgX artifact status uses draft for newly attached artifacts.');
  }

  return { entity: next, warnings };
}

export function normalizeRecordQualityScoreArgs(
  args: Record<string, unknown>
): { body: Record<string, unknown>; error?: FailureDiagnostic } {
  const taskId = pickString(args, ['taskId', 'task_id']);
  const agentDomain = pickString(args, [
    'agentDomain',
    'agent_domain',
    'domain',
  ]);
  const scoredBy = pickString(args, ['scoredBy', 'scored_by']);
  const score = typeof args.score === 'number' ? args.score : undefined;
  const notes = typeof args.notes === 'string' ? args.notes : undefined;

  const corrected: Record<string, unknown> = {};
  if (taskId) corrected.taskId = taskId;
  if (agentDomain) corrected.agentDomain = agentDomain;
  if (score !== undefined) corrected.score = score;
  if (scoredBy) corrected.scoredBy = scoredBy;
  if (notes) corrected.notes = notes;

  if (!taskId || !agentDomain || score === undefined) {
    return {
      body: corrected,
      error: {
        code: 'invalid_quality_score_payload',
        reason:
          'record_quality_score needs task and domain identifiers. The MCP tool accepts snake_case and camelCase aliases, then forwards the backend camelCase contract.',
        safe_to_retry: true,
        corrected_payload: corrected,
        suggested_next_calls: [{ tool: 'orgx_describe_tool', args: { tool_id: 'record_quality_score' } }],
      },
    };
  }

  return { body: corrected };
}

export function normalizeRecordOutcomeArgs(
  args: Record<string, unknown>,
  fallbackWorkspaceId?: string | null
): { body: Record<string, unknown>; workspaceId: string | null } {
  const workspaceId =
    pickString(args, ['workspace_id', 'workspaceId']) ?? fallbackWorkspaceId ?? null;
  const body: Record<string, unknown> = {
    outcome_type_key:
      pickString(args, ['outcome_type_key', 'outcomeTypeKey']) ??
      args.outcome_type_key,
    outcome_value:
      typeof args.outcome_value === 'number'
        ? args.outcome_value
        : typeof args.outcomeValue === 'number'
        ? args.outcomeValue
        : undefined,
    source: args.source ?? 'manual',
    source_id: pickString(args, ['source_id', 'sourceId']) ?? undefined,
    occurred_at: pickString(args, ['occurred_at', 'occurredAt']) ?? undefined,
    metadata: args.metadata,
  };
  if (workspaceId) body.workspace_id = workspaceId;
  return { body, workspaceId };
}

export function diagnoseToolFailure(params: {
  toolId: string;
  error: unknown;
  args?: Record<string, unknown>;
}): FailureDiagnostic {
  const message = redactSensitiveText(
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === 'string'
      ? params.error
      : String(params.error)
  );
  const lower = message.toLowerCase();

  if (params.toolId === 'record_quality_score' || /taskid is required|agentdomain is required/.test(lower)) {
    const normalized = normalizeRecordQualityScoreArgs(params.args ?? {});
    return {
      code: 'quality_score_contract_alias',
      reason:
        'Quality scoring uses the backend camelCase contract. The MCP layer accepts aliases and should retry with taskId, agentDomain, score, scoredBy, and notes.',
      safe_to_retry: true,
      corrected_payload: normalized.body,
      suggested_next_calls: [{ tool: 'orgx_describe_tool', args: { tool_id: 'record_quality_score' } }],
      security_note: 'Diagnostic output redacts tokens and service keys.',
    };
  }

  if (/unknown outcome type/.test(lower)) {
    return {
      code: 'unknown_outcome_type',
      reason:
        'The workspace outcome taxonomy does not contain the requested outcome_type_key yet. Capture the outcome as artifact metadata until that taxonomy is configured.',
      safe_to_retry: false,
      corrected_payload: params.args,
      suggested_next_calls: [{ tool: 'orgx_describe_tool', args: { tool_id: 'record_outcome' } }],
    };
  }

  if (
    /command_center_id.*does not exist|column .*command_center_id|backend compatibility field is unavailable/.test(
      lower
    )
  ) {
    return {
      code: 'backend_changeset_compatibility',
      reason:
        'A backend compatibility path rejected the transactional changeset before apply. Use workspace_id on new payloads and fall back to entity_action/update paths when transactional changesets fail.',
      safe_to_retry: false,
      suggested_next_calls: [{ tool: 'entity_action', args: { action: 'update' } }],
    };
  }

  if (/no_quality_gate|proof-chain blocker/.test(lower)) {
    return {
      code: 'missing_completion_proof',
      reason:
        'The entity is otherwise ready but lacks proof metadata strong enough for completion.',
      safe_to_retry: true,
      suggested_next_calls: [
        {
          tool: 'entity_action',
          args: {
            action: 'complete_with_proof',
            quality_score: 5,
            schema_validated: true,
          },
        },
      ],
    };
  }

  if (/invalid priority.*urgent|valid values: low, medium, high/.test(lower)) {
    return {
      code: 'invalid_priority_alias',
      reason: 'Use high for urgent task work.',
      safe_to_retry: true,
      valid_values: ['low', 'medium', 'high'],
      corrected_payload: { ...(params.args ?? {}), priority: 'high' },
    };
  }

  if (/invalid status.*active|planned, in_progress, completed, at_risk, cancelled/.test(lower)) {
    return {
      code: 'invalid_status_alias',
      reason: 'Use in_progress for active milestone work.',
      safe_to_retry: true,
      valid_values: ['planned', 'in_progress', 'completed', 'at_risk', 'cancelled'],
      corrected_payload: { ...(params.args ?? {}), status: 'in_progress' },
    };
  }

  if (/no approval received|approval/i.test(message)) {
    return {
      code: 'approval_required_or_missing',
      reason:
        'The requested write appears to require an approval record or explicit user confirmation before execution.',
      safe_to_retry: false,
      suggested_next_calls: [{ tool: 'approve_agent_work', args: { action: 'list' } }],
    };
  }

  return {
    code: 'tool_execution_failed',
    reason: message || 'Tool execution failed.',
    safe_to_retry: /timeout|temporarily|try again/i.test(message),
    security_note: 'Diagnostic output is sanitized and does not expose service keys, auth headers, or secrets.',
  };
}

export function buildFailureDetails(params: {
  toolId: string;
  error: unknown;
  args?: Record<string, unknown>;
}): Record<string, unknown> {
  const diagnostic = diagnoseToolFailure(params);
  return {
    diagnostic,
    retryable: diagnostic.safe_to_retry,
    suggested_next_calls: diagnostic.suggested_next_calls,
    corrected_payload: diagnostic.corrected_payload,
  };
}
