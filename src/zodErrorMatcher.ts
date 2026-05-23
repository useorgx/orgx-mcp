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

/**
 * Coarse error category for the telemetry dashboard. Lets the saved
 * "rank by failure category" query group dispatch / auth / input-shape
 * problems without substring-matching arbitrary error text in HogQL.
 *
 * Categories (precedence top-to-bottom):
 *   - 'launch_silent_no_op'    — initiative launch returned 200 but no streams transitioned
 *   - 'spawn_guard_blocked'    — spawn-guard rejected the dispatch (rate limit / quality / authz)
 *   - 'auth_failed'            — Unauthorized / forbidden response from the API
 *   - 'invalid_input'          — Zod-flavored validation error (matches the existing patterns)
 *   - 'unknown'                — fallthrough; useful as the "everything else" bucket
 *
 * Returns null when no error string is provided so callers can leave the
 * field unset entirely (vs falsely tagging clean successes).
 */
export type ErrorKind =
  | 'launch_silent_no_op'
  | 'spawn_guard_blocked'
  | 'auth_failed'
  | 'invalid_input'
  | 'unknown';

const SPAWN_GUARD_PATTERNS: readonly RegExp[] = [
  /\bspawn[-_ ]?guard\b/i,
  /\bquality[-_ ]?gate\b/i,
  /\brate[-_ ]?limit(?:ed)?\b/i,
  /\bdelegation\s+(?:denied|blocked)\b/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /\bUnauthorized\b/i,
  /\bForbidden\b/i,
  /\bauth(?:entication|orization)\s+(?:failed|required)\b/i,
  /\b401\b/,
  /\b403\b/,
];

const LAUNCH_NOOP_PATTERNS: readonly RegExp[] = [
  /\blaunch[_ ]silent[_ ]no[_ ]?op\b/i,
  /\bno streams transitioned\b/i,
  /\bsilently\s+no[-_ ]?op(?:'?d|ped)?\b/i,
];

export function classifyErrorKind(
  error: string | undefined | null
): ErrorKind | null {
  if (typeof error !== 'string' || error.length === 0) return null;
  if (LAUNCH_NOOP_PATTERNS.some((re) => re.test(error))) {
    return 'launch_silent_no_op';
  }
  if (SPAWN_GUARD_PATTERNS.some((re) => re.test(error))) {
    return 'spawn_guard_blocked';
  }
  if (AUTH_PATTERNS.some((re) => re.test(error))) {
    return 'auth_failed';
  }
  if (isZodFlavoredErrorMessage(error)) return 'invalid_input';
  return 'unknown';
}
