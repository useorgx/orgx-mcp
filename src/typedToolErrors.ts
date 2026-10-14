import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { diagnoseToolFailure } from './agentErgonomics';
import { getPublicOperationContract } from './publicOperationContracts';
import { isRemedyCode, typedRemedyDetails } from './remedyErrors';

export { typedRemedyDetails } from './remedyErrors';

/** Reads that record metered usage are annotated as writes but never change work. */
const METERED_READS = new Set([
  'orgx_search',
  'orgx_get_next_actions',
  'orgx_get_agent_status',
  'orgx_get_initiative_progress',
]);

/** True when the operation can change durable state, so its outcome can be unknown. */
export function isMutatingOperation(toolId: string | undefined): boolean {
  if (!toolId || METERED_READS.has(toolId)) return false;
  const contract = getPublicOperationContract(toolId);
  return contract?.annotations?.readOnlyHint === false;
}

/** Authentication and OAuth scope challenges are answered by (re)authorizing. */
const AUTH_CHALLENGE_CODES = new Set(['auth_required', 'authentication_required', 'insufficient_scope', 'unauthorized']);

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

function resultText(result: CallToolResult): string {
  const first = Array.isArray(result.content) ? result.content.find((block) => block.type === 'text') : undefined;
  return first && 'text' in first && typeof first.text === 'string' ? first.text : '';
}

/**
 * Give an error result from a compatibility implementation the same typed
 * remedy a direct failure gets. Structured fields (code, status, details) are
 * read first; the message is only the last resort. Results that are not
 * typed failures are returned unchanged.
 */
export function withTypedRemedy(
  result: CallToolResult,
  context: { toolId: string; args?: Record<string, unknown> }
): CallToolResult {
  if (!result || !result.isError) return result;
  const structured = asRecord(result.structuredContent);
  const error = asRecord(structured?.error);
  if (!structured || !error) return result;
  // OAuth challenges keep their standard codes: re-consent, not a remedy.
  if (typeof error.code === 'string' && AUTH_CHALLENGE_CODES.has(error.code)) return result;
  const details = asRecord(error.details) ?? {};
  const existing = asRecord(details.diagnostic);
  if (isRemedyCode(error.code) && existing?.code === error.code) return result;

  const diagnostic = diagnoseToolFailure({
    toolId: context.toolId,
    error: typeof error.message === 'string' ? error.message : resultText(result),
    code: typeof error.code === 'string' ? error.code : undefined,
    status: typeof error.status === 'number' ? error.status : undefined,
    details,
    args: context.args,
    mutating: isMutatingOperation(context.toolId),
  });
  if (!isRemedyCode(diagnostic.code)) return result;

  return {
    ...result,
    structuredContent: {
      ...structured,
      error: {
        ...error,
        code: diagnostic.code,
        details: {
          ...details,
          ...(typeof error.code === 'string' && error.code !== diagnostic.code ? { upstream_code: error.code } : {}),
          ...typedRemedyDetails(diagnostic),
        },
      },
    },
  };
}
