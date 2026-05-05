/**
 * Zod-flavored error pattern matcher.
 *
 * The MCP SDK formats input-validation failures using Zod's stock error
 * messages — we want to recognise those at telemetry time so the
 * dashboard can rank "most common ways agents fail to call X" without
 * substring-matching arbitrary error text in the saved query.
 *
 * Patterns are deliberately conservative — false negatives are cheaper
 * than false positives in telemetry; we'd rather under-tag than tag
 * unrelated errors as input-validation problems.
 */

const ZOD_PATTERNS: readonly RegExp[] = [
  /\bRequired\b/i,
  /\bInvalid enum value\b/i,
  /\bExpected\b.+\breceived\b/i,
  /\bInvalid input\b/i,
  /\b(?:Number|String|Array)\b\s+must\b/i,
  /\bat\s+"[^"]+"/, // path tag emitted by Zod-derived formatters
  /\bvalidation\s+(?:error|failed)\b/i,
];

export function isZodFlavoredErrorMessage(
  error: string | undefined | null
): boolean {
  if (typeof error !== 'string' || error.length === 0) return false;
  return ZOD_PATTERNS.some((re) => re.test(error));
}

/**
 * Best-effort extraction of the field path from a Zod-formatted error.
 * Returns null when no recognisable path is present so the dashboard
 * can group "no_path" as its own bucket instead of conflating with
 * named-field failures.
 */
export function extractZodErrorPath(
  error: string | undefined | null
): string | null {
  if (typeof error !== 'string' || error.length === 0) return null;
  const atMatch = /\bat\s+"([^"]+)"/.exec(error);
  if (atMatch) return atMatch[1] ?? null;
  const pathMatch = /\bpath:\s*\[\s*"([^"]+)"/.exec(error);
  if (pathMatch) return pathMatch[1] ?? null;
  const fieldMatch = /\bfield\s+"([^"]+)"/.exec(error);
  if (fieldMatch) return fieldMatch[1] ?? null;
  return null;
}
