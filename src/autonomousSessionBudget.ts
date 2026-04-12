import { z } from 'zod';

export const AUTONOMOUS_SESSION_TRUST_LEVELS = [
  'autonomous',
  'act_with_approval',
  'draft',
  'read_only',
] as const;

export type AutonomousSessionTrustLevel =
  (typeof AUTONOMOUS_SESSION_TRUST_LEVELS)[number];

export const AUTONOMOUS_SESSION_BUDGET_LIMITS = {
  defaultMaxCostUsd: 5,
  absoluteMaxCostUsd: 5,
  defaultMaxReceipts: 50,
  absoluteMaxReceipts: 50,
  defaultAllowedTrustLevels: [
    'autonomous',
    'act_with_approval',
  ] as AutonomousSessionTrustLevel[],
} as const;

const trustLevelSchema = z.enum(AUTONOMOUS_SESSION_TRUST_LEVELS);

export const autonomousSessionInputSchema = z.object({
  workspace_id: z.string().describe('Workspace ID.'),
  session_type: z
    .enum(['overnight', 'weekend', 'scheduled', 'manual'])
    .default('manual')
    .describe('Autonomy session mode to start.'),
  max_cost_usd: z
    .number()
    .positive()
    .max(AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxCostUsd)
    .default(AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultMaxCostUsd)
    .describe('Maximum budget in USD before the session stops.'),
  max_receipts: z
    .number()
    .int()
    .positive()
    .max(AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxReceipts)
    .default(AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultMaxReceipts)
    .describe('Maximum number of receipts the session may produce.'),
  allowed_trust_levels: z
    .array(trustLevelSchema)
    .min(1)
    .default(AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultAllowedTrustLevels)
    .describe('Only execute capabilities at these trust levels.'),
});

export const autonomousSessionInputShape =
  autonomousSessionInputSchema.shape;

export type AutonomousSessionInput = z.input<
  typeof autonomousSessionInputSchema
>;
export type AutonomousSessionPayload = z.output<
  typeof autonomousSessionInputSchema
>;

export type AutonomousSessionValidationError = {
  code: 'budget_cap_exceeded' | 'invalid_autonomous_session_budget';
  status: 400;
  message: string;
  details: z.ZodIssue[];
};

export type AutonomousSessionValidationResult =
  | { ok: true; payload: AutonomousSessionPayload }
  | { ok: false; error: AutonomousSessionValidationError };

function isBudgetCapIssue(issue: z.ZodIssue): boolean {
  const field = issue.path[0];
  return (
    issue.code === z.ZodIssueCode.too_big &&
    (field === 'max_cost_usd' || field === 'max_receipts')
  );
}

export function normalizeAutonomousSessionArgs(
  args: unknown
): AutonomousSessionValidationResult {
  const parsed = autonomousSessionInputSchema.safeParse(args);
  if (parsed.success) {
    return {
      ok: true,
      payload: {
        ...parsed.data,
        allowed_trust_levels: [...new Set(parsed.data.allowed_trust_levels)],
      },
    };
  }

  const exceededCap = parsed.error.issues.some(isBudgetCapIssue);
  const cap = AUTONOMOUS_SESSION_BUDGET_LIMITS;
  return {
    ok: false,
    error: {
      code: exceededCap
        ? 'budget_cap_exceeded'
        : 'invalid_autonomous_session_budget',
      status: 400,
      message: exceededCap
        ? `Autonomous session budget exceeds MCP safety caps: max_cost_usd must be <= ${cap.absoluteMaxCostUsd} and max_receipts must be <= ${cap.absoluteMaxReceipts}.`
        : 'Autonomous session budget settings are invalid.',
      details: parsed.error.issues,
    },
  };
}
