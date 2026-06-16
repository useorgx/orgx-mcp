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
