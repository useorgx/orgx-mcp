import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getWorkflowToolContract } from '../src/workflowTools';
import { INFORMATIONAL_SURFACE, resolveProfileToolSet } from '../src/toolProfiles';
import { buildWorkOutputAttachmentRequest, readWorkOutputAttachmentAcknowledgement } from '../src/workOutputAttachment';

const ID = 'd726e405-461e-4643-bd57-b16b364e4f32';
const KEY = 'campaign:output:v1';
const artifact = { name: 'Campaign plan', artifact_type: 'product.report', location: { external_url: 'https://example.com/plan.pdf' }, output_front_door: { answer: 'Confirm the launch date.', checked: ['Brief'], notChecked: ['Client acceptance'] } };
const tool = getWorkflowToolContract('orgx_update_work')!;
const parse = (args: Record<string, unknown>) => z.object(tool.inputSchema).strict().parse(args);

describe('existing update operation output attachment', () => {
  it('preserves content update routing and adds one bounded attachment branch', () => {
    expect(tool.toCanonicalArgs(parse({ type: 'task', id: ID, fields: { title: 'Updated' }, idempotency_key: KEY }))).toMatchObject({ operation: 'update', fields: { title: 'Updated' } });
    const args = tool.toCanonicalArgs(parse({ type: 'task', id: ID, artifact, idempotency_key: KEY }));
    expect(buildWorkOutputAttachmentRequest(args)).toEqual({ body: { type: 'task', id: ID, artifact: { ...artifact, output_front_door: { ...artifact.output_front_door, decisions: [] } } }, idempotencyKey: KEY });
  });

  it('rejects missing/compound writes and absent stable retry keys', () => {
    for (const args of [{}, { fields: { title: 'Changed' }, artifact }])
      expect(() => tool.toCanonicalArgs(parse({ type: 'task', id: ID, idempotency_key: KEY, ...args }))).toThrow('exactly one');
    expect(() => parse({ type: 'task', id: ID, artifact })).toThrow();
  });

  it('rejects producer authority fields and more than three linked decisions', () => {
    for (const extra of [{ status: 'approved' }, { metadata: {} }, { created_by_id: ID }, { output_front_door: { answer: 'Ready', context: {} } }, { output_front_door: { answer: 'Ready', receipt: { costUsd: 0 } } }, { output_front_door: { answer: 'Ready', decisions: Array.from({ length: 4 }, () => ({ decisionId: ID, question: 'When?', recommendation: 'Now', impact: 'Soon' })) } }])
      expect(() => parse({ type: 'task', id: ID, artifact: { ...artifact, ...extra }, idempotency_key: KEY })).toThrow();
  });

  it('does not accept a malformed or acceptance-claiming server acknowledgement', () => {
    const acknowledgement = { data: { artifact: { id: ID }, duplicate: false, review_url: `/artifacts/${ID}`, accepted: false, completed: false } };
    expect(readWorkOutputAttachmentAcknowledgement(acknowledgement)).toEqual(acknowledgement.data);
    expect(() => readWorkOutputAttachmentAcknowledgement({ data: { ...acknowledgement.data, accepted: true } })).toThrow();
    expect(() => readWorkOutputAttachmentAcknowledgement({ data: { ...acknowledgement.data, artifact: {} } })).toThrow();
  });

  it('gives the native OAuth client only the seven reads and this existing write operation', () => {
    expect([...(resolveProfileToolSet('claude-code') ?? [])].sort()).toEqual([...INFORMATIONAL_SURFACE, 'orgx_update_work'].sort());
    expect(resolveProfileToolSet('commander')?.has('orgx_update_work')).toBe(true);
    expect(resolveProfileToolSet('read-only')?.has('orgx_update_work')).toBe(false);
  });
});
