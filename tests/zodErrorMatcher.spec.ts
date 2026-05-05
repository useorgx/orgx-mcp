import { describe, expect, it } from 'vitest';

import {
  isZodFlavoredErrorMessage,
  extractZodErrorPath,
  classifyErrorKind,
} from '../src/zodErrorMatcher';

/**
 * Pass 4 — Zod-flavored error matcher tests.
 *
 * captureMcpToolEvent auto-emits a parallel `mcp_tool_invalid_input`
 * event whenever an `mcp_tool_failed` carries Zod-pattern error text.
 * That auto-detection is what powers the dashboard's "rank the most
 * common ways agents fail to call X" query without requiring every
 * call site to manually tag errorKind. These tests pin the matcher
 * so the dashboard signal can't silently regress.
 */

describe('isZodFlavoredErrorMessage', () => {
  it.each([
    ['Required', true],
    ['title: Required', true],
    ['Invalid enum value. Expected one of: high, medium, low', true],
    ['Expected string, received number at "priority"', true],
    ['Number must be greater than or equal to 0', true],
    ['String must contain at least 1 character(s)', true],
    ['Validation error: missing entity_type', true],
    ['Invalid input: expected initiative_id', true],
    ['at "metadata.checklist[0].item"', true],
  ])('matches Zod-flavored error: %j', (input, expected) => {
    expect(isZodFlavoredErrorMessage(input)).toBe(expected);
  });

  it.each([
    ['Network error: timed out', false],
    ['HTTP 500 Internal Server Error', false],
    ['Database connection refused', false],
    ['Tool execution failed', false],
    ['', false],
  ])('does not match unrelated error: %j', (input, expected) => {
    expect(isZodFlavoredErrorMessage(input)).toBe(expected);
  });

  it('handles null and undefined safely', () => {
    expect(isZodFlavoredErrorMessage(null)).toBe(false);
    expect(isZodFlavoredErrorMessage(undefined)).toBe(false);
  });
});

describe('extractZodErrorPath', () => {
  it('extracts the path from `at "field"` form', () => {
    expect(extractZodErrorPath('Expected string at "title"')).toBe('title');
  });

  it('extracts the path from `path: ["field"]` form', () => {
    expect(extractZodErrorPath('Required (path: ["initiative_id"])')).toBe(
      'initiative_id'
    );
  });

  it('extracts the path from `field "field"` form', () => {
    expect(extractZodErrorPath('Missing required field "decision_id"')).toBe(
      'decision_id'
    );
  });

  it('extracts the deepest dotted path token verbatim', () => {
    // A nested-path message — we keep the raw inner so the dashboard can
    // group on the same string the agent would have logged.
    expect(
      extractZodErrorPath('Invalid value at "metadata.checklist[0].item"')
    ).toBe('metadata.checklist[0].item');
  });

  it('returns null when no recognisable path is present', () => {
    expect(extractZodErrorPath('Required')).toBe(null);
    expect(extractZodErrorPath('Validation failed')).toBe(null);
  });

  it('handles null and undefined safely', () => {
    expect(extractZodErrorPath(null)).toBe(null);
    expect(extractZodErrorPath(undefined)).toBe(null);
  });
});

describe('classifyErrorKind', () => {
  // Precedence: launch_silent_no_op > spawn_guard_blocked > auth_failed > invalid_input > unknown
  it.each([
    ['Launch endpoint silently no-op\'d', 'launch_silent_no_op'],
    ['No streams transitioned to active', 'launch_silent_no_op'],
    ['dispatcher silently no-op\'d', 'launch_silent_no_op'],
    ['spawn guard blocked: rate limit exceeded', 'spawn_guard_blocked'],
    ['Quality gate failed for engineering domain', 'spawn_guard_blocked'],
    ['Rate limited (429): retry after 60s', 'spawn_guard_blocked'],
    ['Delegation denied for marketing-agent', 'spawn_guard_blocked'],
    ['Unauthorized', 'auth_failed'],
    ['Forbidden: insufficient scope', 'auth_failed'],
    ['Authentication required', 'auth_failed'],
    ['HTTP 401: missing bearer token', 'auth_failed'],
    ['Required', 'invalid_input'],
    ['Invalid enum value. Expected one of: high, medium, low', 'invalid_input'],
    ['Expected string, received number at "priority"', 'invalid_input'],
    ['Network timeout', 'unknown'],
    ['Database connection refused', 'unknown'],
  ] as const)('classifies %j as %j', (input, expected) => {
    expect(classifyErrorKind(input)).toBe(expected);
  });

  it('returns null for null/undefined/empty so callers can omit error_kind', () => {
    expect(classifyErrorKind(null)).toBe(null);
    expect(classifyErrorKind(undefined)).toBe(null);
    expect(classifyErrorKind('')).toBe(null);
  });

  it('respects the precedence order — auth + zod patterns in same string yields auth_failed', () => {
    // "Unauthorized: required field missing" — both auth and zod-flavor
    // tokens are present. We want auth_failed because the auth failure
    // is the actionable signal (the request never even got validated).
    expect(classifyErrorKind('Unauthorized: required field missing')).toBe(
      'auth_failed'
    );
  });

  it('spawn-guard precedes auth — rate-limit messages can include 401-like text', () => {
    expect(
      classifyErrorKind('spawn guard rate-limited (returns 401-equivalent)')
    ).toBe('spawn_guard_blocked');
  });
});
