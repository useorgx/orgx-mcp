import { z } from 'zod';
import { SECURITY_SCHEMES } from './toolDefinitions';

const artifactInputs = {
  artifact_id: z.string().uuid(),
  workspace_id: z.string().uuid().optional(),
  approval_token: z.string().min(1).max(4096).describe('Capability from hidden widget metadata, supplied by a person’s click.'),
  expected_version: z.number().int().nonnegative().optional(),
};

export const WIDGET_OPERATION_TOOLS = [
  {
    id: 'orgx_widget_select_workspace', title: 'Select Workspace in OrgX Widget',
    description: 'Widget-only: select the person’s authorized workspace for this connection. Updates private session continuity; does not create or change work.',
    inputSchema: { workspace_id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
  },
  {
    id: 'orgx_widget_approve_artifact', title: 'Approve Artifact from OrgX Widget',
    description: 'Widget-only: record a person’s approval of the displayed artifact using its hidden, version-bound capability. Refuses stale, foreign, missing, or replayed capabilities. Applies OrgX review and continuation rules.',
    inputSchema: { ...artifactInputs, note: z.string().max(2000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
  },
  {
    id: 'orgx_widget_request_artifact_changes', title: 'Request Artifact Changes from OrgX Widget',
    description: 'Widget-only: record a person’s requested changes to the displayed artifact using its hidden, version-bound capability and required feedback. Applies the canonical OrgX rework flow and may dispatch connected agent work.',
    inputSchema: { ...artifactInputs, note: z.string().trim().min(1).max(2000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
  },
] as const;

export const WIDGET_OPERATION_OUTPUT_SCHEMAS: Record<string, z.ZodObject<any>> = {
  orgx_widget_approve_artifact: z.object({ ok: z.boolean(), artifact: z.object({ id: z.string(), status: z.string() }).passthrough() }).passthrough(),
  orgx_widget_request_artifact_changes: z.object({ ok: z.boolean(), artifact: z.object({ id: z.string(), status: z.string() }).passthrough() }).passthrough(),
};

export function getWidgetOperationToolContract(id: string) {
  return WIDGET_OPERATION_TOOLS.find((tool) => tool.id === id);
}
