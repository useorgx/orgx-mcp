import { z } from 'zod';
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const captureSchema = z.object({
  workspace_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(8000),
  shape: z.literal('generic'),
  shape_context: z.object({ description: z.string().min(1).max(8000) }),
  blocks_task: z.literal(false),
  initiative_id: z.string().uuid().optional(),
  workstream_id: z.string().uuid().optional(),
});

export async function captureDecision(
  args: Record<string, unknown>,
  options: {
    env: OrgxApiEnv;
    userId: string | null;
    userEmail?: string | null;
    orgxUserId?: string | null;
    workspaceId: string | null;
  }
) {
  if (!options.userId) throw new Error('Sign in to capture a decision.');
  const decision = text(args.decision) || text(args.summary) || text(args.description) || text(args.title);
  const context = text(args.context);
  const description = context && context !== decision
    ? `${decision}\n\nContext: ${context}` : decision;
  const body = captureSchema.parse({
    workspace_id: options.workspaceId,
    title: text(args.title) || decision.slice(0, 500),
    description,
    shape: 'generic',
    shape_context: { description: decision },
    blocks_task: false,
    ...(args.initiative_id ? { initiative_id: args.initiative_id } : {}),
    ...(args.workstream_id ? { workstream_id: args.workstream_id } : {}),
  });
  const suppliedKey = text(args.idempotency_key);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const derivedKey = 'mcp-decision-' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const response = await callOrgxApiJson(options.env, '/api/v1/decisions', {
    method: 'POST',
    headers: { 'Idempotency-Key': suppliedKey || derivedKey },
    body: JSON.stringify(body),
  }, {
    userId: options.userId,
    userEmail: options.userEmail,
    orgxUserId: options.orgxUserId,
    allowFallback: false,
  });
  const result = z.object({ decision: z.object({
    id: z.string().uuid(), title: z.string(), status: z.string(),
    initiative_id: z.string().nullable().optional(),
  }) }).parse(await response.json());
  const message = `Decision recorded: ${result.decision.title}. Review state: ${result.decision.status}. Capturing a decision does not approve work.`;
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: {
      id: result.decision.id,
      type: 'decision',
      title: result.decision.title,
      initiative_id: result.decision.initiative_id ?? null,
      message,
    },
  };
}
