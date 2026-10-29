import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errors } from '@/lib/server/apiErrors';
import {
  exactOrgxRequestRef,
  isExactAutomaticSessionReceipt,
} from '@/lib/server/reporting/automaticSessionReceiptLineage';
import {
  compileWorkspaceContextCapsule,
  type CompileWorkspaceContextCapsuleInput,
} from './compile';

const row = z.record(z.string(), z.unknown());
const source = (limit: number) =>
  z
    .object({
      rows: z.array(row).max(limit),
      count: z.number().int().nonnegative().safe(),
    })
    .strict()
    .refine(
      (s) => s.count >= s.rows.length,
      'Source count cannot be less than returned rows'
    );
export const ContextSourceSnapshotSchema = z
  .object({
    schema_version: z.literal('orgx.context-source-snapshot/v1'),
    owner_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    initiative_id: z.string().uuid().nullable(),
    workstream_id: z.string().uuid().nullable(),
    task_id: z.string().uuid().nullable(),
    snapshot: z.string().regex(/^\d+:\d+:[\d,]*$/),
    observed_at: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value))),
    global_sequence: z.number().int().nonnegative().safe(),
    decisions: source(64),
    learnings: source(8),
    expectations: source(5),
    risks: source(8),
    receipts: source(64),
    sessions: source(16),
    receipt_sessions: z.array(row).max(64),
  })
  .strict();

/** All source rows, scope ancestry and receipt lineage use one database snapshot. */
export async function buildSnapshotContextCapsule(input: {
  admin: SupabaseClient;
  ownerId: string;
  workspaceId: string;
  initiativeId?: string;
  workstreamId?: string;
  taskId?: string;
  generatedAt: string;
}) {
  const { data, error } = await input.admin.rpc(
    'load_context_capsule_snapshot_v1',
    {
      p_owner_id: input.ownerId,
      p_workspace_id: input.workspaceId,
      p_initiative_id: input.initiativeId ?? null,
      p_workstream_id: input.workstreamId ?? null,
      p_task_id: input.taskId ?? null,
    }
  );
  if (error) {
    if (error.code === 'P0002')
      throw errors.notFound('Context scope not found');
    if (error.code === '22023')
      throw errors.badRequest('Context scope fields disagree');
    // No best-effort fallback after a snapshot failure.
    throw errors.internal('Context snapshot could not be read');
  }
  const snapshot = ContextSourceSnapshotSchema.parse(data);
  if (
    snapshot.owner_id !== input.ownerId ||
    snapshot.workspace_id !== input.workspaceId ||
    (input.initiativeId && snapshot.initiative_id !== input.initiativeId) ||
    (input.workstreamId && snapshot.workstream_id !== input.workstreamId) ||
    snapshot.task_id !== (input.taskId ?? null) ||
    (snapshot.task_id &&
      (!snapshot.workstream_id || !snapshot.initiative_id)) ||
    (snapshot.workstream_id && !snapshot.initiative_id)
  )
    throw errors.notFound('Context scope not found');
  const scope = {
    workspaceId: input.workspaceId,
    ...(snapshot.initiative_id ? { initiativeId: snapshot.initiative_id } : {}),
    ...(snapshot.workstream_id ? { workstreamId: snapshot.workstream_id } : {}),
    ...(snapshot.task_id ? { taskId: snapshot.task_id } : {}),
  };
  const requestRef = exactOrgxRequestRef(scope);
  const sessions = new Map(snapshot.receipt_sessions.map((s) => [s.id, s]));
  const receipts = snapshot.receipts.rows.filter((receipt) =>
    isExactAutomaticSessionReceipt({
      row: receipt,
      session: sessions.get(receipt.ref_id),
      ownerId: input.ownerId,
      ...scope,
      requestRef,
    })
  );
  // Compiler validates authority-backed decisions and admitted session work context.
  const sources = {
    ...scope,
    generatedAt: input.generatedAt,
    observedGlobalSequence: snapshot.global_sequence,
    decisionRows: snapshot.decisions.rows,
    decisionCount: snapshot.decisions.count,
    learningRows: snapshot.learnings.rows,
    learningCount: snapshot.learnings.count,
    expectationRows: snapshot.expectations.rows,
    expectationCount: snapshot.expectations.count,
    riskRows: snapshot.risks.rows,
    riskCount: snapshot.risks.count,
    sessionRows: snapshot.sessions.rows,
    sessionCandidatesUnvalidated:
      snapshot.sessions.count - snapshot.sessions.rows.length,
    receiptRows: receipts,
    receiptCount: receipts.length,
    receiptCandidatesUnvalidated:
      snapshot.receipts.count - snapshot.receipts.rows.length,
    receiptCandidatesWithheld: snapshot.receipts.rows.length - receipts.length,
    sourceSnapshot: {
      version: `sha256:${createHash('sha256')
        .update(
          JSON.stringify([
            input.ownerId,
            scope,
            snapshot.global_sequence,
            snapshot.decisions,
            snapshot.learnings,
            snapshot.expectations,
            snapshot.risks,
            snapshot.receipts,
            snapshot.sessions,
            snapshot.receipt_sessions,
          ])
        )
        .digest('hex')}`,
      observed_at: new Date(snapshot.observed_at).toISOString(),
    },
  };
  return compileWorkspaceContextCapsule(
    sources as unknown as CompileWorkspaceContextCapsuleInput
  );
}
