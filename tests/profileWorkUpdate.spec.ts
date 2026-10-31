import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeProfileWorkUpdate, PROFILE_WORK_RETRY_CONTRACT } from '../src/profileWorkUpdate';
import { getWorkflowToolContract } from '../src/workflowTools';
import { CANONICAL_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/canonical';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const tool = getWorkflowToolContract('orgx_update_work')!;
const args = (input: Record<string, unknown>) => tool.toCanonicalArgs(z.object(tool.inputSchema).strict().parse({ idempotency_key: 'profile:update:v1', ...input }));
const bar = { type: 'quality_bar', id: 'marketing.content_pack', workspace_id: ID, fields: { patches: [{ part: 'line', value: 85 }] } };
const retry = { retry_contract: PROFILE_WORK_RETRY_CONTRACT, idempotency_key: 'profile:update:v1' };
const savedBar = { data: { draft: { id: OTHER, kindKey: bar.id, status: 'open', parts: {} }, created: false, publish: 'person_only', review_path: `/settings/quality/${bar.id}?tighten=criteria`, ...retry, idempotent_replay: false }, meta: { apiVersion: '1', workspaceId: ID } };

describe('quality bar drafts and workspace profile through update work', () => {
  it('posts bounded draft patches, retains the retry key and exposes the human publication gate', async () => {
    const request = vi.fn().mockResolvedValue(savedBar);
    const result = await executeProfileWorkUpdate(args(bar), request);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/quality-bars/drafts');
    expect(request.mock.calls[0]?.[1]).toEqual({ method: 'POST', headers: { 'Idempotency-Key': 'profile:update:v1' }, body: JSON.stringify({ kind_key: bar.id, patches: bar.fields.patches, workspace_id: ID, ...retry }) });
    expect(result.data).toMatchObject({ status: 'open', publish: 'person_only', review_path: savedBar.data.review_path });
    expect(CANONICAL_OUTPUT_SCHEMAS.orgx_write.safeParse(result).success).toBe(true);
  });

  it('patches only owner-editable profile fields and supports clearing the description', async () => {
    const request = vi.fn().mockResolvedValue({ data: { workspace: { id: ID, name: 'OrgX', description: null }, ...retry, idempotent_replay: true } });
    const result = await executeProfileWorkUpdate(args({ type: 'workspace', id: ID, fields: { name: 'OrgX', description: null } }), request);
    expect(request.mock.calls[0]).toEqual(['/api/v1/workspaces/profile', { method: 'PATCH', headers: { 'Idempotency-Key': 'profile:update:v1' }, body: JSON.stringify({ name: 'OrgX', description: null, workspace_id: ID, ...retry }) }]);
    expect(result.data).toMatchObject({ id: ID, description: null });
    expect(result.idempotent_replay).toBe(true);
    expect(CANONICAL_OUTPUT_SCHEMAS.orgx_write.safeParse(result).success).toBe(true);
  });

  it('rejects publication, cross-type patches and non-content workspace fields before a request', () => {
    for (const input of [
      { ...bar, fields: { patches: [{ part: 'publish' }] } },
      { ...bar, fields: { patches: [] } },
      { ...bar, fields: { title: 'Invalid' } },
      { ...bar, id: '../other' },
      { ...bar, fields: { patches: [{ part: 'line', value: 101 }] } },
      { type: 'task', id: ID, fields: bar.fields },
      { type: 'task', id: ID, fields: { description: null } },
      { type: 'workspace', id: ID, fields: { priority: 'high' } },
      { type: 'workspace', id: ID, workspace_id: OTHER, fields: { name: 'Other' } },
      { type: 'workspace', id: ID, fields: { name: 'x'.repeat(121) } },
      { type: 'workspace', id: ID, fields: { description: 'x'.repeat(2001) } },
      { type: 'workspace', id: ID, artifact: { name: 'Output', artifact_type: 'product.report', location: { external_url: 'https://example.com' } } },
    ]) expect(() => args(input), JSON.stringify(input)).toThrow();
  });

  it('does not turn missing, published or mismatched acknowledgements into success', async () => {
    for (const saved of [
      {},
      { ...savedBar.data, publish: 'agent' },
      { ...savedBar.data, draft: { ...savedBar.data.draft, status: 'published' } },
      { ...savedBar.data, draft: { ...savedBar.data.draft, kindKey: 'different' } },
      { ...savedBar.data, retry_contract: undefined },
      { ...savedBar.data, idempotency_key: 'different:key' },
    ]) await expect(executeProfileWorkUpdate(args(bar), vi.fn().mockResolvedValue({ data: saved }))).rejects.toThrow();
    await expect(executeProfileWorkUpdate(args({ type: 'workspace', id: ID, fields: { name: 'OrgX' } }), vi.fn().mockResolvedValue({ data: { workspace: { id: OTHER, name: 'Other', description: null } } }))).rejects.toThrow('does not match');
  });

  it('propagates a backend refusal without a second request or a legacy fallback', async () => {
    const request = vi.fn().mockRejectedValue(new Error('owner-only refusal'));
    await expect(executeProfileWorkUpdate(args(bar), request)).rejects.toThrow('owner-only refusal');
    expect(request).toHaveBeenCalledOnce();
  });

  it('makes pre-contract strict app endpoints refuse before their mutation handler', async () => {
    // Compatibility fixtures mirror the old app routes' strict top-level inputs.
    // New body controls must never be removed to accommodate those routes.
    const oldSchemas = {
      quality_bar: z.object({ kind_key: z.string(), patches: z.array(z.unknown()).optional(), workspace_id: z.string().uuid().optional(), work: z.unknown().optional() }).strict(),
      workspace: z.object({ name: z.string().optional(), description: z.string().nullable().optional(), workspace_id: z.string().uuid().optional() }).strict(),
    };
    for (const input of [bar, { type: 'workspace', id: ID, fields: { name: 'Changed' } }]) {
      const mutate = vi.fn();
      const schema = oldSchemas[input.type as keyof typeof oldSchemas];
      const request = vi.fn(async (_path: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        const { retry_contract: _contract, idempotency_key: _key, ...legacyBody } = body;
        expect(schema.safeParse(legacyBody).success).toBe(true);
        if (!schema.safeParse(body).success) throw new Error('Old strict endpoint refused retry controls');
        mutate();
        return {};
      });
      await expect(executeProfileWorkUpdate(args(input), request)).rejects.toThrow('Old strict endpoint');
      expect(request).toHaveBeenCalledOnce();
      expect(mutate).not.toHaveBeenCalled();
    }
  });
});
