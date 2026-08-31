import { describe, expect, it } from 'vitest';

import {
  ControllerStatusEnvelopeSchema,
  validateControllerStatusEnvelope,
} from '../src/controllerStatusContract';
import { formatForLLM } from '../src/responseSummarizer';
import {
  buildControllerStatusEnvelope,
  buildNeverRunControllerStatusEnvelope,
  CONTROLLER_RECEIPT_ID,
  CONTROLLER_RUN_ID,
  CONTROLLER_WORKSPACE_ID,
} from './fixtures/controllerStatus';

const expectedRequest = {
  workspaceId: CONTROLLER_WORKSPACE_ID,
  domain: 'growth' as const,
  protocolVersion: 'orgx.controller.v1' as const,
};

describe('controller status MCP response contract', () => {
  it('accepts the complete strict REST envelope and retains workspace metadata', () => {
    const envelope = buildControllerStatusEnvelope();

    expect(ControllerStatusEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(validateControllerStatusEnvelope(envelope, expectedRequest)).toEqual(
      { ok: true, envelope }
    );
  });

  it('accepts the app response builder\'s legitimate never-run sentinel shape', () => {
    const envelope = buildNeverRunControllerStatusEnvelope();

    expect(validateControllerStatusEnvelope(envelope, expectedRequest)).toEqual(
      { ok: true, envelope }
    );
  });

  it('rejects workspace and requested-domain mismatches', () => {
    const wrongWorkspace = buildControllerStatusEnvelope();
    wrongWorkspace.meta.workspaceId =
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      validateControllerStatusEnvelope(wrongWorkspace, expectedRequest)
    ).toMatchObject({
      ok: false,
      reason: 'request_mismatch',
      issues: [{ path: 'meta.workspaceId' }],
    });

    const wrongDomain = buildControllerStatusEnvelope();
    wrongDomain.data.domain = 'sales';
    const domainResult = validateControllerStatusEnvelope(
      wrongDomain,
      expectedRequest
    );
    expect(domainResult).toMatchObject({
      ok: false,
      reason: 'request_mismatch',
    });
    if (!domainResult.ok) {
      expect(domainResult.issues.map((issue) => issue.path)).toContain(
        'data.domain'
      );
    }

    const wrongController = buildControllerStatusEnvelope();
    wrongController.data.controller_id = 'domain.sales';
    if (wrongController.data.proposal) {
      wrongController.data.proposal.controllerId = 'domain.sales';
    }
    const controllerResult = validateControllerStatusEnvelope(
      wrongController,
      expectedRequest
    );
    expect(controllerResult).toMatchObject({
      ok: false,
      reason: 'request_mismatch',
    });
    if (!controllerResult.ok) {
      expect(controllerResult.issues.map((issue) => issue.path)).toContain(
        'data.controller_id'
      );
    }
  });

  it.each([
    {
      label: 'run identity on never-run status',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.run_id = CONTROLLER_RUN_ID;
      },
      path: 'data.run_id',
    },
    {
      label: 'last result on never-run status',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.last_result = 'noop';
      },
      path: 'data.last_result',
    },
    {
      label: 'event lineage on never-run status',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.event_ids = ['event-started'];
      },
      path: 'data.event_ids',
    },
  ])('rejects $label', ({ mutate, path }) => {
    const envelope =
      buildNeverRunControllerStatusEnvelope() as Record<string, any>;
    mutate(envelope);

    const result = validateControllerStatusEnvelope(envelope, expectedRequest);
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed_envelope',
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  it.each([
    {
      label: 'proposal result without proposal data',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.proposal = null;
      },
    },
    {
      label: 'proposal data with noop result',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.result = 'noop';
      },
    },
  ])('rejects $label', ({ mutate }) => {
    const envelope = buildControllerStatusEnvelope() as Record<string, any>;
    mutate(envelope);

    const result = validateControllerStatusEnvelope(envelope, expectedRequest);
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed_envelope',
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(
        'data.proposal'
      );
    }
  });

  it.each([
    {
      label: 'partial decision lineage',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.receipt_id = null;
      },
      path: 'data.decision_id',
    },
    {
      label: 'aliased decision lineage identities',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.decision_event_id =
          envelope.data.decision_id.toUpperCase();
      },
      path: 'data.decision_event_id',
    },
  ])('rejects $label', ({ mutate, path }) => {
    const envelope = buildControllerStatusEnvelope() as Record<string, any>;
    mutate(envelope);

    const result = validateControllerStatusEnvelope(envelope, expectedRequest);
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed_envelope',
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  it.each([
    {
      label: 'signal ID without state',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.last_signal_state = null;
      },
    },
    {
      label: 'signal state without ID',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.last_signal_id = null;
      },
    },
  ])('rejects $label', ({ mutate }) => {
    const envelope = buildControllerStatusEnvelope() as Record<string, any>;
    mutate(envelope);

    const result = validateControllerStatusEnvelope(envelope, expectedRequest);
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed_envelope',
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(
        'data.last_signal_state'
      );
    }
  });

  it.each([
    {
      label: 'protocol drift',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.protocol_version = 'orgx.controller.v2';
      },
      path: 'data.protocol_version',
    },
    {
      label: 'invalid result enum',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.result = 'proposal_emitted';
      },
      path: 'data.result',
    },
    {
      label: 'malformed source health',
      mutate: (envelope: Record<string, any>) => {
        envelope.data.source_health.recordCount = -1;
      },
      path: 'data.source_health.recordCount',
    },
    {
      label: 'unknown envelope field',
      mutate: (envelope: Record<string, any>) => {
        envelope.meta.untrusted = true;
      },
      path: 'meta',
    },
  ])('rejects $label', ({ mutate, path }) => {
    const envelope = buildControllerStatusEnvelope() as Record<string, any>;
    mutate(envelope);

    const result = validateControllerStatusEnvelope(
      envelope,
      expectedRequest
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed_envelope',
    });
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain(path);
    }
  });

  it('summarizes controller lineage fields for the model', () => {
    const data = buildControllerStatusEnvelope().data;
    const summary = formatForLLM('orgx_controller_status', data);

    expect(summary).toContain(`Run: ${CONTROLLER_RUN_ID}`);
    expect(summary).toContain('Result: proposal');
    expect(summary).toContain(
      'Signal: growth-allocation-pressure (observed)'
    );
    expect(summary).toContain(`Receipt: ${CONTROLLER_RECEIPT_ID}`);
    expect(summary).toContain('Projection cursor: 42');
  });
});
