import { describe, expect, it } from 'vitest';

import {
  resolveLifecycleActionAlias,
  resolveStreamToolPayload,
  summarizeStreamToolResult,
} from '../src/toolDefinitions';

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

describe('stream tool lifecycle result payload', () => {
  it('preserves the top-level lifecycle receipt instead of returning empty data', () => {
    const result = {
      ok: true,
      action: 'cancel',
      level: 'run',
      id: 'ddd37afb-21f7-4090-9b4e-453ba2e2ddd2',
      affected: {
        runs_cancelled: 1,
        tasks_updated: 0,
      },
      message: 'Cancelled 1 active run',
    };

    const payload = resolveStreamToolPayload('manage_lifecycle', result);

    expect(payload).toEqual(result);
    expect(summarizeStreamToolResult('manage_lifecycle', payload)).toContain(
      '"runs_cancelled": 1'
    );
  });

  it('keeps legacy stream endpoints on their nested data payload', () => {
    const payload = resolveStreamToolPayload('update_stream_progress', {
      ok: true,
      data: { progress_pct: 60, confidence: 0.8 },
    });

    expect(payload).toEqual({ progress_pct: 60, confidence: 0.8 });
    expect(summarizeStreamToolResult('update_stream_progress', payload)).toBe(
      'Progress updated (60%) - confidence: 80%'
    );
  });
});
