import type { ControllerStatusEnvelope } from '../../src/controllerStatusContract';

export const CONTROLLER_WORKSPACE_ID =
  '11111111-1111-4111-8111-111111111111';
export const CONTROLLER_RUN_ID = `controller_run:${'a'.repeat(64)}`;
export const CONTROLLER_SPEC_REVISION =
  `controller_spec_revision:${'b'.repeat(64)}`;
export const CONTROLLER_RECEIPT_ID =
  '55555555-5555-4555-8555-555555555555';

export function buildControllerStatusEnvelope(): ControllerStatusEnvelope {
  return {
    data: {
      controller_id: 'domain.growth',
      domain: 'growth',
      spec_revision: CONTROLLER_SPEC_REVISION,
      run_id: CONTROLLER_RUN_ID,
      last_run_id: CONTROLLER_RUN_ID,
      status: 'healthy',
      result: 'proposal',
      last_result: 'proposal',
      last_signal_id: 'growth-allocation-pressure',
      last_signal_state: 'observed',
      last_error_code: null,
      event_ids: [
        '66666666-6666-4666-8666-666666666666',
        '77777777-7777-4777-8777-777777777777',
      ],
      projection_cursor: '42',
      decision_id: '33333333-3333-4333-8333-333333333333',
      decision_event_id: '44444444-4444-4444-8444-444444444444',
      receipt_id: CONTROLLER_RECEIPT_ID,
      last_receipt_id: CONTROLLER_RECEIPT_ID,
      duplicate: false,
      protocol_version: 'orgx.controller.v1',
      mode: 'shadow',
      proposal: {
        proposalId: `controller_decision_proposal:${'c'.repeat(64)}`,
        controllerId: 'domain.growth',
        domain: 'growth',
        specRevision: CONTROLLER_SPEC_REVISION,
        decisionType: 'growth_allocation_adjustment',
        title: 'Shift growth allocation toward evidence-producing work',
        summary:
          'The observed allocation is below the configured evidence-producing threshold.',
        priority: 'medium',
        recommendedAction:
          'Review the proposed allocation change before authorizing execution.',
        signalRef: {
          id: 'growth-allocation-pressure',
          digest: `sha256:${'d'.repeat(64)}`,
        },
        createdAt: '2026-08-30T18:00:00.000Z',
        requiresHumanDecision: true,
        authorityEffect: 'none',
      },
      learning_proposal: null,
      noop_reason: null,
      source_health: {
        state: 'healthy',
        observedAt: '2026-08-30T17:59:00.000Z',
        freshnessWatermark: '2026-08-30T17:58:00.000Z',
        sourceCursor: 'growth-source:42',
        recordCount: 12,
        limitations: [],
      },
      limitations: [
        'Shadow mode: proposals do not authorize or dispatch work.',
      ],
    },
    meta: {
      apiVersion: '1',
      workspaceId: CONTROLLER_WORKSPACE_ID,
    },
  };
}

export function buildNeverRunControllerStatusEnvelope(): ControllerStatusEnvelope {
  const envelope = buildControllerStatusEnvelope();
  Object.assign(envelope.data, {
    run_id: null,
    last_run_id: null,
    status: 'never_run' as const,
    result: 'noop' as const,
    last_result: null,
    last_signal_id: null,
    last_signal_state: null,
    last_error_code: null,
    event_ids: [],
    projection_cursor: '0',
    decision_id: null,
    decision_event_id: null,
    receipt_id: null,
    last_receipt_id: null,
    duplicate: false,
    proposal: null,
    learning_proposal: null,
    noop_reason: null,
    source_health: null,
  });
  return envelope;
}
