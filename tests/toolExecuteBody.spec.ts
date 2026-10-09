import { describe, expect, it } from 'vitest';
import { buildToolExecuteBody } from '../src/toolExecuteBody';

describe('buildToolExecuteBody', () => {
  it('names the AI client from the MCP handshake', () => {
    expect(
      buildToolExecuteBody({
        toolId: 'widget_decide',
        args: { decision_id: 'd-1' },
        userId: 'u-1',
        clientName: ' chatgpt ',
      })
    ).toEqual({
      tool_id: 'widget_decide',
      args: { decision_id: 'd-1' },
      user_id: 'u-1',
      source_client: 'chatgpt',
    });
  });

  it('omits source_client when the handshake named no client', () => {
    const body = buildToolExecuteBody({
      toolId: 'orgx_search',
      args: {},
      userId: 'u-1',
      clientName: undefined,
    });
    expect(body).not.toHaveProperty('source_client');
  });
});
