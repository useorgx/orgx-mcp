import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildWorkspaceCreateBody } from '../src/workspaceTool';
import { CHATGPT_TOOL_DEFINITIONS } from '../src/toolDefinitions';

describe('workspace MCP create contract', () => {
  it('builds the /api/workspaces create body and defaults to active context', () => {
    const result = buildWorkspaceCreateBody({
      action: 'create',
      name: 'Chaos Riders',
      description: 'Cameroon-first racing MMO with founder pass rollout.',
      tagline: 'Race from Cameroon to the continent.',
      key_metrics: ['Founder pass conversion', 'Waitlist growth'],
      roadmap_url: 'https://example.com/roadmap',
      source_links: ['https://example.com/mockups'],
    });

    expect(result).toEqual({
      ok: true,
      setActive: true,
      body: {
        name: 'Chaos Riders',
        identity: {
          narrative: 'Cameroon-first racing MMO with founder pass rollout.',
          tagline: 'Race from Cameroon to the continent.',
          keyMetrics: ['Founder pass conversion', 'Waitlist growth'],
          roadmapUrl: 'https://example.com/roadmap',
          sourceLinks: ['https://example.com/mockups'],
        },
      },
    });
  });

  it('requires a name for workspace creation', () => {
    expect(buildWorkspaceCreateBody({ action: 'create' })).toEqual({
      ok: false,
      error: 'name is required when workspace action=create',
    });
  });

  it('advertises create as a workspace action', () => {
    const workspaceTool = CHATGPT_TOOL_DEFINITIONS.find(
      (tool) => tool.id === 'workspace'
    );
    expect(workspaceTool).toBeDefined();

    const schema = workspaceTool!.inputSchema as Record<string, z.ZodTypeAny>;
    expect(() => schema.action.parse('create')).not.toThrow();
    expect(schema.name).toBeDefined();
    expect(schema.set_active).toBeDefined();
  });
});
