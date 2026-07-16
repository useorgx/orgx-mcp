// Ported from the orgx monorepo's dispatchGaps.spec.ts (Gap 4) when the
// vendored worker copy at orgx/workers/orgx-mcp was removed. toolProfiles is
// deprecated in favor of the web repo's lib/server/toolManifest, but dispatch
// still resolves profiles through it — keep the compat surface pinned.
import { describe, expect, it } from 'vitest';

import { resolveProfileToolSet } from '../src/toolProfiles';

describe('toolProfiles backward compatibility', () => {
  it('resolveProfileToolSet returns null only for explicit full profile', () => {
    expect(resolveProfileToolSet('full')).toBeNull();
  });

  it('resolveProfileToolSet returns tool set for named profiles', () => {
    const executorTools = resolveProfileToolSet('executor');
    expect(executorTools).toBeInstanceOf(Set);
    expect(executorTools!.size).toBeGreaterThan(0);
    expect(executorTools!.has('orgx_emit_activity')).toBe(true);
    expect(executorTools!.has('orgx_request_question')).toBe(true);
    expect(executorTools!.has('orgx_poll_question')).toBe(true);
    expect(executorTools!.has('orgx_request_attention')).toBe(true);
    expect(executorTools!.has('orgx_poll_attention')).toBe(true);
    expect(executorTools!.has('orgx_ack_attention')).toBe(true);
  });

  it('resolveProfileToolSet defaults omitted profiles to the compact v2 surface', () => {
    const defaultTools = resolveProfileToolSet(null);
    const undefinedTools = resolveProfileToolSet(undefined);

    expect(defaultTools).toBeInstanceOf(Set);
    expect(defaultTools!.has('orgx_bootstrap')).toBe(true);
    expect(defaultTools!.has('orgx_write')).toBe(true);
    expect(defaultTools!.has('orgx_request_question')).toBe(true);
    expect(defaultTools!.has('orgx_poll_question')).toBe(true);
    expect(defaultTools!.has('orgx_request_attention')).toBe(true);
    expect(defaultTools!.has('orgx_poll_attention')).toBe(true);
    expect(defaultTools!.has('orgx_ack_attention')).toBe(true);
    expect(undefinedTools).toEqual(defaultTools);
  });
});
