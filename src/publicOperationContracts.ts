import { getKnownToolContract, getKnownToolContracts } from './contractTools';
import { getWorkflowToolContract, WORKFLOW_TOOL_ADAPTERS, EXTENDED_WORKFLOW_TOOL_ADAPTERS } from './workflowTools';
import { RECEIPT_OPERATION_TOOLS } from './receiptOperationTools';
import { WIDGET_OPERATION_TOOLS, getWidgetOperationToolContract } from './widgetOperations';

/** Discovery uses the same operation contracts as registration. */
export function getPublicOperationContract(id: string) {
  return getWorkflowToolContract(id)
    ?? RECEIPT_OPERATION_TOOLS.find((tool) => tool.id === id)
    ?? getWidgetOperationToolContract(id)
    ?? getKnownToolContract(id);
}

export function getPublicOperationContracts() {
  const contracts = new Map(getKnownToolContracts().map((tool) => [tool.id, tool as ReturnType<typeof getPublicOperationContract>]));
  for (const tool of [...WORKFLOW_TOOL_ADAPTERS, ...EXTENDED_WORKFLOW_TOOL_ADAPTERS, ...RECEIPT_OPERATION_TOOLS, ...WIDGET_OPERATION_TOOLS]) {
    contracts.set(tool.id, tool);
  }
  return [...contracts.values()].filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
}
