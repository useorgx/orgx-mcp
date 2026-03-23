import { describe, expect, it } from 'vitest';

import { resolveLifecycleActionAlias } from '../src/toolDefinitions';

describe('resolveLifecycleActionAlias', () => {
  it('maps launch to the entity-specific lifecycle action', () => {
    expect(resolveLifecycleActionAlias('task', 'launch')).toBe('start');
    expect(resolveLifecycleActionAlias('milestone', 'launch')).toBe('start');
    expect(resolveLifecycleActionAlias('initiative', 'launch')).toBe('launch');
  });

  it('maps pause to the entity-specific lifecycle action', () => {
    expect(resolveLifecycleActionAlias('stream', 'pause')).toBe('block');
    expect(resolveLifecycleActionAlias('task', 'pause')).toBe('block');
    expect(resolveLifecycleActionAlias('initiative', 'pause')).toBe('pause');
  });

  it('leaves non-aliased actions unchanged', () => {
    expect(resolveLifecycleActionAlias('task', 'complete')).toBe('complete');
    expect(resolveLifecycleActionAlias('task', 'resume')).toBe('resume');
    expect(resolveLifecycleActionAlias('task', undefined)).toBeUndefined();
  });
});
