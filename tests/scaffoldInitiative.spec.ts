import { describe, expect, it } from 'vitest';

import { buildScaffoldInitiativeBatch } from '../src/scaffoldInitiative';

describe('buildScaffoldInitiativeBatch', () => {
  it('strips reserved _context while preserving entity context', () => {
    const result = buildScaffoldInitiativeBatch({
      title: 'Launch OrgX MCP',
      summary: 'Record the demo flow',
      workspace_id: 'ws-123',
      context: [
        {
          type: 'url',
          url: 'https://useorgx.com/blog/orgx-mcp-launch',
          note: 'Launch post',
        },
      ],
      _context: {
        client: {
          name: 'claude',
          version: '1.0.0',
        },
        conversation: {
          id: 'conv-123',
        },
      },
      workstreams: [
        {
          title: 'Engineering',
          milestones: [
            {
              title: 'Worker ready',
              tasks: [{ title: 'Ship worker' }],
            },
          ],
        },
      ],
    });

    expect(result.batch).toHaveLength(4);

    const initiative = result.batch[0];
    expect(initiative).toMatchObject({
      type: 'initiative',
      title: 'Launch OrgX MCP',
      summary: 'Record the demo flow',
      workspace_id: 'ws-123',
      context: [
        {
          type: 'url',
          url: 'https://useorgx.com/blog/orgx-mcp-launch',
          note: 'Launch post',
        },
      ],
    });
    expect(initiative).not.toHaveProperty('_context');
  });
});
