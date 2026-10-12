import { describe, expect, it } from 'vitest';
import { buildCreateWorkCommandRequest, buildCompleteWorkCommandRequest } from '../src/workCommandContract';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';

describe('canonical v1 work wire parity', () => {
  it('leaves stable identity and the omitted inbox hierarchy to OrgX', () => {
    const args = { title: 'Register proof', idempotency_key: 'stable-fixture' };
    const first = buildCreateWorkCommandRequest(args, { workspaceId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.body).not.toHaveProperty('command_id');
    expect(first.body).not.toHaveProperty('initiative_id');
    expect(buildCreateWorkCommandRequest(args, { workspaceId })).toEqual(first);
  });
  it('retains caller command identity and refuses a partial hierarchy', () => {
    const args = { title: 'Proof', command_id: taskId, idempotency_key: 'fixture' };
    const built = buildCreateWorkCommandRequest(args, { workspaceId });
    expect(built.ok && built.body.command_id).toBe(taskId);
    expect(buildCreateWorkCommandRequest({ ...args, initiative_id: taskId }, { workspaceId }).ok).toBe(false);
  });
  it.each([undefined, null, 0, 1.5])('preserves unknown versus measured duration: %s', (actual_hours) => {
    const args = { task_id: taskId, version_token: 'server-issued-token', idempotency_key: 'complete-fixture', ...(actual_hours === undefined ? {} : { actual_hours }) };
    const built = buildCompleteWorkCommandRequest(args, { workspaceId });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.version_token).toBe('server-issued-token');
    expect(built.body).not.toHaveProperty('expected_updated_at');
    expect(built.body).not.toHaveProperty('expected_aggregate_version');
    if (actual_hours === undefined) expect(built.body).not.toHaveProperty('actual_hours');
    else expect(built.body.actual_hours).toBe(actual_hours);
  });
  it.each([-1, 100001, Infinity, '1'])('refuses invalid measured duration %s', (actual_hours) => {
    expect(buildCompleteWorkCommandRequest({ task_id: taskId, version_token: 'server-issued-token', actual_hours }, { workspaceId })).toMatchObject({ ok: false, field: 'actual_hours' });
  });
  it('validates supplied raw versions even with a token', () => {
    expect(buildCompleteWorkCommandRequest({ task_id: taskId, version_token: 'server-issued-token', expected_aggregate_version: -1 }, { workspaceId })).toMatchObject({ ok: false, field: 'expected_aggregate_version' });
  });
  it.each(['', ' ', null, 42])('refuses an invalid supplied token %s', (version_token) => {
    expect(buildCompleteWorkCommandRequest({ task_id: taskId, version_token }, { workspaceId })).toMatchObject({ ok: false, field: 'version_token' });
  });
});
