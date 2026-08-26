import { describe, expect, it } from 'vitest';

import {
  assessEvidenceCoverage,
  buildExecutionGraphEmission,
  evaluateAssuranceValidity,
  findUnaccountedBranches,
  promoteOtelEvents,
  type AssuranceDigests,
} from '../src/agenticScaleProof';

const digests: AssuranceDigests = {
  subject: 'sha256:subject',
  context: 'sha256:context-v1',
  policy: 'sha256:policy-v1',
  evaluator: 'sha256:evaluator',
  runtime: 'sha256:runtime',
  evidence: 'sha256:evidence',
  independence: 'sha256:independence',
};

describe('Agentic Scale Proof contracts', () => {
  it('promotes only explicitly material semantic OTel events', () => {
    const result = promoteOtelEvents([
      {
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'tool.execute',
        timestamp: '2026-08-26T15:00:00.000Z',
        attributes: {
          'orgx.material': true,
          'orgx.episode.id': 'episode-1',
          'orgx.semantic.kind': 'effect',
          'orgx.trust.tier': 'runtime_observed',
        },
      },
      {
        traceId: 'trace-1',
        spanId: 'span-2',
        name: 'llm.token',
        timestamp: '2026-08-26T15:00:01.000Z',
        attributes: { token_count: 42 },
      },
      {
        traceId: 'trace-1',
        spanId: 'span-3',
        name: 'extracted.decision',
        timestamp: '2026-08-26T15:00:02.000Z',
        attributes: {
          'orgx.material': true,
          'orgx.episode.id': 'episode-1',
          'orgx.semantic.kind': 'decision',
          'orgx.trust.tier': 'inferred',
        },
      },
    ]);

    expect(result).toMatchObject({
      rawCount: 3,
      promotedCount: 1,
      droppedCount: 2,
    });
    expect(result.nodes[0]).toMatchObject({ kind: 'effect', episodeId: 'episode-1' });
    expect(result.gaps).toEqual([
      {
        sourceRef: 'otel://trace-1/span-3',
        reason: 'inferred_event_not_promoted',
      },
    ]);
  });

  it('promotes OTel at the execution-graph boundary and strips raw events', () => {
    const result = buildExecutionGraphEmission({
      initiative_id: 'initiative-1',
      otel_events: [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'database.write',
          timestamp: '2026-08-26T15:00:00.000Z',
          attributes: {
            'orgx.material': true,
            'orgx.episode.id': 'episode-1',
            'orgx.semantic.kind': 'effect',
            'orgx.trust.tier': 'runtime_observed',
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.body).not.toHaveProperty('otel_events');
    expect(result.body.nodes).toEqual([
      expect.objectContaining({
        id: 'otel://trace-1/span-1',
        title: 'Semantic effect',
        requires_evidence: true,
        verification: expect.objectContaining({ state: 'unverified' }),
      }),
    ]);
    expect(result.body.metadata).toMatchObject({
      otel_semantic_promotion: {
        raw_count: 1,
        promoted_count: 1,
        dropped_count: 0,
        gaps: [],
      },
    });
  });

  it('fails closed when OTel contains only inferred material', () => {
    const result = buildExecutionGraphEmission({
      otel_events: [
        {
          traceId: 'trace-1',
          spanId: 'span-1',
          name: 'extracted.decision',
          timestamp: '2026-08-26T15:00:00.000Z',
          attributes: {
            'orgx.material': true,
            'orgx.episode.id': 'episode-1',
            'orgx.semantic.kind': 'decision',
            'orgx.trust.tier': 'inferred',
          },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unverifiable_otel_emission',
      status: 422,
    });
  });

  it('fails evidence completeness visibly instead of treating a hash as truth', () => {
    expect(
      assessEvidenceCoverage([
        { id: 'authorization', required: true, observedRef: 'receipt://auth' },
        { id: 'external-effect', required: true, gapState: 'out_of_band_effect' },
        { id: 'customer-acceptance', required: false, gapState: 'known_gap' },
      ])
    ).toEqual({
      state: 'out_of_band_effect',
      expected: 3,
      required: 2,
      observed: 1,
      missingRequired: ['external-effect'],
      knownGaps: [
        'external-effect:out_of_band_effect',
        'customer-acceptance:known_gap',
      ],
    });
  });

  it('requires dispositions and an adoption receipt for every material branch', () => {
    expect(
      findUnaccountedBranches([
        { id: 'a', material: true, disposition: 'rejected' },
        { id: 'b', material: true, disposition: 'adopted' },
        {
          id: 'c',
          material: true,
          disposition: 'adopted',
          selectionReceiptRef: 'receipt://selection-c',
        },
        { id: 'scratch', material: false },
      ])
    ).toEqual(['b']);
  });

  it('invalidates only the assurance dependencies that changed', () => {
    const result = evaluateAssuranceValidity({
      snapshot: {
        id: 'assurance-1',
        digests,
        issuedAt: '2026-08-26T15:00:00.000Z',
        expiresAt: '2026-08-27T15:00:00.000Z',
      },
      current: { ...digests, policy: 'sha256:policy-v2' },
      now: '2026-08-26T16:00:00.000Z',
    });

    expect(result).toEqual({
      state: 'stale',
      invalidatedBy: ['policy'],
      reasons: ['policy_digest_changed'],
    });
  });

  it('fails closed for missing snapshots, dependencies, and expiry', () => {
    expect(
      evaluateAssuranceValidity({ current: digests, now: '2026-08-26T16:00:00.000Z' })
    ).toMatchObject({ state: 'unverifiable' });

    expect(
      evaluateAssuranceValidity({
        snapshot: {
          id: 'assurance-1',
          digests,
          issuedAt: '2026-08-24T15:00:00.000Z',
          expiresAt: '2026-08-25T15:00:00.000Z',
        },
        current: digests,
        now: '2026-08-26T16:00:00.000Z',
      })
    ).toMatchObject({ state: 'expired' });

    const { runtime: _runtime, ...missingRuntime } = digests;
    expect(
      evaluateAssuranceValidity({
        snapshot: {
          id: 'assurance-1',
          digests,
          issuedAt: '2026-08-26T15:00:00.000Z',
          expiresAt: '2026-08-27T15:00:00.000Z',
        },
        current: missingRuntime,
        now: '2026-08-26T16:00:00.000Z',
      })
    ).toMatchObject({
      state: 'unverifiable',
      invalidatedBy: ['runtime'],
    });
  });
});
