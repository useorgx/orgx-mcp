// Ported from the orgx monorepo's dispatchGaps.spec.ts (Gap 4) when the
// vendored worker copy at orgx/workers/orgx-mcp was removed. toolProfiles is
// deprecated in favor of the web repo's lib/server/toolManifest, but dispatch
// still resolves profiles through it — keep the compat surface pinned.
import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { V2_PUBLIC_TOOL_IDS } from '../src/bootstrapPayload';
import { PRIMARY_AUTHENTICATED_TOOLS } from '../src/publicMcpDiscovery';
import {
  GROUPED_V2_PUBLIC_SURFACE,
  resolveProfileToolSet,
  resolveToolProfile,
} from '../src/toolProfiles';

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

  it('fails unknown profiles closed to the default v2 surface', () => {
    expect(resolveProfileToolSet('typo-admin')).toEqual(
      resolveProfileToolSet('v2')
    );
    expect(resolveToolProfile('typo-admin')).toMatchObject({
      name: 'v2',
      requestedName: 'typo-admin',
      fellBack: true,
    });
  });

  it('reports omitted profile negotiation as v2 rather than full', () => {
    expect(resolveToolProfile(undefined)).toMatchObject({
      name: 'v2',
      requestedName: null,
      fellBack: false,
    });
    expect(resolveToolProfile('full')).toMatchObject({
      name: 'full',
      requestedName: 'full',
      fellBack: false,
      tools: null,
    });
  });

  it('keeps published, bootstrap, discovery, and grouped v2 tools identical', () => {
    const published = serverManifest.tools.map((tool) => tool.name);
    expect(V2_PUBLIC_TOOL_IDS).toEqual(published);
    expect(PRIMARY_AUTHENTICATED_TOOLS).toEqual(published);
    expect([...GROUPED_V2_PUBLIC_SURFACE]).toEqual(published);
    expect([...(resolveProfileToolSet('v2') ?? [])]).toEqual(published);
  });
});
