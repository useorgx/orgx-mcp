/**
 * orgx_spawn per-action contract validation (A5).
 *
 * The orgx_spawn tool documents strict per-action required fields in its
 * description, but its inputSchema marks every field optional with no
 * superRefine — so a malformed call (e.g. action="handoff" with no task_id)
 * passes MCP validation and fails confusingly downstream. This enforces the
 * DOCUMENTED contract at the MCP layer: fail fast with a clear, actionable
 * message instead of a vague backend error.
 *
 * Pure and deterministic — it only rejects calls the contract already declares
 * invalid; every valid call passes unchanged.
 */

export interface SpawnContractResult {
  ok: boolean;
  message?: string;
}

function has(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeAgentAlias(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized.endsWith('-agent')) return normalized;
  const byDomain: Record<string, string> = {
    product: 'product-agent',
    engineering: 'engineering-agent',
    engineer: 'engineering-agent',
    marketing: 'marketing-agent',
    sales: 'sales-agent',
    operations: 'operations-agent',
    ops: 'operations-agent',
    design: 'design-agent',
    orchestrator: 'orchestrator-agent',
  };
  return byDomain[normalized] ?? raw;
}

function omitContractOnlyFields(
  args: Record<string, unknown>
): Record<string, unknown> {
  const {
    action: _action,
    title: _title,
    instructions: _instructions,
    agent_type: _agentType,
    domain: _domain,
    ...rest
  } = args;
  return rest;
}

/**
 * Translate the v2 orgx_spawn contract fields into the legacy app tool args
 * that /api/tools/execute expects. This keeps orgx_spawn ergonomic while
 * preserving task/workstream/initiative IDs for app-side GoalFrame hydration.
 */
export function buildOrgxSpawnForwardArgs(
  targetTool: 'spawn_agent_task' | 'handoff_task',
  args: Record<string, unknown>
): Record<string, unknown> {
  const out = omitContractOnlyFields(args);
  const agent =
    readString(out.agent) ??
    normalizeAgentAlias(args.agent_type) ??
    normalizeAgentAlias(args.domain);

  if (targetTool === 'handoff_task') {
    if (agent && !readString(out.agent)) out.agent = agent;
    const note = readString(out.note) ?? readString(args.instructions);
    if (note) out.note = note;
    return out;
  }

  if (agent && !readString(out.agent)) out.agent = agent;

  const title = readString(args.title);
  const instructions = readString(args.instructions);
  const taskId = readString(args.task_id);
  const task =
    readString(out.task) ??
    title ??
    instructions ??
    (taskId ? `Execute task ${taskId}` : null);
  if (task) out.task = task;

  const context = readString(out.context);
  if (!context && instructions && instructions !== task) {
    out.context = instructions;
  }

  return out;
}

export function validateSpawnContract(
  action: string,
  args: Record<string, unknown>
): SpawnContractResult {
  const a = action || 'spawn';
  switch (a) {
    case 'spawn':
      // spawn from an existing task needs task_id; ad-hoc spawn needs title + instructions.
      if (!has(args.task_id) && !(has(args.title) && has(args.instructions))) {
        return {
          ok: false,
          message:
            'orgx_spawn action="spawn" requires task_id (spawn for an existing task), or both title and instructions (ad-hoc spawn).',
        };
      }
      return { ok: true };
    case 'handoff':
      if (!has(args.task_id) || !has(args.agent_type)) {
        return {
          ok: false,
          message: 'orgx_spawn action="handoff" requires task_id and agent_type.',
        };
      }
      return { ok: true };
    case 'guard':
      if (!has(args.agent_type)) {
        return {
          ok: false,
          message: 'orgx_spawn action="guard" requires agent_type.',
        };
      }
      return { ok: true };
    case 'classify':
    case 'estimate':
      if (!has(args.title) && !has(args.task_id)) {
        return {
          ok: false,
          message: `orgx_spawn action="${a}" requires title or task_id.`,
        };
      }
      return { ok: true };
    default:
      // Unknown actions are handled by the existing routing/default path.
      return { ok: true };
  }
}
