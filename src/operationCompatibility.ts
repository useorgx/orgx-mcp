import { z } from 'zod';
import { getWorkflowToolContract } from './workflowTools';
import { resolveProfileToolSet } from './toolProfiles';

/** Only aliases with the same handler and response shape can run automatically. */
export const OPERATION_COMPATIBILITY_ALIASES = {
  get_agent_status: 'orgx_get_agent_status',
  get_initiative_pulse: 'orgx_get_initiative_progress',
  get_operator_chronicle: 'orgx_get_operator_brief',
  check_execution_readiness: 'orgx_check_execution_readiness',
  orgx_command_status: 'orgx_get_operation_status',
  get_pending_decisions: 'orgx_list_pending_decisions',
} as const;

export function resolveOperationCompatibilityCall(toolId: string, args: Record<string, unknown>, profile: string, selectedToolIds?: readonly string[] | null) {
  const selected = resolveProfileToolSet(profile);
  const visible = selectedToolIds == null ? selected
    : new Set(selectedToolIds.filter((id) => selected === null || selected.has(id)));
  if (!visible || visible.has(toolId)) return null;
  let target: string | undefined = OPERATION_COMPATIBILITY_ALIASES[toolId as keyof typeof OPERATION_COMPATIBILITY_ALIASES];
  let projected = { ...args };
  if (toolId === 'orgx_decide' && args.action === 'list_pending') {
    target = 'orgx_list_pending_decisions';
    delete projected.action;
  } else if (toolId === 'approve_agent_work' && args.action === 'list') {
    target = 'orgx_list_pending_decisions';
    delete projected.action;

  }
  if (!target || !visible.has(target)) return null;
  const contract = getWorkflowToolContract(target);
  if (!contract) return null;
  // Refuse unsupported legacy fields rather than discarding user material.
  const parsed = z.object({ ...contract.inputSchema, _context: z.unknown().optional() }).strict().safeParse(projected);
  if (!parsed.success) return null;
  return { toolId: target, args: parsed.data, sourceToolId: toolId };
}
