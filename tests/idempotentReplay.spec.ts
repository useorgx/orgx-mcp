import { describe, expect, it } from 'vitest';

import {
  entityMatchesIdempotencyKey,
  readEntityIdempotencyKey,
} from '../src/idempotentReplay';

describe('idempotent replay matching', () => {
  it('reads flat metadata idempotency keys', () => {
    expect(
      readEntityIdempotencyKey({
        id: 'task-1',
        metadata: { idempotency_key: 'create-task-1' },
      })
    ).toBe('create-task-1');
  });

  it('reads scaffold metadata idempotency keys', () => {
    expect(
      readEntityIdempotencyKey({
        id: 'init-1',
        metadata: {
          scaffold: { idempotency_key: 'scaffold:crane-demo' },
        },
      })
    ).toBe('scaffold:crane-demo');
  });

  it('matches only exact non-empty replay keys', () => {
    const entity = {
      id: 'init-1',
      metadata: { idempotency_key: 'crane-gtm-design-partner-2026-06' },
    };

    expect(
      entityMatchesIdempotencyKey(
        entity,
        'crane-gtm-design-partner-2026-06'
      )
    ).toBe(true);
    expect(entityMatchesIdempotencyKey(entity, 'crane-gtm-design')).toBe(false);
    expect(entityMatchesIdempotencyKey(entity, '')).toBe(false);
  });
});
