import { describe, it, expect } from 'vitest';
import { buildContextPackRequestBody, isPackableAnchor } from '../src/contextPack';

describe('context pack helpers', () => {
  it('builds the app endpoint request body', () => {
    expect(buildContextPackRequestBody({ type: 'initiative', id: 'i1' })).toEqual({
      entity_type: 'initiative',
      entity_id: 'i1',
    });
  });

  it('treats only initiative/workstream/task (with an id) as packable', () => {
    expect(isPackableAnchor({ type: 'initiative', id: 'i1' })).toBe(true);
    expect(isPackableAnchor({ type: 'workstream', id: 'w1' })).toBe(true);
    expect(isPackableAnchor({ type: 'task', id: 't1' })).toBe(true);
    expect(isPackableAnchor({ type: 'plan_session', id: 'x' })).toBe(false);
    expect(isPackableAnchor({ type: 'initiative', id: '' })).toBe(false);
  });
});
