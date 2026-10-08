// Ported from the orgx monorepo's dispatchGaps.spec.ts (Gap 4) when the
// vendored worker copy at orgx/workers/orgx-mcp was removed. toolProfiles is
// deprecated in favor of the web repo's lib/server/toolManifest, but dispatch
// still resolves profiles through it — keep the compat surface pinned.
import { describe, expect, it, vi } from 'vitest';

import serverManifest from '../server.json';
import { V2_PUBLIC_TOOL_IDS } from '../src/bootstrapPayload';
import { PRIMARY_AUTHENTICATED_TOOLS } from '../src/publicMcpDiscovery';
import { getKnownToolContract } from '../src/contractTools';
import { getClaudeDirectoryToolContract } from '../src/claudeDirectoryTools';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
  CLAUDE_PLUGIN_SURFACE,
  GROUPED_V2_PUBLIC_SURFACE,
  resolveProfileToolSet,
  resolveToolProfile,
} from '../src/toolProfiles';

// These are separate compatibility contracts. Expanding the connector
// directory must never grant writes to an unknown profile or silently widen
// an already-installed Claude Code plugin.
const INFORMATIONAL_BASELINE = [
  'orgx_search',
  'orgx_inspect',
  'orgx_recommend',
  'get_agent_status',
  'get_initiative_pulse',
  'get_morning_brief',
  'get_operator_chronicle',
] as const;

const CLAUDE_PLUGIN_BASELINE = [
  ...INFORMATIONAL_BASELINE,
  'orgx_command_status',
  'orgx_controller_status',
  'orgx_emit_activity',
  'orgx_submit_receipt',
  'orgx_attach',
  'orgx_decide',
  'orgx_expect',
  'orgx_bootstrap',
  'orgx_tail',
] as const;

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
    expect(chatgptTools!.size).toBe(28);
    expect(chatgptTools!.has('orgx_bootstrap')).toBe(true);
    expect(chatgptTools!.has('get_initiative_pulse')).toBe(true);
    expect(chatgptTools!.has('consolidate_pr')).toBe(false);
    expect(chatgptTools!.has('delegate_agent_task')).toBe(false);
    expect(chatgptTools!.has('spawn_agent_task')).toBe(false);
    expect(chatgptTools!.has('orgx_emit_activity')).toBe(false);
    expect(chatgptTools!.has('orgx_request_attention')).toBe(false);
    expect(chatgptTools!.has('orgx_controller_status')).toBe(false);
    expect(chatgptTools!.has('query_org_memory')).toBe(false);
    expect(chatgptTools!.has('recall_memory')).toBe(false);
    expect(chatgptTools!.has('recommend_next_action')).toBe(false);
    expect(chatgptTools!.has('track_project_progress')).toBe(false);
  });

  it('exposes broader Claude workflows through operation-specific contracts', () => {
    const directoryTools = resolveProfileToolSet('claude-directory');
    expect([...(directoryTools ?? [])]).toEqual([...CLAUDE_DIRECTORY_SURFACE]);
    expect(directoryTools?.size).toBe(29);

    for (const toolName of directoryTools ?? []) {
      const tool = getClaudeDirectoryToolContract(toolName) ?? getKnownToolContract(toolName);
      expect(tool, `${toolName} must have an authorization contract`).toBeDefined();
      expect(toolName.length, `${toolName} exceeds Anthropic's name limit`).toBeLessThanOrEqual(64);
      expect(tool?.title?.trim(), `${toolName} is missing a title`).toBeTruthy();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(tool?.securitySchemes?.length, `${toolName} is missing authorization`).toBeGreaterThan(0);
    }

    for (const workflowTool of [
      'orgx_bootstrap', 'orgx_create_entity', 'orgx_update_entity',
      'orgx_start_plan', 'orgx_read_plan', 'orgx_improve_plan',
      'orgx_record_plan_edit', 'orgx_complete_plan', 'orgx_check_delegation',
      'orgx_delegate_work', 'orgx_list_pending_decisions', 'orgx_record_decision',
      'orgx_open_decision_review', 'orgx_attach', 'orgx_submit_receipt',
      'orgx_complete_with_proof', 'orgx_change_entity_state', 'manage_lifecycle',
    ]) {
      expect(directoryTools?.has(workflowTool), workflowTool).toBe(true);
    }
    // Read and write branches of these routers have distinct directory tools.
    for (const router of ['orgx_write', 'orgx_act', 'orgx_plan', 'orgx_spawn', 'orgx_decide']) {
      expect(directoryTools?.has(router), router).toBe(false);
    }
    expect(getClaudeDirectoryToolContract('orgx_read_plan')?.annotations.readOnlyHint).toBe(true);
    expect(getClaudeDirectoryToolContract('orgx_start_plan')?.annotations.readOnlyHint).toBe(false);
    expect(getClaudeDirectoryToolContract('orgx_check_delegation')?.annotations.readOnlyHint).toBe(true);
    expect(getClaudeDirectoryToolContract('orgx_delegate_work')?.annotations.readOnlyHint).toBe(false);
  });

  it('resolveProfileToolSet defaults omitted profiles to the compact v2 surface', () => {
    const defaultTools = resolveProfileToolSet(null);
    const undefinedTools = resolveProfileToolSet(undefined);

    expect(defaultTools).toBeInstanceOf(Set);
    expect(defaultTools!.has('orgx_bootstrap')).toBe(true);
    expect(defaultTools!.has('orgx_controller_status')).toBe(true);
    expect(defaultTools!.has('orgx_write')).toBe(true);
    expect(defaultTools!.has('orgx_request_question')).toBe(true);
    expect(defaultTools!.has('orgx_poll_question')).toBe(true);
    expect(defaultTools!.has('orgx_request_attention')).toBe(true);
    expect(defaultTools!.has('orgx_poll_attention')).toBe(true);
    expect(defaultTools!.has('orgx_ack_attention')).toBe(true);
    expect(undefinedTools).toEqual(defaultTools);
  });

  it('fails unknown profiles closed to the read-only fallback surface', () => {
    const fallbackTools = resolveProfileToolSet('typo-admin');
    expect(fallbackTools).toEqual(resolveProfileToolSet('read-only'));
    expect([...(fallbackTools ?? [])]).toEqual([...INFORMATIONAL_BASELINE]);
    expect(fallbackTools?.size).toBe(7);
    expect(resolveToolProfile('typo-admin')).toMatchObject({
      name: 'read-only',
      requestedName: 'typo-admin',
      fellBack: true,
    });
    // Every tool on the fallback surface is a read.
    for (const excludedTool of [
      'orgx_write',
      'orgx_act',
      'orgx_spawn',
      'orgx_attach',
      'orgx_submit_receipt',
      'orgx_emit_activity',
      'scaffold_initiative',
      'spawn_agent_task',
    ]) {
      expect(
        fallbackTools?.has(excludedTool),
        `${excludedTool} must stay off the read-only fallback`
      ).toBe(false);
    }
  });

  it('logs a warning when an unknown profile falls back', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveToolProfile('typo-admin');
      expect(warn).toHaveBeenCalledWith(
        '[mcp:profiles] Unknown tool profile; failing closed to read-only surface',
        { requested: 'typo-admin', effective: 'read-only' }
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves the installed claude-plugin inventory independently of the directory', () => {
    const pluginTools = resolveProfileToolSet('claude-plugin');

    expect(CLAUDE_PLUGIN_SURFACE).toEqual(CLAUDE_PLUGIN_BASELINE);
    expect([...(pluginTools ?? [])]).toEqual([...CLAUDE_PLUGIN_BASELINE]);
    expect(pluginTools?.size).toBe(16);
    for (const readTool of INFORMATIONAL_BASELINE) {
      expect(
        pluginTools?.has(readTool),
        `${readTool} must stay on the claude-plugin profile`
      ).toBe(true);
    }
    for (const writeTool of [
      'orgx_emit_activity',
      'orgx_submit_receipt',
      'orgx_attach',
      'orgx_decide',
      'orgx_expect',
      'orgx_bootstrap',
    ]) {
      expect(
        pluginTools?.has(writeTool),
        `${writeTool} must be on the claude-plugin profile`
      ).toBe(true);
    }
    expect(pluginTools?.has('orgx_controller_status')).toBe(true);
    // The plugin surface stays lean: no broad writes or delegation.
    for (const excludedTool of [
      'orgx_write',
      'orgx_act',
      'orgx_spawn',
      'orgx_plan',
      'scaffold_initiative',
      'spawn_agent_task',
      'manage_lifecycle',
    ]) {
      expect(
        pluginTools?.has(excludedTool),
        `${excludedTool} must stay off the claude-plugin profile`
      ).toBe(false);
    }
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
