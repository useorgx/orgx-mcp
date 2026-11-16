import { describe, expect, it, vi } from 'vitest';
import { createBrokerIoBudget, readBrokerBody } from '../src/broker/brokerIoBudget';

describe('broker body resource budget', () => {
  it('coalesces tiny UTF-8 chunks under one deadline subscription', async () => {
    const expected = 'tiny-chunk-界😀'.repeat(1_000);
    const bytes = new TextEncoder().encode(expected);
    let position = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position === bytes.byteLength) controller.close();
        else controller.enqueue(bytes.subarray(position, ++position));
      },
    });
    const budget = createBrokerIoBudget(8_000);
    const run = vi.spyOn(budget, 'run');
    try {
      expect(await readBrokerBody(body, bytes.byteLength, budget)).toBe(expected);
      // The number of retained deadline reactions stays constant as chunks grow.
      expect(run).toHaveBeenCalledOnce();
    } finally { budget.close(); }
  });

  it('cancels a stalled reader without awaiting a stalled cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const budget = createBrokerIoBudget(8_000);
    try {
      const pending = readBrokerBody(body, 1024, budget);
      const rejected = expect(pending).rejects.toThrow('body_timeout');
      await vi.advanceTimersByTimeAsync(8_000);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally { budget.close(); vi.useRealTimers(); }
  });
});
