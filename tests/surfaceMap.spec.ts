import { describe, expect, it } from 'vitest';

import serverManifest from '../server.json';
import { formatForLLM } from '../src/responseSummarizer';
import { ORGX_SURFACES, buildSurfaceMap } from '../src/surfaceMap';
import { CLAUDE_DIRECTORY_SURFACE } from '../src/toolProfiles';

const manifestTools = new Set(serverManifest.tools.map((tool) => tool.name));

describe('OrgX surface map', () => {
  it('maps directory operations to the product surfaces they read and control', () => {
    const map = buildSurfaceMap({
      visibleTools: CLAUDE_DIRECTORY_SURFACE,
      profile: 'claude-directory',
    });
    expect(map.find((surface) => surface.id === 'initiatives')).toMatchObject({
      read: ['orgx_inspect', 'get_initiative_pulse', 'orgx_read_plan'],
      control: [
        'orgx_start_plan', 'orgx_improve_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
        'orgx_create_entity', 'orgx_update_entity', 'orgx_change_entity_state',
        'orgx_complete_with_proof', 'manage_lifecycle',
      ],
    });
    expect(map.find((surface) => surface.id === 'decisions')).toMatchObject({
      read: ['orgx_search', 'orgx_inspect', 'orgx_list_pending_decisions', 'orgx_open_decision_review'],
      control: ['orgx_record_decision'],
    });
    expect(map.find((surface) => surface.id === 'agents')?.control).toContain('orgx_delegate_work');
    expect(map.find((surface) => surface.id === 'quality')?.read).toContain('review_artifact');
    expect(map.flatMap((surface) => [...surface.read, ...surface.control])).not.toContain('resume_agent_run');
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

  it('keeps other profile maps on their existing canonical controls', () => {
    const visibleTools = [...manifestTools, ...CLAUDE_DIRECTORY_SURFACE];
    const defaultMap = buildSurfaceMap({ visibleTools });
    for (const profile of ['chatgpt', 'v2', 'claude-plugin', 'read-only']) {
      expect(buildSurfaceMap({ visibleTools, profile })).toEqual(defaultMap);
    }
    expect(defaultMap.find((surface) => surface.id === 'agents')?.control).toContain('orgx_spawn');
    expect(defaultMap.flatMap((surface) => surface.control)).not.toContain('orgx_delegate_work');
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
      visibleTools: ['orgx_decide', 'orgx_search'],
      webUrl: 'https://staging.useorgx.com',
    });
    const decisions = map.find((surface) => surface.id === 'decisions');
    expect(decisions).toMatchObject({
      url: 'https://staging.useorgx.com/decisions',
      read: ['orgx_search'],
      control: ['orgx_decide'],
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
      visible_tools: ['orgx_decide'],
      surfaces: buildSurfaceMap({ visibleTools: ['orgx_decide'] }),
    });
    expect(text).toContain('Surfaces (where work lives');
    expect(text).toContain(
      '- Decisions: https://useorgx.com/decisions — change with orgx_decide'
    );
    expect(text).toContain('- Work Ledger: https://useorgx.com/work-ledger');
  });
});
