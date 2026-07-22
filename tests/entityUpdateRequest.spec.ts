import { describe, expect, it } from 'vitest';

import { buildEntityUpdateRequest } from '../src/entityUpdateRequest';

function readBody(request: ReturnType<typeof buildEntityUpdateRequest>) {
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function readIdempotencyHeader(
  request: ReturnType<typeof buildEntityUpdateRequest>
) {
  return new Headers(request.init.headers).get('Idempotency-Key');
}

describe('entity update request contract', () => {
  it('keeps orgx_act task retry controls out of validated entity fields', () => {
    const request = buildEntityUpdateRequest({
      type: 'task',
      id: 'c48d6af2-ff3e-45e7-9fbf-297b7ba8ce4c',
      fields: {
        metadata: { verification_status: 'passed' },
      },
      idempotencyKey: 'task-context-retention-proof-v1',
    });

    expect(request.path).toBe('/api/entities');
    expect(request.init.method).toBe('PATCH');
    expect(readIdempotencyHeader(request)).toBe(
      'task-context-retention-proof-v1'
    );
    expect(readBody(request)).toEqual({
      type: 'task',
      id: 'c48d6af2-ff3e-45e7-9fbf-297b7ba8ce4c',
      metadata: { verification_status: 'passed' },
    });
    expect(readBody(request)).not.toHaveProperty('idempotency_key');
  });

  it.each(['initiative', 'milestone', 'workstream'])(
    'separates retry controls for %s updates',
    (type) => {
      const request = buildEntityUpdateRequest({
        type,
        id: `${type}-1`,
        fields: { description: 'Updated description' },
        idempotencyKey: `retry-${type}-1`,
      });

      expect(readBody(request)).toEqual({
        type,
        id: `${type}-1`,
        description: 'Updated description',
      });
      expect(readIdempotencyHeader(request)).toBe(`retry-${type}-1`);
    }
  );

  it('uses the workspace endpoint without leaking retry controls into fields', () => {
    const request = buildEntityUpdateRequest({
      type: 'workspace',
      id: 'workspace/with space',
      fields: { tagline: 'Proof-backed execution' },
      idempotencyKey: 'workspace-update-1',
    });

    expect(request.path).toBe('/api/workspaces/workspace%2Fwith%20space');
    expect(readBody(request)).toEqual({ tagline: 'Proof-backed execution' });
    expect(readIdempotencyHeader(request)).toBe('workspace-update-1');
  });

  it('does not invent a retry header for unkeyed update callers', () => {
    const request = buildEntityUpdateRequest({
      type: 'task',
      id: 'task-1',
      fields: { title: 'Previewed title' },
      idempotencyKey: '   ',
    });

    expect(request.init.headers).toBeUndefined();
    expect(readIdempotencyHeader(request)).toBeNull();
  });

  it('preserves invalid fields supplied inside fields for API validation', () => {
    const request = buildEntityUpdateRequest({
      type: 'task',
      id: 'task-1',
      fields: { idempotency_key: 'not-a-valid-task-field' },
      idempotencyKey: 'request-control-key',
    });

    expect(readBody(request)).toEqual({
      type: 'task',
      id: 'task-1',
      idempotency_key: 'not-a-valid-task-field',
    });
    expect(readIdempotencyHeader(request)).toBe('request-control-key');
  });

  it('prevents fields from overriding the target type and id controls', () => {
    const request = buildEntityUpdateRequest({
      type: 'task',
      id: 'task-1',
      fields: { type: 'initiative', id: 'initiative-1', title: 'Safe patch' },
    });

    expect(readBody(request)).toEqual({
      type: 'task',
      id: 'task-1',
      title: 'Safe patch',
    });
  });
});
