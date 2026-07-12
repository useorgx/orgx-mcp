import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

import {
  STANDARD_TOOL_OUTPUT_SCHEMA,
  STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT,
  ensureStructuredContent,
} from '../src/toolDefinitions';

// Regression guard for the 2026-07-11 outage: the default output schema was
// registered as a raw shape, which the SDK compiles with
// additionalProperties:false. Every tool returning rich structuredContent
// (orgx_search, orgx_bootstrap, orgx_inspect, ...) then violated its own
// advertised schema, and validating clients rejected the response with
// "Structured content does not match the tool's output schema" — after the
// server had already performed the write (500s from the Claude connector,
// -32602 from OpenCode, duplicate rows from client retries).

describe('standard tool output schema', () => {
  it('advertises an open envelope (additionalProperties: true)', () => {
    const compiled = toJsonSchemaCompat(STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT, {
      strictUnions: true,
    }) as { additionalProperties?: unknown; properties?: Record<string, unknown> };
    expect(compiled.additionalProperties).toBe(true);
    // The declared envelope fields survive for Smithery / Apps SDK coverage.
    for (const key of ['ok', 'summary', 'data', 'warnings', 'meta']) {
      expect(compiled.properties, `missing envelope field ${key}`).toHaveProperty(
        key
      );
    }
  });

  it('documents why the raw shape must not be registered directly', () => {
    // The raw shape compiles closed — this is the exact failure mode the
    // passthrough object exists to prevent. If the SDK ever changes this
    // default, the passthrough registration remains correct.
    const compiled = toJsonSchemaCompat(z.object(STANDARD_TOOL_OUTPUT_SCHEMA), {
      strictUnions: true,
    }) as { additionalProperties?: unknown };
    expect(compiled.additionalProperties).toBe(false);
  });

  it('accepts rich structuredContent payloads with tool-specific keys', () => {
    const richPayload = {
      results: [{ id: 'dec-1', title: 'API rate limiting' }],
      session: { id: 'sess-1' },
      workspace_id: 'ws-1',
      total: 1,
    };
    const parsed = STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT.safeParse(richPayload);
    expect(parsed.success).toBe(true);
    // Passthrough must preserve, not strip, the tool-specific keys.
    expect(parsed.success && parsed.data).toEqual(richPayload);
  });

  it('synthesized envelopes for text-only results also validate', () => {
    const result = ensureStructuredContent({
      content: [{ type: 'text', text: 'done' }],
    });
    const parsed = STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT.safeParse(
      (result as { structuredContent?: unknown }).structuredContent
    );
    expect(parsed.success).toBe(true);
  });
});
