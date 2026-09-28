/**
 * The single dispatch contract shared by every verb that starts agent work.
 *
 * orgx_spawn, delegate_agent_task, spawn_agent_task and handoff_task all reach
 * the same backend, but each one advertised a different subset of the contract:
 * orgx_spawn had budget and idempotency but no deadline, delegate_agent_task
 * had a free-text deadline and no budget, handoff_task had neither. A managing
 * agent could not get budget and deadline from any single verb, and none of
 * them could say what would count as done.
 *
 * This module is the one definition. The verbs stay — a live MCP surface with
 * ChatGPT and Claude clients is not worth breaking — they stop disagreeing.
 *
 * The acceptance half encodes a rule the work ledger paid for on 2026-09-27:
 * arm B of the autonomy experiment reported criteria_met=true because its
 * checks were written after the work and used `|| echo`, which always exits 0.
 * A check counts here only if it was declared before the work and was observed
 * to fail on the pre-state. That rule lived in a skill doc; prose is not a
 * constraint, so it lives in the contract now.
 *
 * This module normalizes and fixes the contract; it does not judge it. The
 * verdict lives in the app (orgx/lib/server/acceptance/dispatchAcceptance.ts),
 * which has the run, its artifacts and the pre-state probes, and which shares
 * one discrimination rule with the initiative criteria gate.
 *
 * Pure and deterministic apart from hashAcceptanceContract, which uses
 * crypto.subtle. Normalization never throws: it returns diagnostics the caller
 * turns into a refusal.
 */

import { z } from 'zod';

// =============================================================================
// FIELD SCHEMAS — imported by every dispatch tool definition
// =============================================================================

export const ACCEPTANCE_VERIFY_KINDS = [
  'command',
  'http',
  'artifact',
  'manual',
] as const;

export type AcceptanceVerifyKind = (typeof ACCEPTANCE_VERIFY_KINDS)[number];

export const acceptanceCheckSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'Stable identifier for this check, referenced by the receipt. Reuse it across retries so the verdict stays comparable.'
    ),
  statement: z
    .string()
    .min(1)
    .max(500)
    .describe('What must become true. One falsifiable sentence.'),
  verify: z
    .record(z.unknown())
    .describe(
      'How the check is evaluated. One of: { kind: "command", command, expect_exit } | { kind: "http", url, expect_status } | { kind: "artifact", artifact_type } | { kind: "manual", reviewer }.'
    ),
  must_fail_before: z
    .boolean()
    .optional()
    .describe(
      'Default true. A check that already passes before the work starts is non-discriminating and is excluded from the acceptance verdict.'
    ),
});

/**
 * The effect names a run can declare. The app is the authority — it refuses
 * an unknown name at spawn and enforces the scope
 * (orgx/lib/agents/tools/effects.ts); this copy exists so the schema an agent
 * reads names the real vocabulary instead of examples it would be refused for.
 * A drift test in the app repo compares the two.
 */
export const DISPATCH_EFFECT_NAMES = [
  'email.send',
  'message.send',
  'crm.write',
  'campaign.schedule',
  'document.write',
  'issue.write',
  'calendar.write',
  'computer.use',
  'repo.sync',
  'ci.trigger',
  'repo.push',
  'pull_request.create',
  'merge',
  'deploy',
  'package.publish',
] as const;

export const dispatchEffectsSchema = z.object({
  allowed: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Effects the work may perform without further approval. One of: ${DISPATCH_EFFECT_NAMES.join(', ')}. Internal work (editing files, running tests) is not an effect and needs no declaration.`
    ),
  approval_required: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Effects that must wait for a person to approve them, per run. Same names as allowed. An unknown name is refused, so a typo cannot silently gate nothing.`
    ),
});

/**
 * The field group every dispatch verb declares. Spread into an inputSchema so
 * the four surfaces cannot drift apart again.
 */
export const DISPATCH_CONTRACT_SHAPE = {
  deadline: z
    .string()
    .optional()
    .describe(
      'Optional ISO-8601 instant by which the work must finish (e.g. "2026-09-28T17:00:00Z"). Validated and recorded; free text is rejected because a constraint that cannot be evaluated is not a constraint.'
    ),
  max_cost_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Optional hard cost ceiling in USD for this dispatch. If the estimate exceeds it, OrgX blocks, downgrades, or requests approval before dispatch.'
    ),
  budget_mode: z
    .enum(['cheapest_valid', 'balanced', 'highest_quality'])
    .optional()
    .describe(
      'Optional budget posture. Use cheapest_valid for controlled validation runs while reliability is being proven.'
    ),
  max_parallel: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe(
      'Optional cap on concurrent workers for this dispatch. Work that shares a repository is usually integration-bound well below this: more workers add merge contention, not throughput.'
    ),
  expected_artifacts: z
    .array(z.string())
    .optional()
    .describe(
      'Optional expected final-output labels. Declaring at least one adds an artifact contract to the run.'
    ),
  effects: dispatchEffectsSchema
    .optional()
    .describe(
      'Optional declared effect scope for the work. Recorded on the run and shown in the receipt. Declaring an effect never grants it — the platform intersects it with the caller authority.'
    ),
  acceptance: z
    .array(acceptanceCheckSchema)
    .max(20)
    .optional()
    .describe(
      'Optional acceptance checks that define what counts as done. Declared BEFORE the work and hashed at dispatch. A check that already passes on the pre-state is reported as non-discriminating and excluded from the verdict.'
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      'Optional client-supplied idempotency key for safe retries. The same key returns the same dispatch result without re-running the work.'
    ),
} as const;

// =============================================================================
// NORMALIZED SHAPES
// =============================================================================

export type AcceptancePreState = 'fail' | 'pass' | 'unprobed';

export interface NormalizedAcceptanceCheck {
  id: string;
  statement: string;
  verify: Record<string, unknown>;
  must_fail_before: boolean;
}

export interface NormalizedDispatchContract {
  deadline: string | null;
  max_cost_usd: number | null;
  budget_mode: string | null;
  max_parallel: number | null;
  expected_artifacts: string[];
  effects: { allowed: string[]; approval_required: string[] } | null;
  acceptance: NormalizedAcceptanceCheck[];
  idempotency_key: string | null;
}

export interface DispatchContractResult {
  ok: boolean;
  /** Present when ok. */
  contract?: NormalizedDispatchContract;
  /** One actionable sentence naming the field and the fix. */
  message?: string;
  code?: string;
}

/** What is persisted at dispatch so "declared before the work" is provable. */
export interface AcceptanceBinding {
  contract_hash: string;
  declared_at: string;
  checks: Array<{
    id: string;
    statement: string;
    verify: Record<string, unknown>;
    must_fail_before: boolean;
    pre_state: AcceptancePreState;
  }>;
}

// =============================================================================
// HELPERS
// =============================================================================

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

/**
 * ISO-8601 instants only. `new Date("next Tuesday")` is NaN and
 * `new Date("2026")` silently parses to a January instant, so the string must
 * look like a full timestamp before it is parsed at all.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

export function normalizeDeadline(
  value: unknown,
  now: Date = new Date()
): { ok: true; value: string | null } | { ok: false; message: string } {
  const raw = readString(value);
  if (!raw) return { ok: true, value: null };

  if (!ISO_INSTANT.test(raw)) {
    return {
      ok: false,
      message: `deadline must be an ISO-8601 instant with a timezone (e.g. "2026-09-28T17:00:00Z"), received ${JSON.stringify(
        raw
      )}. Free-text deadlines cannot be evaluated, so they are not accepted.`,
    };
  }

  const parsed = new Date(raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message: `deadline ${JSON.stringify(raw)} is not a valid instant.`,
    };
  }
  if (parsed.getTime() <= now.getTime()) {
    return {
      ok: false,
      message: `deadline ${parsed.toISOString()} is in the past. Dispatch a deadline the work can still meet, or omit it.`,
    };
  }
  return { ok: true, value: parsed.toISOString() };
}

/**
 * A verify block must be evaluable. The shapes below are the ones the verifier
 * understands; anything else is rejected at dispatch rather than discovered at
 * completion, when the work has already been paid for.
 */
export function normalizeVerify(
  checkId: string,
  value: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      message: `acceptance check "${checkId}" needs a verify object describing how it is evaluated.`,
    };
  }
  const raw = value as Record<string, unknown>;
  const kind = readString(raw.kind);
  if (!kind || !(ACCEPTANCE_VERIFY_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      message: `acceptance check "${checkId}" has verify.kind ${JSON.stringify(
        raw.kind ?? null
      )}; expected one of ${ACCEPTANCE_VERIFY_KINDS.join(', ')}.`,
    };
  }

  switch (kind as AcceptanceVerifyKind) {
    case 'command': {
      const command = readString(raw.command);
      if (!command) {
        return {
          ok: false,
          message: `acceptance check "${checkId}" with verify.kind="command" needs a command string.`,
        };
      }
      const expectExit =
        typeof raw.expect_exit === 'number' && Number.isInteger(raw.expect_exit)
          ? raw.expect_exit
          : 0;
      return { ok: true, value: { kind, command, expect_exit: expectExit } };
    }
    case 'http': {
      const url = readString(raw.url);
      if (!url || !/^https?:\/\//i.test(url)) {
        return {
          ok: false,
          message: `acceptance check "${checkId}" with verify.kind="http" needs an absolute http(s) url.`,
        };
      }
      const expectStatus =
        typeof raw.expect_status === 'number' &&
        Number.isInteger(raw.expect_status)
          ? raw.expect_status
          : 200;
      return { ok: true, value: { kind, url, expect_status: expectStatus } };
    }
    case 'artifact': {
      const artifactType = readString(raw.artifact_type);
      if (!artifactType) {
        return {
          ok: false,
          message: `acceptance check "${checkId}" with verify.kind="artifact" needs an artifact_type.`,
        };
      }
      return { ok: true, value: { kind, artifact_type: artifactType } };
    }
    case 'manual': {
      const reviewer = readString(raw.reviewer);
      if (!reviewer) {
        return {
          ok: false,
          message: `acceptance check "${checkId}" with verify.kind="manual" needs a reviewer. A manual check with no named reviewer is not a check.`,
        };
      }
      return { ok: true, value: { kind, reviewer } };
    }
  }
}

export function normalizeAcceptance(
  value: unknown
):
  | { ok: true; value: NormalizedAcceptanceCheck[] }
  | { ok: false; message: string } {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'acceptance must be an array of checks.' };
  }
  if (value.length > 20) {
    return {
      ok: false,
      message: `acceptance accepts at most 20 checks, received ${value.length}.`,
    };
  }

  const seen = new Set<string>();
  const out: NormalizedAcceptanceCheck[] = [];

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        message: `acceptance[${index}] must be an object with id, statement and verify.`,
      };
    }
    const raw = entry as Record<string, unknown>;
    const id = readString(raw.id);
    if (!id) {
      return {
        ok: false,
        message: `acceptance[${index}] needs a stable id so the receipt can reference it across retries.`,
      };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        message: `acceptance contains duplicate check id "${id}"; ids must be unique.`,
      };
    }
    seen.add(id);

    const statement = readString(raw.statement);
    if (!statement) {
      return {
        ok: false,
        message: `acceptance check "${id}" needs a statement saying what must become true.`,
      };
    }

    const verify = normalizeVerify(id, raw.verify);
    if (!verify.ok) return { ok: false, message: verify.message };

    out.push({
      id,
      statement,
      verify: verify.value,
      must_fail_before: raw.must_fail_before !== false,
    });
  }

  return { ok: true, value: out };
}

function normalizeEffects(
  value: unknown
): { allowed: string[]; approval_required: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = readStringArray(raw.allowed);
  const approvalRequired = readStringArray(raw.approval_required);
  if (allowed.length === 0 && approvalRequired.length === 0) return null;
  return { allowed, approval_required: approvalRequired };
}

// =============================================================================
// NORMALIZATION
// =============================================================================

/**
 * Normalize the dispatch contract fields out of a raw tool-call payload.
 * Returns an actionable refusal rather than throwing, so the caller can hand
 * the message straight back as a tool error.
 */
export function normalizeDispatchContract(
  args: Record<string, unknown>,
  now: Date = new Date()
): DispatchContractResult {
  const deadline = normalizeDeadline(args.deadline, now);
  if (!deadline.ok) {
    return { ok: false, message: deadline.message, code: 'invalid_deadline' };
  }

  const acceptance = normalizeAcceptance(args.acceptance);
  if (!acceptance.ok) {
    return {
      ok: false,
      message: acceptance.message,
      code: 'invalid_acceptance_contract',
    };
  }

  const maxCost =
    typeof args.max_cost_usd === 'number' && Number.isFinite(args.max_cost_usd)
      ? args.max_cost_usd
      : null;
  if (maxCost != null && maxCost < 0) {
    return {
      ok: false,
      message: 'max_cost_usd must be zero or greater.',
      code: 'invalid_budget',
    };
  }

  let maxParallel: number | null = null;
  if (args.max_parallel != null) {
    const raw = args.max_parallel;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 16) {
      return {
        ok: false,
        message: `max_parallel must be an integer between 1 and 16, received ${JSON.stringify(
          raw
        )}.`,
        code: 'invalid_parallelism',
      };
    }
    maxParallel = raw;
  }

  return {
    ok: true,
    contract: {
      deadline: deadline.value,
      max_cost_usd: maxCost,
      budget_mode: readString(args.budget_mode),
      max_parallel: maxParallel,
      expected_artifacts: readStringArray(args.expected_artifacts),
      effects: normalizeEffects(args.effects),
      acceptance: acceptance.value,
      idempotency_key: readString(args.idempotency_key),
    },
  };
}

// =============================================================================
// BINDING — the proof that the contract predates the work
// =============================================================================

/**
 * Stable JSON: keys sorted at every level, no incidental whitespace. Two
 * callers that declare the same checks in a different key order must produce
 * the same hash, or the completion-time comparison is meaningless.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

export async function hashAcceptanceContract(
  checks: NormalizedAcceptanceCheck[]
): Promise<string> {
  const canonical = canonicalJson(checks);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the object persisted at dispatch. Checks start `unprobed`: this worker
 * never observes anything. The app records the pre-states OrgX can see before
 * the work starts, and judges the run against this binding at completion
 * (orgx/lib/server/acceptance/dispatchAcceptance.ts). There is deliberately
 * no verdict here — one judge, in the place that has the evidence.
 */
export async function buildAcceptanceBinding(
  checks: NormalizedAcceptanceCheck[],
  declaredAt: Date = new Date()
): Promise<AcceptanceBinding | null> {
  if (checks.length === 0) return null;
  return {
    contract_hash: await hashAcceptanceContract(checks),
    declared_at: declaredAt.toISOString(),
    checks: checks.map((check) => ({
      ...check,
      pre_state: 'unprobed' as AcceptancePreState,
    })),
  };
}

/**
 * Every verb that starts or re-targets agent work. All four normalize through
 * the same contract; adding a fifth door means adding it here.
 */
export const DISPATCH_TOOL_IDS = new Set([
  'orgx_spawn',
  'delegate_agent_task',
  'spawn_agent_task',
  'handoff_task',
]);

/**
 * Write the normalized contract back onto the outgoing payload.
 *
 * The normalized deadline replaces whatever free text arrived, and the binding
 * travels as `acceptance_binding` so the app persists the hash and declared_at
 * alongside the run rather than re-deriving them after the fact.
 */
export function applyDispatchContractToArgs(
  args: Record<string, unknown>,
  contract: NormalizedDispatchContract,
  binding: AcceptanceBinding | null
): Record<string, unknown> {
  const out = { ...args };

  if (contract.deadline) out.deadline = contract.deadline;
  else delete out.deadline;

  if (contract.max_parallel != null) out.max_parallel = contract.max_parallel;
  if (contract.effects) out.effects = contract.effects;

  // The structured checks are superseded by the binding, which carries the
  // same checks plus the hash and timestamp that make them verifiable.
  delete out.acceptance;
  if (binding) out.acceptance_binding = binding;

  return out;
}
