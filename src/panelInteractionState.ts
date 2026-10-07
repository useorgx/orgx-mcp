import type { z } from 'zod';
import type { WIDGET_OUTPUT_SCHEMAS } from './openaiOutputSchemas/widgets';

type CommandStatus = z.infer<(typeof WIDGET_OUTPUT_SCHEMAS)['orgx_command_status']>;
export type RulingPhase = 'saving' | 'waiting' | 'recorded' | 'confirmed' | 'rejected' | 'failed' | 'elsewhere';
export type RulingAction = 'approve' | 'reject';
export type StatusTransition =
  | { phase: 'waiting'; next: number }
  | { phase: 'recorded'; next: null }
  | { phase: 'elsewhere'; next: null; status: string }
  | { phase: 'confirmed' | 'rejected' | 'failed'; next: null };

/** A receipt acknowledges the write. Only a matching terminal status confirms its outcome. */
export function statusTransition(value: unknown, id: string, action: RulingAction): StatusTransition {
  if (!value || typeof value !== 'object') return { phase: 'recorded', next: null };
  const status = value as Partial<CommandStatus>;
  if (status.kind !== 'decision' || status.id !== id) return { phase: 'recorded', next: null };
  if (status.next_poll_after_ms === null) {
    if (status.state === 'succeeded') {
      const outcome = String(status.outcome ?? '').toLowerCase();
      const approved = ['approved', 'accepted', 'confirmed'].includes(outcome);
      const rejected = ['rejected', 'declined', 'denied'].includes(outcome);
      if ((action === 'approve' && rejected) || (action === 'reject' && approved)) return { phase: 'elsewhere', next: null, status: outcome };
      return { phase: action === 'approve' ? 'confirmed' : 'rejected', next: null };
    }
    if (status.state === 'failed' || status.state === 'cancelled') return { phase: 'failed', next: null };
    return { phase: 'recorded', next: null };
  }
  if (['queued', 'held', 'running'].includes(status.state ?? '') &&
      typeof status.next_poll_after_ms === 'number' && Number.isFinite(status.next_poll_after_ms)) {
    return { phase: 'waiting', next: Math.min(Math.max(status.next_poll_after_ms, 400), 15000) };
  }
  return { phase: 'recorded', next: null };
}
