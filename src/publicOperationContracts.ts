import { getKnownToolContract, getKnownToolContracts } from './contractTools';
import { getWorkflowToolContract, WORKFLOW_TOOL_ADAPTERS, EXTENDED_WORKFLOW_TOOL_ADAPTERS } from './workflowTools';
import { RECEIPT_OPERATION_TOOLS } from './receiptOperationTools';
import { WIDGET_OPERATION_TOOLS, getWidgetOperationToolContract } from './widgetOperations';
import { CURRENT_PANEL_SNAPSHOT_TOOL_CONTRACT, CURRENT_RECEIPT_CALL_TOOL_CONTRACT } from './panelSurface';

/** Discovery uses the same operation contracts as registration. */
export function getPublicOperationContract(id: string) {
  if (id === CURRENT_PANEL_SNAPSHOT_TOOL_CONTRACT.id) return CURRENT_PANEL_SNAPSHOT_TOOL_CONTRACT;
  if (id === CURRENT_RECEIPT_CALL_TOOL_CONTRACT.id) return CURRENT_RECEIPT_CALL_TOOL_CONTRACT;
  return getWorkflowToolContract(id)
    ?? RECEIPT_OPERATION_TOOLS.find((tool) => tool.id === id)
    ?? getWidgetOperationToolContract(id)
    ?? getKnownToolContract(id);
}

export function getPublicOperationContracts() {
  const contracts = new Map(getKnownToolContracts().map((tool) => [tool.id, tool as ReturnType<typeof getPublicOperationContract>]));
  contracts.set(CURRENT_PANEL_SNAPSHOT_TOOL_CONTRACT.id, CURRENT_PANEL_SNAPSHOT_TOOL_CONTRACT);
  contracts.set(CURRENT_RECEIPT_CALL_TOOL_CONTRACT.id, CURRENT_RECEIPT_CALL_TOOL_CONTRACT);
  for (const tool of [...WORKFLOW_TOOL_ADAPTERS, ...EXTENDED_WORKFLOW_TOOL_ADAPTERS, ...RECEIPT_OPERATION_TOOLS, ...WIDGET_OPERATION_TOOLS]) {
    contracts.set(tool.id, tool);
  }
  return [...contracts.values()].filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
}
