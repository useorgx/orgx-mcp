export const MCP_SESSION_REENTRY_STORAGE_KEY = 'mcp_session_reentry_v1';
export const MCP_SESSION_REENTRY_GAP_MS = 90 * 60 * 1000;

export type McpSessionReentryState = {
  version: 1;
  last_success_at: string | null;
  last_welcome_back_at: string | null;
};

export type WelcomeBackDigest = {
  workspace_id: string | null;
  workspace_name: string | null;
  last_seen_at: string;
  live_url: string | null;
  stats: {
    active_initiatives: number;
    pending_decisions: number;
    running_agents: number;
  };
  recent_activity: Array<{
    title: string;
    timestamp: string;
    actor_name: string | null;
  }>;
  pending_decisions: Array<{
    title: string;
    waiting_for: string;
    priority: string | null;
  }>;
  next_actions: string[];
};

export function createEmptyMcpSessionReentryState(): McpSessionReentryState {
  return {
    version: 1,
    last_success_at: null,
    last_welcome_back_at: null,
  };
}

export function parseStoredMcpSessionReentryState(
  value: unknown
): McpSessionReentryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    version: 1,
    last_success_at:
      typeof record.last_success_at === 'string' ? record.last_success_at : null,
    last_welcome_back_at:
      typeof record.last_welcome_back_at === 'string'
        ? record.last_welcome_back_at
        : null,
  };
}

export function shouldShowWelcomeBack(params: {
  state: McpSessionReentryState | null | undefined;
  now?: string;
  gapMs?: number;
}): boolean {
  const state = params.state;
  if (!state?.last_success_at) return false;

  const gapMs = params.gapMs ?? MCP_SESSION_REENTRY_GAP_MS;
  const now = new Date(params.now ?? new Date().toISOString()).getTime();
  const lastSuccess = new Date(state.last_success_at).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(lastSuccess)) return false;
  if (now - lastSuccess < gapMs) return false;

  if (!state.last_welcome_back_at) return true;
  const lastWelcome = new Date(state.last_welcome_back_at).getTime();
  if (!Number.isFinite(lastWelcome)) return true;
  return lastWelcome < lastSuccess;
}

export function recordSuccessfulSessionTool(
  state: McpSessionReentryState | null | undefined,
  now?: string
): McpSessionReentryState {
  return {
    ...(state ?? createEmptyMcpSessionReentryState()),
    last_success_at: now ?? new Date().toISOString(),
  };
}

export function recordWelcomeBackShown(
  state: McpSessionReentryState | null | undefined,
  now?: string
): McpSessionReentryState {
  return {
    ...(state ?? createEmptyMcpSessionReentryState()),
    last_welcome_back_at: now ?? new Date().toISOString(),
  };
}

export function buildWelcomeBackNextActions(params: {
  pendingDecisionCount: number;
  recentActivityCount: number;
  hasWorkspace: boolean;
}): string[] {
  const actions: string[] = [];

  if (params.pendingDecisionCount > 0) {
    actions.push(
      `Review ${params.pendingDecisionCount} pending decision${
        params.pendingDecisionCount === 1 ? '' : 's'
      } first.`
    );
  }
  if (params.recentActivityCount > 0) {
    actions.push('Open the live workspace view and inspect recent changes.');
  }
  if (params.hasWorkspace) {
    actions.push(
      'Use recommend_next_action if you want a ranked next step for the current workspace.'
    );
  } else {
    actions.push('Run get_org_snapshot or list_workspaces to re-establish context.');
  }

  return actions.slice(0, 3);
}

export function formatWelcomeBackDigest(digest: WelcomeBackDigest): string {
  const lines: string[] = [
    `Welcome back.${digest.workspace_name ? ` ${digest.workspace_name} has changed since your last session.` : ' Here is what changed since your last session.'}`,
    '',
    `Active initiatives: ${digest.stats.active_initiatives}`,
    `Pending decisions: ${digest.stats.pending_decisions}`,
    `Running agents: ${digest.stats.running_agents}`,
  ];

  if (digest.recent_activity.length > 0) {
    lines.push('', 'Recent activity since you were last here:');
    for (const item of digest.recent_activity.slice(0, 3)) {
      lines.push(
        `- ${item.title}${item.actor_name ? ` (${item.actor_name})` : ''}`
      );
    }
  }

  if (digest.pending_decisions.length > 0) {
    lines.push('', 'Pending decisions:');
    for (const decision of digest.pending_decisions.slice(0, 3)) {
      lines.push(
        `- ${decision.title}${decision.priority ? ` [${decision.priority}]` : ''} — waiting ${decision.waiting_for}`
      );
    }
  }

  if (digest.next_actions.length > 0) {
    lines.push('', 'Suggested next actions:');
    for (const action of digest.next_actions) {
      lines.push(`- ${action}`);
    }
  }

  if (digest.live_url) {
    lines.push('', `Live view: ${digest.live_url}`);
  }

  return lines.join('\n');
}
