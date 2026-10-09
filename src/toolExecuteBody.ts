/**
 * The body of a call to OrgX's generic tool executor (/api/tools/execute).
 *
 * `source_client` names the AI client from the MCP initialize handshake
 * (clientInfo.name). OrgX stores it as a label on what the call records, such
 * as the client that hosted a widget when a person settled a decision there.
 * It is attribution only and never grants anything.
 */
export function buildToolExecuteBody(input: {
  toolId: string;
  args: Record<string, unknown>;
  userId: string | null | undefined;
  clientName: string | null | undefined;
}): Record<string, unknown> {
  const sourceClient =
    typeof input.clientName === 'string' && input.clientName.trim()
      ? input.clientName.trim().slice(0, 60)
      : null;
  return {
    tool_id: input.toolId, // No chatgpt. prefix needed
    args: input.args,
    user_id: input.userId,
    ...(sourceClient ? { source_client: sourceClient } : {}),
  };
}
