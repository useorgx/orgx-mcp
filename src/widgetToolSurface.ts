import { inferMcpContractVersion } from './mcpCompatibility';

const choices = {
  panel_snapshot: ['orgx_panel_snapshot'],
  workspace_select: ['orgx_widget_select_workspace'],
  operation_status: ['orgx_get_operation_status'],
  receipt_list: ['orgx_list_work_receipts'],
  receipt_detail: ['orgx_get_work_receipt'],
  receipt_judgment: ['orgx_widget_receipt_call'],
  decision_judgment: ['orgx_widget_decide'],
  artifact_approve: ['orgx_widget_approve_artifact'],
  artifact_request_changes: ['orgx_widget_request_artifact_changes'],
  resume_run: ['resume_agent_run'],
} as const;

/** Capabilities describe registered IDs, not authorization to bypass a gate. */
export function buildWidgetToolSurface(profile: string, registered: ReadonlySet<string>, allowed: ReadonlySet<string> | null) {
  const tools = [...registered].filter((id) => !allowed || allowed.has(id)).sort();
  const available = new Set(tools);
  const widget_tools = Object.fromEntries(Object.entries(choices).flatMap(([operation, ids]) => {
    const id = ids.find((candidate) => available.has(candidate));
    return id ? [[operation, id]] : [];
  }));
  return { contract_version: inferMcpContractVersion(profile), profile, tools, widget_tools };
}
