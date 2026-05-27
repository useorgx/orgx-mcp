export const LOOP_VALIDATION_RUNGS = [
  'schema_discovery',
  'dry_run_spawn',
  'single_domain_fixture',
  'cross_domain_initiative_fixture',
  'overnight_canary',
  'calibrated_auto_route_expansion',
] as const;

export type LoopValidationRung = (typeof LOOP_VALIDATION_RUNGS)[number];

export type LoopReliabilityValidationResult = {
  rung: LoopValidationRung | null;
  applies: boolean;
  promotable: boolean;
  missing: string[];
  warnings: string[];
  next_required_action: string | null;
};

const LOOP_VALIDATION_RUNG_SET = new Set<string>(LOOP_VALIDATION_RUNGS);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasUrlLikeEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) || /^orgx:\/\//i.test(value);
  }

  if (Array.isArray(value)) return value.some((entry) => hasUrlLikeEvidence(entry));

  const record = readRecord(value);
  if (!record) return false;

  return Object.values(record).some((entry) => hasUrlLikeEvidence(entry));
}

export function normalizeLoopValidationRung(value: unknown): LoopValidationRung | null {
  const normalized = nonEmptyString(value)?.toLowerCase().replace(/[-\s]+/g, '_');
  return normalized && LOOP_VALIDATION_RUNG_SET.has(normalized)
    ? (normalized as LoopValidationRung)
    : null;
}

export function evaluateLoopReliabilityReceipt(
  receipt: Record<string, unknown>
): LoopReliabilityValidationResult {
  const rung = normalizeLoopValidationRung(receipt.validation_rung);
  const explicitValidation = receipt.loop_validation === true || rung !== null;
  const verificationStatus = nonEmptyString(receipt.verification_status);
  const budgetMode = nonEmptyString(receipt.budget_mode);
  const modelTier = nonEmptyString(receipt.model_tier);
  const evidence = readRecord(receipt.evidence);
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const field of [
    'artifact_type',
    'agent_type',
    'business_outcome',
    'verification_status',
  ]) {
    if (!nonEmptyString(receipt[field])) missing.push(field);
  }

  if (!evidence && !nonEmptyString(receipt.artifact_id)) {
    missing.push('evidence_or_artifact_id');
  } else if (
    verificationStatus !== 'blocked' &&
    !hasUrlLikeEvidence(evidence) &&
    !nonEmptyString(receipt.artifact_id)
  ) {
    warnings.push('evidence should include a verifiable URL or artifact_id');
  }

  if (explicitValidation && !rung) {
    missing.push('validation_rung');
  }

  if (rung && rung !== 'calibrated_auto_route_expansion') {
    if (modelTier !== 'standard') missing.push('model_tier=standard');
    if (budgetMode !== 'cheapest_valid') missing.push('budget_mode=cheapest_valid');
  }

  if (
    rung === 'calibrated_auto_route_expansion' &&
    budgetMode === 'cheapest_valid'
  ) {
    warnings.push(
      'calibrated expansion should compare auto-route candidates instead of staying pinned to cheapest_valid'
    );
  }

  const promotable =
    missing.length === 0 &&
    verificationStatus === 'passed' &&
    (rung === null || warnings.length === 0);

  return {
    rung,
    applies: explicitValidation,
    promotable,
    missing,
    warnings,
    next_required_action: promotable
      ? null
      : missing.length > 0
      ? `Add missing loop receipt fields: ${missing.join(', ')}.`
      : warnings[0] ?? 'Submit a passed verification receipt before promotion.',
  };
}
