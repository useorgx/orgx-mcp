import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OpenAIUiToolMetadata, OpenAIUiResourceMetadata } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { SECURITY_SCHEMES, WIDGET_URIS } from './toolDefinitions';

export const PANEL_TOOL_NAME = 'orgx_panel_snapshot';
export const PANEL_RESOURCE_URI = WIDGET_URIS.orgxPanel;
export const PANEL_TOOL_META = {
  ui: { resourceUri: PANEL_RESOURCE_URI, visibility: ['app'] },
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } satisfies OpenAIUiToolMetadata,
  'mcp/securitySchemes': SECURITY_SCHEMES.decisionReadRequiresAuth,
};
export const PANEL_RESOURCE_META = {
  availableDisplayModes: ['inline', 'fullscreen'],
} satisfies OpenAIUiResourceMetadata;

export type PanelFocus = { type: 'decision'; id: string };
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const uuid = (value: unknown): value is string => typeof value === 'string' && z.string().uuid().safeParse(value).success;
const text = (value: unknown, limit: number): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
const time = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const route = (type: string, id: string) => `https://useorgx.com/${type}/${id}`;

export interface PanelSnapshotInput {
  workspace: { id: string; name: string } | null;
  userId: string;
  decisions: unknown[];
  artifacts: unknown[];
  focus?: PanelFocus;
  generatedAt?: string;
  degraded?: string[];
}

/** A deliberately bounded projection, never a raw entity or review packet. */
export function buildPanelSnapshot(input: PanelSnapshotInput) {
  const workspace = input.workspace && uuid(input.workspace.id) ? { id: input.workspace.id, name: text(input.workspace.name, 80) ?? 'Workspace' } : null;
  const scoped = (values: unknown[]) => rows(values).filter(row => workspace && row.workspace_id === workspace.id && uuid(row.id));
  const decisions = scoped(input.decisions);
  const pending = decisions.filter(row => row.status === 'pending');
  const urgency = (row: Row) => ['low', 'medium', 'high', 'critical'].includes(String(row.urgency)) ? String(row.urgency) : 'medium';
  const priority = ['critical', 'high', 'medium', 'low'];
  pending.sort((a, b) => priority.indexOf(urgency(a)) - priority.indexOf(urgency(b)) || String(a.created_at).localeCompare(String(b.created_at)));
  const selected = input.focus ? decisions.find(row => row.id === input.focus?.id) : pending[0];
  const packet = record(selected?.review_packet);
  const recommendation = record(packet.recommendation);
  const evidence = rows(packet.evidence ?? selected?.evidence);
  const artifacts = scoped(input.artifacts);
  const accepted = artifacts.filter(row => row.status === 'approved' && uuid(row.approved_by_user_id) && time(row.approved_at))
    .sort((a, b) => Date.parse(String(b.approved_at)) - Date.parse(String(a.approved_at)));
  const last = accepted[0];
  const degraded = [...new Set(input.degraded ?? [])];
  return {
    schema: 'orgx.panel.v1' as const,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    state: !workspace ? 'no_workspace' : degraded.length ? 'degraded' : 'ok',
    workspace,
    selection: input.focus && !selected ? 'unavailable' : selected ? 'selected' : 'none',
    attention: { pending: pending.length, oldest_at: pending.map(row => time(row.created_at)).filter((v): v is string => v !== null).sort()[0] ?? null, blocking: pending.some(row => row.blocks_task === true || record(record(row.review_packet).current).blocked === true), bounded: true },
    queue: pending.slice(0, 3).map(row => ({ id: String(row.id), version: time(row.updated_at) ?? time(record(row.review_packet).updatedAt), title: text(record(row.review_packet).question ?? row.title ?? row.summary, 80) ?? 'Decision required', urgency: urgency(row), waiting_since: time(row.created_at), url: route('decisions', String(row.id)) })),
    focus: selected ? {
      type: 'decision' as const, id: String(selected.id), version: time(selected.updated_at) ?? time(packet.updatedAt), status: text(selected.status, 32) ?? 'unknown',
      question: text(packet.question ?? selected.question ?? selected.title ?? selected.summary, 500) ?? 'Decision required',
      recommendation: { status: ['ready', 'unverified', 'unavailable'].includes(String(recommendation.status)) ? String(recommendation.status) : 'unavailable', action: text(recommendation.action, 160) },
      evidence: evidence.slice(0, 5).map(item => ({ title: text(item.title, 80) ?? 'Evidence' })), evidence_total: evidence.length,
      consequence_if_approved: text(record(packet.consequences).approve, 320),
      blocked: selected.blocks_task === true || record(packet.current).blocked === true,
      url: route('decisions', String(selected.id)),
    } : null,
    proof: { last_accepted: last ? { artifact_id: String(last.id), title: text(last.title ?? last.name, 80) ?? 'Accepted artifact', accepted_at: String(last.approved_at), accepted_by: last.approved_by_user_id === input.userId ? 'you' : 'workspace_member', url: route('artifacts', String(last.id)) } : null,
      completed_unaccepted: artifacts.filter(row => ['in_review', 'eval_passed', 'completed', 'approved'].includes(String(row.status)) && !accepted.includes(row)).length,
      bounded: true,
    },
    degraded,
  };
}

export function registerPanelTool(server: McpServer, handler: (args: { focus?: PanelFocus }) => Promise<CallToolResult>) {
  return registerAppTool(server, PANEL_TOOL_NAME, {
    title: 'OrgX',
    description: 'Read the OrgX decision panel. Rulings happen in the signed-in OrgX app.',
    inputSchema: { focus: z.object({ type: z.literal('decision'), id: z.string().uuid() }).strict().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: PANEL_TOOL_META,
  }, handler);
}

export interface PanelReads {
  workspace: PanelSnapshotInput['workspace'];
  userId: string;
  readPending(workspaceId: string): Promise<unknown>;
  readDecision(id: string, workspaceId: string): Promise<unknown>;
  readArtifacts(workspaceId: string): Promise<unknown>;
}

/** All selectors are hints. Reads use only the authorized session workspace. */
export async function readPanelSnapshot(reads: PanelReads, focus?: PanelFocus) {
  const base = { workspace: reads.workspace, userId: reads.userId, focus, decisions: [] as Row[], artifacts: [] as Row[], degraded: [] as string[] };
  if (!reads.workspace) return buildPanelSnapshot(base);
  const workspaceId = reads.workspace.id;
  const [pendingResult, artifactsResult] = await Promise.allSettled([reads.readPending(workspaceId), reads.readArtifacts(workspaceId)]);
  if (pendingResult.status === 'fulfilled') {
    const result = record(pendingResult.value);
    if (result.ok !== true) throw new Error('Decision read unavailable');
    const data = record(result.data);
    const all = rows(data.decisions);
    // The canonical pending read omits workspace_id but includes the projector's
    // workspace reference. Require that exact reference before lifting any row.
    base.decisions = all.filter(row => row.type === 'decision_queue' && rows(record(row.review_packet).references).some(ref => ref.type === 'workspace' && ref.id === workspaceId))
      .map(row => ({ ...row, workspace_id: workspaceId, status: 'pending' }));
    if (all.some(row => row.type !== 'decision_queue')) base.degraded.push('approval_queue_unavailable');
    if (all.length >= 20) base.degraded.push('queue_bounded');
  } else throw new Error('Decision read unavailable');
  if (focus && !base.decisions.some(row => row.id === focus.id)) {
    // Exact scoped lookup also supports resolved decisions, without re-scoping
    // the model or falling back to a different private item.
    try { const row = record(await reads.readDecision(focus.id, workspaceId)); if (row.id === focus.id && row.workspace_id === workspaceId) base.decisions.push(row); } catch { /* unavailable selection */ }
  }
  if (artifactsResult.status === 'fulfilled') {
    const result = record(artifactsResult.value);
    if (record(result.meta).workspaceId === workspaceId) base.artifacts = rows(result.data);
    else base.degraded.push('proof_unavailable');
    if (record(result.meta).hasMore === true) base.degraded.push('proof_bounded');
    // Current public list does not carry human acceptance authority. Do not
    // infer acceptance from status/metadata. Expose that source limitation.
    if (base.artifacts.some(row => row.status === 'approved' && (!uuid(row.approved_by_user_id) || !time(row.approved_at)))) base.degraded.push('acceptance_unavailable');
  } else base.degraded.push('proof_unavailable');
  return buildPanelSnapshot(base);
}
