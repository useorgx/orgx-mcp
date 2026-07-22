import type { Event } from '@sentry/cloudflare';
import { describe, expect, it } from 'vitest';

import { EXPECTED_DURABLE_OBJECT_DEPLOY_RESET } from '../src/durableObjectTransportRecovery';
import { createSentryOptions } from '../src/sentryConfig';

function beforeSend(event: Event) {
  const hook = createSentryOptions({
    SENTRY_DSN: 'https://public@example.invalid/1',
  })?.beforeSend;
  if (!hook) throw new Error('beforeSend hook is unavailable');
  return hook(event, {});
}

describe('Sentry worker filtering', () => {
  it('drops only the exact Durable Object deployment-reset sentinel', async () => {
    const result = await beforeSend({
      exception: {
        values: [
          {
            type: 'Error',
            value: EXPECTED_DURABLE_OBJECT_DEPLOY_RESET,
          },
        ],
      },
    });

    expect(result).toBeNull();
  });

  it.each([
    `${EXPECTED_DURABLE_OBJECT_DEPLOY_RESET} extra context`,
    'Durable Object storage operation exceeded timeout which caused object to be reset.',
    'internal error; reference = provider-reference',
  ])('preserves real or non-exact errors: %s', async (value) => {
    const event: Event = {
      exception: { values: [{ type: 'Error', value }] },
    };

    expect(await beforeSend(event)).toMatchObject(event);
  });
});
