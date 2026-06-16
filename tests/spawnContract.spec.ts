import { describe, expect, it } from 'vitest';

import { validateSpawnContract } from '../src/spawnContract';

describe('validateSpawnContract', () => {
  it('spawn: accepts task_id, or title + instructions; rejects neither', () => {
    expect(validateSpawnContract('spawn', { task_id: 't1' }).ok).toBe(true);
    expect(validateSpawnContract('spawn', { title: 'x', instructions: 'do x' }).ok).toBe(true);
    expect(validateSpawnContract('spawn', { title: 'x' }).ok).toBe(false); // missing instructions
    const r = validateSpawnContract('spawn', {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/task_id.*title.*instructions/i);
  });

  it('defaults action to spawn when omitted', () => {
    expect(validateSpawnContract('', {}).ok).toBe(false);
    expect(validateSpawnContract('', { task_id: 't1' }).ok).toBe(true);
  });

  it('handoff: requires task_id AND agent_type', () => {
    expect(validateSpawnContract('handoff', { task_id: 't', agent_type: 'eng' }).ok).toBe(true);
    expect(validateSpawnContract('handoff', { task_id: 't' }).ok).toBe(false);
    expect(validateSpawnContract('handoff', { agent_type: 'eng' }).ok).toBe(false);
  });

  it('guard: requires agent_type', () => {
    expect(validateSpawnContract('guard', { agent_type: 'eng' }).ok).toBe(true);
    expect(validateSpawnContract('guard', {}).ok).toBe(false);
  });

  it('classify/estimate: require title or task_id', () => {
    expect(validateSpawnContract('classify', { title: 'x' }).ok).toBe(true);
    expect(validateSpawnContract('estimate', { task_id: 't' }).ok).toBe(true);
    expect(validateSpawnContract('classify', {}).ok).toBe(false);
    expect(validateSpawnContract('estimate', {}).ok).toBe(false);
  });

  it('ignores whitespace-only strings (treats them as missing)', () => {
    expect(validateSpawnContract('guard', { agent_type: '   ' }).ok).toBe(false);
  });

  it('passes unknown actions through (handled elsewhere)', () => {
    expect(validateSpawnContract('something_else', {}).ok).toBe(true);
  });
});
