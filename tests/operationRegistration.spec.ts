import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { capturePrivateOperations, separateOperationWidgetMeta } from '../src/operationRegistration';
import { taskProofCompletionRequest, WORKFLOW_COMPLETION_OUTPUT_SCHEMA } from '../src/workflowCompletion';

describe('operation registration boundary', () => {
  it('preserves core completion errors alongside durable proof attachment state', () => {
    expect(WORKFLOW_COMPLETION_OUTPUT_SCHEMA.safeParse({
      data: { completed: false, proof_attached: true, artifact: { id: 'proof' }, state: 'failed', completion: null, error: { code: 'conflict', message: 'Task changed after verification' } },
      meta: { apiVersion: '1', workspaceId: 'workspace' },
    }).success).toBe(true);
  });
  it('keeps canonical routers outside the SDK callable registry and retains their private implementation', async () => {
    const server = new McpServer({ name: 'operation-boundary', version: '1' });
    const captured = capturePrivateOperations(server, new Set(['orgx_create_task']), new Set(['orgx_create_task']));
    server.registerTool('orgx_write', { inputSchema: {} }, async () => ({ content: [], structuredContent: { created: true } }));
    captured.finish();
    expect((server as any)._registeredTools.orgx_write).toBeUndefined();
    expect(await captured.operations.get('orgx_write')!.handler()).toMatchObject({ structuredContent: { created: true } });
    server.registerTool('orgx_create_task', { inputSchema: {} }, async () => ({ content: [] }));
    expect((server as any)._registeredTools.orgx_create_task).toBeDefined();
  });

  it('removes top-level and nested capabilities before model-visible serialization', () => {
    const token = 'never-show-this-token';
    for (const raw of [
      { ok: true, _widget_meta: { receipt_approval_tokens: { receipt: token } } },
      { data: { decision: { id: 'decision' }, _widget_meta: { approval_tokens: { decision: token } } }, meta: { apiVersion: '1' } },
    ]) {
      const result = separateOperationWidgetMeta(raw);
      expect(JSON.stringify(result.data)).not.toContain(token);
      expect(JSON.stringify(result.meta)).toContain(token);
      expect(result.data).not.toHaveProperty('_widget_meta');
    }
  });

  it('binds task proof retries to declared producer material and preserves external URLs', async () => {
    const args = { type: 'task', id: 'task', artifact: { artifact_type: 'document', external_url: 'https://example.com/proof' }, quality_score: 4, note: 'Delivered' };
    const first = await taskProofCompletionRequest(args);
    const retry = await taskProofCompletionRequest({ ...args, force: true, actor: 'human' });
    expect(retry).toEqual(first);
    expect(first.body.artifact).toMatchObject({ artifact_url: 'https://example.com/proof', quality_score: 4 });
    expect(first.body).not.toHaveProperty('force');
    expect((await taskProofCompletionRequest({ ...args, note: 'Changed' })).idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('preserves execution evidence through the canonical request and binds retry identity to its exact contents', async () => {
    const modality_proof = { kind: 'execution', status: 'passed', artifact_version: 1,
      checked_at: '2026-10-10T01:30:00Z', evidence_refs: [{ url: 'https://github.com/org/repo/actions/runs/1', hash: 'sha256:actual' }] };
    const args = { type: 'task', id: 'task', artifact: { artifact_type: 'eng.pull_request', external_url: 'https://github.com/org/repo/pull/1', artifact_hash: 'actual-head', atomic_unit_type: 'pull_request', modality_proof } };
    const first = await taskProofCompletionRequest(args);
    expect(first.body.artifact).toMatchObject({ artifact_hash: 'actual-head', atomic_unit_type: 'pull_request', modality_proof });
    expect(await taskProofCompletionRequest(args)).toEqual(first);
    const changed = await taskProofCompletionRequest({ ...args, artifact: { ...args.artifact,
      modality_proof: { ...modality_proof, evidence_refs: [{ url: 'https://github.com/org/repo/actions/runs/2', hash: 'sha256:different' }] },
    } });
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('preserves the documented versioned proof string for cached tool clients', async () => {
    const verification = [
      'The source-pinned release CI passed.',
      `orgx:modality-proof:v1:${JSON.stringify({
        kind: 'execution', status: 'passed', artifact_version: 1,
        checked_at: '2026-10-10T01:30:00Z',
        evidence_refs: [{ url: 'https://github.com/org/repo/actions/runs/1', hash: 'actual-head' }],
      })}`,
    ];
    const args = {
      type: 'task', id: 'task', verification,
      artifact: { artifact_type: 'eng.pull_request', external_url: 'https://github.com/org/repo/pull/1' },
    };
    const request = await taskProofCompletionRequest(args);
    expect(request.body.artifact?.verification).toEqual(verification);
    expect(await taskProofCompletionRequest(args)).toEqual(request);
    expect((await taskProofCompletionRequest({ ...args, verification: [verification[0]] })).idempotencyKey)
      .not.toBe(request.idempotencyKey);
  });
});
