import { describe, expect, it } from 'vitest';

import { buildInitiativeListWidgetPayload } from '../src/initiativeWidgetPayload';

describe('buildInitiativeListWidgetPayload', () => {
  it('adapts a single initiative row with nested workstreams into scaffold widget data', () => {
    const payload = {
      type: 'initiative',
      data: [
        {
          id: 'ini_12345678',
          title: 'Launch OrgX MCP widgets',
          status: 'active',
          workstreams: [
            {
              id: 'ws_12345678',
              title: 'Worker integration',
              milestones: [
                {
                  id: 'ms_12345678',
                  title: 'Wire list_entities',
                  tasks: [{ id: 'tsk_12345678', title: 'Return widget payload' }],
                },
              ],
            },
          ],
        },
      ],
      pagination: { total: 1, limit: 20, offset: 0, has_more: false },
      summary: 'initiatives: showing 1 of 1',
    };

    expect(buildInitiativeListWidgetPayload(payload)).toMatchObject({
      initiative: {
        id: 'ini_12345678',
        title: 'Launch OrgX MCP widgets',
      },
      hierarchy: {
        workstreams: [
          {
            id: 'ws_12345678',
            milestones: [
              {
                id: 'ms_12345678',
                tasks: [{ id: 'tsk_12345678' }],
              },
            ],
          },
        ],
      },
    });
  });

  it('preserves scaffold metadata already present on the payload', () => {
    const payload = {
      type: 'initiative',
      initiative: { id: 'ini_12345678', title: 'Existing scaffold' },
      hierarchy: {
        initiative: { id: 'ini_12345678', title: 'Existing scaffold' },
        workstreams: [{ id: 'ws_12345678', title: 'Ops' }],
      },
      data: [{ id: 'ini_12345678', title: 'Existing scaffold' }],
      agent_assignment: {
        assignments: [{ workstream_id: 'ws_12345678', domain: 'operations' }],
      },
    };

    expect(buildInitiativeListWidgetPayload(payload)).toMatchObject({
      initiative: { id: 'ini_12345678' },
      hierarchy: { workstreams: [{ id: 'ws_12345678' }] },
      agent_assignment: {
        assignments: [{ workstream_id: 'ws_12345678', domain: 'operations' }],
      },
    });
  });

  it('skips non-initiative or multi-row payloads', () => {
    expect(
      buildInitiativeListWidgetPayload({
        type: 'decision',
        data: [{ id: 'dec_12345678' }],
      })
    ).toBeNull();

    expect(
      buildInitiativeListWidgetPayload({
        type: 'initiative',
        data: [{ id: 'ini_1' }, { id: 'ini_2' }],
      })
    ).toBeNull();
  });
});
