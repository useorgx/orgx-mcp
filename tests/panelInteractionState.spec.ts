import { describe, expect, it } from 'vitest';
import { statusTransition } from '../src/panelInteractionState';

const status = (state: string, next: number | null = null) => ({ kind: 'decision', id: 'd1', state, outcome: state === 'succeeded' ? 'approved' : null, next_poll_after_ms: next });
describe('a recorded ruling requires matching terminal evidence', () => {
  it.each(['queued', 'held', 'running', 'not_found', 'unknown'])('never confirms %s', (state) => {
    expect(statusTransition(status(state), 'd1', 'approve').phase).toBe('recorded');
  });
  it.each([null, {}, { ...status('succeeded'), id: 'other' }, { ...status('succeeded'), kind: 'run' }])('keeps absent or unrelated status uncertain', (value) => {
    expect(statusTransition(value, 'd1', 'approve').phase).toBe('recorded');
  });
  it('confirms only succeeded and final, and preserves rejection', () => {
    expect(statusTransition(status('succeeded'), 'd1', 'approve').phase).toBe('confirmed');
    expect(statusTransition({ ...status('succeeded'), outcome: 'declined' }, 'd1', 'reject').phase).toBe('rejected');
    expect(statusTransition(status('succeeded', 500), 'd1', 'approve').phase).toBe('recorded');
  });
  it.each(['failed', 'cancelled'])('does not claim success for %s', (state) => {
    expect(statusTransition(status(state), 'd1', 'approve').phase).toBe('failed');
  });
  it('bounds polling and rejects invalid timings', () => {
    expect(statusTransition(status('held', 10), 'd1', 'approve')).toEqual({ phase: 'waiting', next: 400 });
    expect(statusTransition(status('running', 99999), 'd1', 'approve').next).toBe(15000);
    expect(statusTransition(status('running', NaN), 'd1', 'approve').phase).toBe('recorded');
  });
  it('does not attribute an opposing outcome to the requested ruling', () => {
    expect(statusTransition({ ...status('succeeded'), outcome: 'declined' }, 'd1', 'approve')).toEqual({ phase: 'elsewhere', next: null, status: 'declined' });
    expect(statusTransition({ ...status('succeeded'), outcome: 'approved' }, 'd1', 'reject').phase).toBe('elsewhere');
  });
  it.each([undefined, null, 'expired', 'pending'])('keeps unrecognizable final outcome %s uncertain', (outcome) => {
    expect(statusTransition({ ...status('succeeded'), outcome }, 'd1', 'approve').phase).toBe('recorded');
  });
});
