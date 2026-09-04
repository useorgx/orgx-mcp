import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureDecision } from '../src/decisionCapture';
import { callOrgxApiJson } from '../src/orgxApi';

vi.mock('../src/orgxApi', () => ({ callOrgxApiJson: vi.fn() }));
const api = vi.mocked(callOrgxApiJson);
const workspace = '22222222-2222-4222-8222-222222222222';
const options = {
  env: { ORGX_API_URL: 'https://orgx.test', ORGX_SERVICE_KEY: 'fixture' },
  userId: 'authenticated-actor', workspaceId: workspace,
};
const args = { title: 'Require proof', decision: 'Only exact receipts establish completion.', context: 'Dispatch counts are insufficient.' };

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async () => Response.json({ decision: {
    id: '33333333-3333-4333-8333-333333333333', title: args.title, status: 'pending',
  } }));
});

describe('durable decision capture', () => {
  it('uses the scoped idempotent API and preserves decision text separately from rationale', async () => {
    const result = await captureDecision({ ...args, owner_id: 'spoofed', idempotency_key: 'capture-proof-001' }, options);
    const [, path, init, identity] = api.mock.calls[0];
    expect(path).toBe('/api/v1/decisions');
    expect(init.headers).toEqual({ 'Idempotency-Key': 'capture-proof-001' });
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: workspace, title: args.title,
      description: `${args.decision}\n\nContext: ${args.context}`,
      shape: 'generic', shape_context: { description: args.decision }, blocks_task: false,
    });
    expect(identity).toMatchObject({ userId: 'authenticated-actor', allowFallback: false });
    expect(result.structuredContent.message).toContain('Review state: pending');
    expect(result.structuredContent.message).toContain('does not approve work');
  });

  it('derives the same retry key for identical input and a different key for a changed decision', async () => {
    await captureDecision(args, options);
    await captureDecision(args, options);
    await captureDecision({ ...args, decision: 'Revised evidence rule' }, options);
    const keys = api.mock.calls.map((call) => new Headers(call[2].headers).get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^mcp-decision-[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('refuses missing identity, workspace, or decision before making a write', async () => {
    await expect(captureDecision(args, { ...options, userId: null })).rejects.toThrow();
    await expect(captureDecision(args, { ...options, workspaceId: null })).rejects.toThrow();
    await expect(captureDecision({}, options)).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });

  it('propagates conflict and uncertain write failures without replaying elsewhere', async () => {
    api.mockRejectedValue(new Error('409 idempotency_key_conflict'));
    await expect(captureDecision(args, options)).rejects.toThrow('idempotency_key_conflict');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('does not claim a successful record if the API returns no durable id', async () => {
    api.mockResolvedValue(Response.json({ decision: { title: args.title, status: 'pending' } }));
    await expect(captureDecision(args, options)).rejects.toThrow();
  });
});
