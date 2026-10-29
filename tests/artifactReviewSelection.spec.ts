import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactReviewSelectionExhaustedError,
  selectArtifactForReview,
} from '../src/artifactReviewSelection';

function artifactPayload(
  id: string,
  options: {
    entityId?: string;
    status?: string;
    reviewRequired?: boolean;
    ruling?: string;
    metadata?: Record<string, unknown>;
    lineage?: string;
    canAdvance?: boolean;
    canReview?: boolean;
    modalityBlocked?: boolean;
  } = {}
) {
  return {
    artifact: {
      id,
      entity_id: options.entityId ?? 'entity-1',
      status: options.status ?? 'in_review',
      metadata: options.metadata ?? {},
    },
    reviewContract: {
      schemaVersion: 'artifact_review_contract.v1',
      purpose: { reviewRequired: options.reviewRequired ?? true },
      ruling: { state: options.ruling ?? 'pending' },
      lineage: { state: options.lineage ?? 'current' },
      workflow: { canAdvance: options.canAdvance ?? false },
      authority: { canReview: options.canReview ?? true },
      modalityGate: { blocksAdvance: options.modalityBlocked ?? false },
    },
  };
}

describe('canonical artifact review selection', () => {
  it('preserves explicit artifact inspection without applying queue filters', async () => {
    const explicit = artifactPayload('evidence-1', {
      entityId: 'other-entity',
      reviewRequired: false,
      ruling: 'none',
      status: 'approved',
    });
    const request = vi.fn(async () => explicit);

    await expect(
      selectArtifactForReview({
        request,
        explicitArtifactId: 'evidence-1',
        entityId: 'entity-1',
      })
    ).resolves.toBe(explicit);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/artifacts/evidence-1');
  });

  it('skips evidence-only rows and selects the next canonical review target', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/entities?')) {
        return {
          data: [{ id: 'evidence-1' }, { id: 'deliverable-1' }],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path === '/api/artifacts/evidence-1') {
        return artifactPayload('evidence-1', {
          reviewRequired: false,
          ruling: 'none',
        });
      }
      return artifactPayload('deliverable-1');
    });

    const selected = await selectArtifactForReview({ request });

    expect(selected?.artifact).toMatchObject({ id: 'deliverable-1' });
    expect(request.mock.calls[0]?.[0]).toContain('limit=50');
    expect(request.mock.calls[0]?.[0]).toContain(
      'fields=id%2Centity_type%2Centity_id%2Cmetadata'
    );
  });

  it('verifies entity scope against hydrated artifacts when collection scope is ignored', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/entities?')) {
        return {
          data: [
            { id: 'foreign-1', entity_id: 'entity-other' },
            { id: 'scoped-1', entity_id: 'entity-target' },
          ],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path === '/api/artifacts/foreign-1') {
        return artifactPayload('foreign-1', { entityId: 'entity-other' });
      }
      return artifactPayload('scoped-1', { entityId: 'entity-target' });
    });

    const selected = await selectArtifactForReview({
      request,
      entityId: 'entity-target',
    });

    expect(selected?.artifact).toMatchObject({ id: 'scoped-1' });
    const listPath = String(request.mock.calls[0]?.[0]);
    expect(listPath).not.toContain('entity_id=');
  });

  it('accepts known metadata scope links and rejects stale accepted candidates', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/entities?')) {
        return {
          data: [
            { id: 'accepted-1', entity_id: 'initiative-1' },
            {
              id: 'workstream-1',
              entity_id: 'initiative-1',
              metadata: { source_entity_id: 'workstream-target' },
            },
          ],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path === '/api/artifacts/accepted-1') {
        return artifactPayload('accepted-1', {
          entityId: 'initiative-1',
          ruling: 'accepted',
        });
      }
      return artifactPayload('workstream-1', {
        entityId: 'initiative-1',
        metadata: {
          source_entity_type: 'workstream',
          source_entity_id: 'workstream-target',
        },
      });
    });

    const selected = await selectArtifactForReview({
      request,
      entityId: 'workstream-target',
    });

    expect(selected?.artifact).toMatchObject({ id: 'workstream-1' });
  });

  it('discovers a legacy approved artifact whose canonical ruling is still pending', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes('status=approved')) {
        return {
          data: [{ id: 'legacy-approved-1', entity_id: 'entity-1' }],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path.startsWith('/api/entities?')) {
        return {
          data: [],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      return artifactPayload('legacy-approved-1', {
        status: 'approved',
        ruling: 'pending',
      });
    });

    await expect(selectArtifactForReview({ request })).resolves.toMatchObject({
      artifact: { id: 'legacy-approved-1', status: 'approved' },
      reviewContract: { ruling: { state: 'pending' } },
    });

    expect(
      request.mock.calls.some(([path]) =>
        String(path).includes('status=approved')
      )
    ).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/api/artifacts/legacy-approved-1'
    );
  });

  it('hydrates but excludes a truly accepted legacy approved artifact', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes('status=approved')) {
        return {
          data: [{ id: 'accepted-approved-1', entity_id: 'entity-1' }],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path.startsWith('/api/entities?')) {
        return {
          data: [],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      return artifactPayload('accepted-approved-1', {
        status: 'approved',
        ruling: 'accepted',
      });
    });

    await expect(selectArtifactForReview({ request })).resolves.toBeNull();

    expect(request).toHaveBeenCalledWith(
      '/api/artifacts/accepted-approved-1'
    );
  });

  it('rejects superseded and unauthorized candidates but keeps modality-blocked work reviewable', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/api/entities?')) {
        return {
          data: [
            { id: 'superseded-1', entity_id: 'entity-1' },
            { id: 'unauthorized-1', entity_id: 'entity-1' },
            { id: 'blocked-1', entity_id: 'entity-1' },
          ],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path === '/api/artifacts/superseded-1') {
        return artifactPayload('superseded-1', { lineage: 'superseded' });
      }
      if (path === '/api/artifacts/unauthorized-1') {
        return artifactPayload('unauthorized-1', { canReview: false });
      }
      return artifactPayload('blocked-1', { modalityBlocked: true });
    });

    await expect(selectArtifactForReview({ request })).resolves.toMatchObject({
      artifact: { id: 'blocked-1' },
      reviewContract: {
        modalityGate: { blocksAdvance: true },
      },
    });
  });

  it('continues through pagination and fails closed without a canonical target', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes('status=in_review') && path.includes('offset=0')) {
        return {
          data: [{ id: 'foreign-1', entity_id: 'entity-other' }],
          pagination: {
            limit: 1,
            offset: 0,
            has_more: true,
            next_offset: 1,
          },
        };
      }
      if (path.includes('status=in_review') && path.includes('offset=1')) {
        return {
          data: [{ id: 'evidence-1', entity_id: 'entity-target' }],
          pagination: { limit: 1, offset: 1, has_more: false },
        };
      }
      if (path.startsWith('/api/entities?')) {
        return {
          data: [],
          pagination: { limit: 50, offset: 0, has_more: false },
        };
      }
      if (path === '/api/artifacts/foreign-1') {
        return artifactPayload('foreign-1', { entityId: 'entity-other' });
      }
      return artifactPayload('evidence-1', {
        entityId: 'entity-target',
        reviewRequired: false,
        ruling: 'none',
      });
    });

    await expect(
      selectArtifactForReview({ request, entityId: 'entity-target' })
    ).resolves.toBeNull();

    expect(
      request.mock.calls.some(([path]) => String(path).includes('offset=1'))
    ).toBe(true);
  });
});
