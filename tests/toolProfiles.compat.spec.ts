// Ported from the orgx monorepo's dispatchGaps.spec.ts (Gap 4) when the
// vendored worker copy at orgx/workers/orgx-mcp was removed. toolProfiles is
// deprecated in favor of the web repo's lib/server/toolManifest, but dispatch
// still resolves profiles through it — keep the compat surface pinned.
import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { V2_PUBLIC_TOOL_IDS } from '../src/bootstrapPayload';
import { PRIMARY_AUTHENTICATED_TOOLS } from '../src/publicMcpDiscovery';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
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

  it('keeps the ChatGPT review surface focused and excludes internal aliases', () => {
    const chatgptTools = resolveProfileToolSet('chatgpt');

    expect([...(chatgptTools ?? [])]).toEqual([...CHATGPT_PUBLIC_SURFACE]);
    expect(chatgptTools!.size).toBe(23);
    expect(chatgptTools!.has('orgx_bootstrap')).toBe(true);
    expect(chatgptTools!.has('get_initiative_pulse')).toBe(true);
    expect(chatgptTools!.has('consolidate_pr')).toBe(false);
    expect(chatgptTools!.has('delegate_agent_task')).toBe(false);
    expect(chatgptTools!.has('spawn_agent_task')).toBe(false);
    expect(chatgptTools!.has('orgx_emit_activity')).toBe(false);
    expect(chatgptTools!.has('orgx_request_attention')).toBe(false);
    expect(chatgptTools!.has('query_org_memory')).toBe(false);
    expect(chatgptTools!.has('recall_memory')).toBe(false);
    expect(chatgptTools!.has('recommend_next_action')).toBe(false);
    expect(chatgptTools!.has('track_project_progress')).toBe(false);
  });

  it('keeps the Anthropic directory profile focused and independently read-only', () => {
    const claudeDirectoryTools = resolveProfileToolSet('claude-directory');

    expect([...(claudeDirectoryTools ?? [])]).toEqual([
      ...CLAUDE_DIRECTORY_SURFACE,
    ]);
    expect(claudeDirectoryTools?.size).toBe(8);

    for (const toolName of claudeDirectoryTools ?? []) {
      const manifestTool = serverManifest.tools.find(
        (tool) => tool.name === toolName
      );
      expect(manifestTool, `${toolName} must be published`).toBeDefined();
      expect(manifestTool?.title, `${toolName} must have a title`).toEqual(
        expect.any(String)
      );
      expect(toolName.length, `${toolName} exceeds Anthropic's name limit`).toBeLessThanOrEqual(
        64
      );
      expect(manifestTool?.annotations, `${toolName} must be read-only`).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      });
    }

    for (const excludedTool of [
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'manage_lifecycle',
      'orgx_plan',
      'orgx_spawn',
      'orgx_decide',
      'orgx_submit_receipt',
      'approve_decision',
      'reject_decision',
      'handoff_task',
      'scaffold_initiative',
    ]) {
      expect(
        claudeDirectoryTools?.has(excludedTool),
        `${excludedTool} must stay off the read-only directory profile`
      ).toBe(false);
    }
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
