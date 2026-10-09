import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { formatForLLM } from '../src/responseSummarizer';
import { ORGX_SURFACES, buildSurfaceMap } from '../src/surfaceMap';
import { CLAUDE_DIRECTORY_SURFACE, LEGACY_CLAUDE_DIRECTORY_SURFACE, resolveProfileToolSet } from '../src/toolProfiles';
import { isWidgetOnlyTool, WIDGET_ONLY_TOOL_IDS } from '../src/widgetToolContract';

const manifestTools = new Set(serverManifest.tools.map((tool) => tool.name));
const mappedTools = (map: ReturnType<typeof buildSurfaceMap>) =>
  map.flatMap((surface) => [...surface.read, ...surface.control]);

describe('OrgX surface map', () => {
  it('maps current operations to the product surfaces they read and control', () => {
    const map = buildSurfaceMap({
      visibleTools: CLAUDE_DIRECTORY_SURFACE,
      profile: 'claude-directory',
    });
    expect(map.find((surface) => surface.id === 'initiatives')).toMatchObject({
      read: ['orgx_get_workspace_context', 'orgx_inspect', 'orgx_get_initiative_progress', 'orgx_read_plan', 'orgx_validate_initiative_plan'],
      control: [
        'orgx_start_plan', 'orgx_save_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
        'orgx_create_initiative_hierarchy', 'orgx_create_initiative', 'orgx_create_workstream',
        'orgx_create_milestone', 'orgx_create_task', 'orgx_update_work',
        'orgx_launch_initiative', 'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work',
        'orgx_cancel_work', 'orgx_complete_work_with_proof',
      ],
    });
    expect(map.find((surface) => surface.id === 'decisions')).toMatchObject({
      read: ['orgx_search', 'orgx_inspect', 'orgx_list_pending_decisions', 'orgx_open_decision_review'],
      control: ['orgx_capture_decision'],
    });
    expect(map.find((surface) => surface.id === 'agents')?.control).toEqual(['orgx_start_agent_task', 'orgx_handoff_task']);
    expect(map.find((surface) => surface.id === 'quality')?.read).toContain('orgx_open_artifact_review');
    expect(map.find((surface) => surface.id === 'work-ledger')).toMatchObject({
      read: ['orgx_search', 'orgx_get_operator_brief', 'orgx_get_work_receipt', 'orgx_list_work_receipts', 'orgx_get_receipt_review_queue'],
      control: ['orgx_submit_work_receipt', 'orgx_attach_artifact'],
    });
    expect(map.find((surface) => surface.id === 'goals')?.control).toEqual([]);
  });

  it('filters directory surface reads and controls to the effective OAuth inventory', () => {
    const visibleTools = ['orgx_search', 'orgx_list_pending_decisions', 'orgx_read_plan'];
    const map = buildSurfaceMap({ visibleTools, profile: 'claude-directory' });
    expect(map.find((surface) => surface.id === 'decisions')).toMatchObject({
      read: ['orgx_search', 'orgx_list_pending_decisions'], control: [],
    });
    expect(map.find((surface) => surface.id === 'initiatives')).toMatchObject({
      read: ['orgx_read_plan'], control: [],
    });
    for (const tool of map.flatMap((surface) => [...surface.read, ...surface.control])) {
      expect(visibleTools).toContain(tool);
    }
  });

  it('shares the current operation map across current profiles', () => {
    // Even an overly broad input cannot add legacy routers to a current map.
    const visibleTools = [...manifestTools, 'orgx_act', 'orgx_spawn', 'manage_lifecycle'];
    const defaultMap = buildSurfaceMap({ visibleTools });
    for (const profile of ['chatgpt', 'v2', 'claude-directory', 'extended', 'read-only', 'full']) {
      expect(buildSurfaceMap({ visibleTools, profile })).toEqual(defaultMap);
    }
    expect(defaultMap.find((surface) => surface.id === 'agents')?.control).toContain('orgx_start_agent_task');
    expect(mappedTools(defaultMap)).not.toContain('orgx_spawn');
    expect(mappedTools(defaultMap)).not.toContain('manage_lifecycle');
  });

  it('preserves router guidance only for explicit compatibility profiles', () => {
    const visibleTools = ['orgx_decide', 'orgx_spawn', 'orgx_act', 'orgx_write', 'manage_lifecycle', 'orgx_search'];
    const legacyMap = buildSurfaceMap({ visibleTools, profile: 'legacy' });
    expect(legacyMap.find((surface) => surface.id === 'agents')?.control).toEqual(['orgx_spawn']);
    expect(legacyMap.find((surface) => surface.id === 'decisions')).toMatchObject({
      read: ['orgx_search'], control: ['orgx_decide'],
    });
    for (const profile of ['claude-plugin', 'memory', 'commander', 'planner', 'executor', 'observer']) {
      expect(buildSurfaceMap({ visibleTools, profile })).toEqual(legacyMap);
    }
    expect(mappedTools(buildSurfaceMap({ visibleTools }))).toEqual(['orgx_search', 'orgx_search', 'orgx_search']);
  });

  it('keeps the historical directory map behind its explicit compatibility profile', () => {
    const map = buildSurfaceMap({
      visibleTools: LEGACY_CLAUDE_DIRECTORY_SURFACE,
      profile: 'claude-directory-legacy',
    });
    expect(map.find((surface) => surface.id === 'initiatives')).toMatchObject({
      read: ['orgx_inspect', 'get_initiative_pulse', 'orgx_read_plan'],
      control: [
        'orgx_start_plan', 'orgx_improve_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
        'orgx_create_entity', 'orgx_update_entity', 'orgx_change_entity_state',
        'orgx_complete_with_proof', 'manage_lifecycle',
      ],
    });
    expect(map.find((surface) => surface.id === 'decisions')?.control).toEqual(['orgx_record_decision']);
    expect(map.find((surface) => surface.id === 'agents')?.control).toContain('orgx_delegate_work');
  });

  it('covers every current model-facing operation and excludes all app-only callbacks', () => {
    const map = buildSurfaceMap({ visibleTools: [...manifestTools] });
    expect(new Set(mappedTools(map))).toEqual(new Set([...manifestTools].filter((tool) => !isWidgetOnlyTool(tool))));
    for (const profile of ['v2', 'chatgpt', 'claude-directory', 'extended', 'legacy', 'claude-directory-legacy', 'claude-plugin']) {
      const visibleTools = [...(resolveProfileToolSet(profile) ?? [])];
      const guidance = mappedTools(buildSurfaceMap({ visibleTools, profile }));
      for (const tool of WIDGET_ONLY_TOOL_IDS) expect(guidance, profile).not.toContain(tool);
    }
  });

  it('only names tools the server publishes', () => {
    expect(ORGX_SURFACES.length).toBeGreaterThan(5);
    for (const surface of ORGX_SURFACES) {
      for (const tool of [...surface.read, ...surface.control]) {
        expect(manifestTools.has(tool), `${surface.id} → ${tool}`).toBe(true);
      }
    }
  });

  it('has unique ids and paths', () => {
    const ids = ORGX_SURFACES.map((surface) => surface.id);
    const paths = ORGX_SURFACES.map((surface) => surface.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('filters tools to the session and resolves links against the web app', () => {
    const map = buildSurfaceMap({
      visibleTools: ['orgx_capture_decision', 'orgx_search'],
      webUrl: 'https://staging.useorgx.com',
    });
    const decisions = map.find((surface) => surface.id === 'decisions');
    expect(decisions).toMatchObject({
      url: 'https://staging.useorgx.com/decisions',
      read: ['orgx_search'],
      control: ['orgx_capture_decision'],
    });
    // Surfaces stay listed without visible tools so the human can be sent there.
    expect(map.find((surface) => surface.id === 'execution')).toMatchObject({
      read: [],
      control: [],
    });
  });

  it('falls back to the public web app for a missing or bad URL', () => {
    expect(buildSurfaceMap({ visibleTools: [], webUrl: 'not a url' })[0].url).toBe(
      'https://useorgx.com/command'
    );
  });

  it('tells text-only agents where work lives in the bootstrap summary', () => {
    const text = formatForLLM('orgx_bootstrap', {
      profile: 'v2',
      visible_tools: ['orgx_capture_decision'],
      surfaces: buildSurfaceMap({ visibleTools: ['orgx_capture_decision'] }),
    });
    expect(text).toContain('Surfaces (where work lives');
    expect(text).toContain(
      '- Decisions: https://useorgx.com/decisions — change with orgx_capture_decision'
    );
    expect(text).toContain('- Work Ledger: https://useorgx.com/work-ledger');
  });
});
