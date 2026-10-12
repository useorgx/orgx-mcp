/** Closed validation summaries only. Private messages, paths and values stay local. */
export const VALIDATION_ISSUE_CODES = [
  'invalid_type', 'invalid_literal', 'unrecognized_keys', 'invalid_union',
  'invalid_union_discriminator', 'invalid_enum_value', 'invalid_string',
  'too_small', 'too_big', 'custom', 'invalid_intersection_types',
  'not_multiple_of', 'not_finite', 'invalid_value', 'invalid_format',
] as const;
const knownCodes = new Set<string>(VALIDATION_ISSUE_CODES);
const MAX_ISSUES = 20;
export type ValidationTelemetrySummary = {
  validationIssueCount?: number;
  validationIssueCodes?: string[];
  validationIssuesTruncated?: boolean;
};
export function summarizeValidationIssues(value: unknown): ValidationTelemetrySummary {
  if (!Array.isArray(value)) return {};
  const codes = new Set<string>();
  for (const issue of value.slice(0, MAX_ISSUES)) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) continue;
    const code = (issue as { code?: unknown }).code;
    if (typeof code === 'string' && knownCodes.has(code)) codes.add(code);
  }
  return { validationIssueCount: Math.min(value.length, MAX_ISSUES),
    validationIssueCodes: [...codes].slice(0, 10), validationIssuesTruncated: value.length > MAX_ISSUES };
}
