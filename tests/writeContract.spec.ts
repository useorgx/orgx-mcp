import { describe, expect, it } from 'vitest';

import { validateWriteCreateContract } from '../src/writeContract';

describe('validateWriteCreateContract', () => {
  it('passes types with no enforced create rule (e.g. task) — auto-resolution respected', () => {
    expect(validateWriteCreateContract({ type: 'task', title: 'x' }).ok).toBe(true);
    expect(validateWriteCreateContract({ type: 'milestone' }).ok).toBe(true); // not enforced (caveat)
    expect(validateWriteCreateContract({ type: 'decision', title: 'x' }).ok).toBe(true);
  });

  it('workstream requires initiative_id', () => {
    expect(validateWriteCreateContract({ type: 'workstream', initiative_id: 'i1' }).ok).toBe(true);
    expect(validateWriteCreateContract({ type: 'workstream' }).ok).toBe(false);
  });

  it('blocker requires run_id', () => {
    expect(validateWriteCreateContract({ type: 'blocker', run_id: 'r1' }).ok).toBe(true);
    expect(validateWriteCreateContract({ type: 'blocker' }).ok).toBe(false);
  });

  it('artifact requires an attach target, artifact_type, and a real URL', () => {
    const valid = {
      type: 'artifact',
      task_id: 't1',
      artifact_type: 'doc',
      artifact_url: '/api/artifacts/1',
    };
    expect(validateWriteCreateContract(valid).ok).toBe(true);
    expect(validateWriteCreateContract({ ...valid, task_id: undefined, entity_type: 'task', entity_id: 'e1' }).ok).toBe(true);
    expect(validateWriteCreateContract({ ...valid, external_url: 'https://x', artifact_url: undefined }).ok).toBe(true);

    // missing attach target
    expect(validateWriteCreateContract({ type: 'artifact', artifact_type: 'doc', artifact_url: '/a' }).ok).toBe(false);
    // missing artifact_type
    expect(validateWriteCreateContract({ type: 'artifact', task_id: 't', artifact_url: '/a' }).ok).toBe(false);
    // preview_markdown alone is not a URL
    const noUrl = validateWriteCreateContract({ type: 'artifact', task_id: 't', artifact_type: 'doc', preview_markdown: '# x' });
    expect(noUrl.ok).toBe(false);
    expect(noUrl.message).toMatch(/artifact_url or external_url/);
  });
});
