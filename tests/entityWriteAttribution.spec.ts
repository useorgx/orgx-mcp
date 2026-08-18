import { describe, expect, it } from 'vitest';

import {
  applyEntityWriteAttribution,
  ATTRIBUTABLE_ENTITY_TYPES,
} from '../src/entityWriteAttribution';

describe('entityWriteAttribution', () => {
  it('defaults metadata.source_client on an attributable entity write', () => {
    const body = applyEntityWriteAttribution(
      { type: 'task', title: 'Ship it' },
      'claude-code'
    );

    expect(body).toEqual({
      type: 'task',
      title: 'Ship it',
      metadata: { source_client: 'claude-code' },
    });
  });

  it('merges into existing metadata instead of replacing it', () => {
    const body = applyEntityWriteAttribution(
      { type: 'artifact', metadata: { idempotency_key: 'k-1' } },
      'codex'
    );

    expect(body.metadata).toEqual({
      idempotency_key: 'k-1',
      source_client: 'codex',
    });
  });

  it('also stamps source_system for decisions (its own column)', () => {
    const body = applyEntityWriteAttribution(
      { type: 'decision', title: 'Pick a lane' },
      'chatgpt'
    );

    expect(body.source_system).toBe('chatgpt');
    expect(body.metadata).toEqual({ source_client: 'chatgpt' });
  });

  it('never sets a top-level source_system on non-decision types', () => {
    const body = applyEntityWriteAttribution({ type: 'task' }, 'codex');
    expect(body.source_system).toBeUndefined();
  });

  it('never overrides explicitly supplied attribution', () => {
    const body = applyEntityWriteAttribution(
      {
        type: 'decision',
        source_system: 'explicit-system',
        metadata: { source_client: 'explicit-client' },
      },
      'codex'
    );

    expect(body.source_system).toBe('explicit-system');
    expect(body.metadata).toEqual({ source_client: 'explicit-client' });
  });

  it('leaves types outside the allowlist untouched', () => {
    const body = { type: 'blocker', run_id: 'r-1' };
    expect(applyEntityWriteAttribution(body, 'codex')).toBe(body);
    expect(ATTRIBUTABLE_ENTITY_TYPES.has('blocker')).toBe(false);
  });

  it('is a no-op with no resolvable client', () => {
    const body = { type: 'task' };
    expect(applyEntityWriteAttribution(body, null)).toBe(body);
    expect(applyEntityWriteAttribution(body, '  ')).toBe(body);
  });
});
