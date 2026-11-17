import { afterEach, describe, expect, it, vi } from 'vitest';
import { withWorkerRequestTiming, workerRequestStartedAt, workerTimingPerformance } from '../src/workerRequestTiming';

describe('Worker ingress timing boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('includes time before authenticated transport without replacing its measurements', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const result = await withWorkerRequestTiming(async () => {
      now.mockReturnValue(1100);
      await Promise.resolve();
      return workerTimingPerformance(1100, 20, 80, 30);
    });
    expect(result).toEqual({ worker_pre_transport_ms: 100, worker_response_headers_ms: 120,
      worker_full_response_ms: 180, worker_first_response_byte_ms: 130 });
    expect(workerRequestStartedAt()).toBeUndefined();
    expect(workerTimingPerformance(1100, 20, 80, 30)).toEqual({});
  });
  it('keeps overlapping fetch boundaries isolated through asynchronous response observation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const first = withWorkerRequestTiming(async () => {
      await pause;
      return workerTimingPerformance(1100, 20, 80);
    });
    now.mockReturnValue(2000);
    const second = withWorkerRequestTiming(async () => {
      await pause;
      return workerTimingPerformance(2300, 20, 80);
    });
    release();
    expect(await first).toEqual({ worker_pre_transport_ms: 100, worker_response_headers_ms: 120, worker_full_response_ms: 180 });
    expect(await second).toEqual({ worker_pre_transport_ms: 300, worker_response_headers_ms: 320, worker_full_response_ms: 380 });
  });
});
