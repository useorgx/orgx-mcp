import { callOrgxApiJson, type GatewayDelegationClaims, type OrgxApiEnv } from './orgxApi';

/**
 * What a run produced, for orgx_inspect(type: run). Inspecting a run used to
 * return only the run row and its input snapshot, so a fresh session could not
 * read another runtime's answer (continuity matrix, 2026-09-28). The app scopes
 * this to the run's requester and, for run tokens, the pinned workspace.
 */
export interface RunOutput {
  id: string;
  title: string;
  type: string | null;
  summary: string | null;
  excerpt: string | null;
  truncated: boolean;
  url: string | null;
  createdAt: string;
}

type Identity = {
  userId: string | null;
  userEmail?: string | null;
  orgxUserId?: string | null;
} & GatewayDelegationClaims;

/** Additive: any failure leaves inspect as it was (returns null). */
export async function fetchRunOutputs(
  env: OrgxApiEnv,
  runId: string,
  identity: Identity
): Promise<RunOutput[] | null> {
  try {
    const response = await callOrgxApiJson(
      env,
      `/api/runs/${encodeURIComponent(runId)}/output`,
      undefined,
      identity
    );
    const payload = (await response.json()) as { data?: { outputs?: unknown } };
    const outputs = payload?.data?.outputs;
    return Array.isArray(outputs) ? (outputs as RunOutput[]) : null;
  } catch {
    return null;
  }
}

/** A few lines an LLM reads first: each output's title and the start of its text. */
export function formatRunOutputs(outputs: readonly RunOutput[] | null | undefined, maxChars = 600): string | null {
  if (!outputs || outputs.length === 0) return null;
  const lines = ['Outputs (newest first):'];
  for (const output of outputs.slice(0, 5)) {
    const text = (output.excerpt ?? output.summary ?? '').replace(/\s+/g, ' ').trim();
    const shown = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    lines.push(`- ${output.title}${shown ? `: ${shown}` : ''}`);
  }
  return lines.join('\n');
}
