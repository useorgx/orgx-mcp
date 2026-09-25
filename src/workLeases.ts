/**
 * orgx_lease: advisory file leases so parallel agents stop editing the same
 * files blind. Backed by OrgX /api/v1/leases (orgx
 * lib/server/coordination/workLeases.ts): claim the paths you are about to
 * edit, and a claim overlapping another agent's live lease comes back refused
 * with who holds which paths until when. Leases expire; release early when
 * done. Offered on the executor and full profiles, not the public surfaces.
 */
import { z } from 'zod';

import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export const WORK_LEASE_TOOL_ID = 'orgx_lease';

export const WORK_LEASE_DESCRIPTION =
  'Coordinate file edits with other agents working in the same repository. ' +
  'USE WHEN: about to edit files another agent might be editing — claim the paths first. ' +
  'action=claim needs repo (owner/name) and paths (repo-relative files or globs); a refused claim lists who holds which paths until when, so wait or take other work. ' +
  'action=list shows live leases on a repo. action=release frees a lease early (lease_id). ' +
  'Leases are advisory and expire (default 60 minutes); claiming the same paths again renews yours.';

export const workLeaseInputSchema = {
  action: z.enum(['claim', 'list', 'release']).describe('claim paths, list live leases, or release one'),
  repo: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Repository as owner/name, e.g. hopeatina/orgx. Required for claim and list.'),
  paths: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(50)
    .optional()
    .describe('Repo-relative files or globs you are about to edit. Required for claim.'),
  minutes: z.number().int().min(1).max(480).optional().describe('How long to hold the lease; default 60.'),
  lease_id: z.string().uuid().optional().describe('The lease to release. Required for release.'),
  task_id: z.string().uuid().optional().describe('OrgX task the edit belongs to, if any.'),
  reason: z.string().max(500).optional().describe('One line other agents will see.'),
};

type LeaseRow = { id: string; holder: string; paths: string[]; expires_at: string; reason?: string | null };
type Conflict = LeaseRow & { overlapping_paths: string[] };

export type WorkLeaseCall = {
  env: OrgxApiEnv;
  userId: string | null;
  userEmail: string | null;
  orgxUserId: string | null;
  /** Who holds the lease: client label plus MCP session. */
  holder: string;
};

export type WorkLeaseResult = { ok: boolean; text: string; structured: Record<string, unknown> };

const time = (iso: string) => iso.slice(11, 16) + ' UTC';

export async function executeWorkLease(
  args: Record<string, unknown>,
  call: WorkLeaseCall
): Promise<WorkLeaseResult> {
  const parsed = z.object(workLeaseInputSchema).safeParse(args);
  if (!parsed.success) {
    return { ok: false, text: `Invalid orgx_lease input: ${parsed.error.issues[0]?.message ?? 'bad input'}`, structured: {} };
  }
  const input = parsed.data;
  const identity = { userId: call.userId, userEmail: call.userEmail, orgxUserId: call.orgxUserId, allowFallback: false };

  if (input.action === 'release') {
    if (!input.lease_id) return { ok: false, text: 'release needs lease_id', structured: {} };
    try {
      await callOrgxApiJson(call.env, `/api/v1/leases/${input.lease_id}`, { method: 'DELETE' }, identity);
      return { ok: true, text: `Released lease ${input.lease_id.slice(0, 8)}`, structured: { released: true, lease_id: input.lease_id } };
    } catch (error) {
      return { ok: false, text: `Lease not released: ${error instanceof Error ? error.message : String(error)}`, structured: { released: false } };
    }
  }

  if (!input.repo) return { ok: false, text: `${input.action} needs repo (owner/name)`, structured: {} };

  if (input.action === 'list') {
    const response = await callOrgxApiJson(
      call.env,
      `/api/v1/leases?repo=${encodeURIComponent(input.repo)}`,
      undefined,
      identity
    );
    const leases = ((await response.json()) as { data?: { leases?: LeaseRow[] } }).data?.leases ?? [];
    const lines = leases.map((lease) => `- ${lease.holder} holds ${lease.paths.join(', ')} until ${time(lease.expires_at)}`);
    return {
      ok: true,
      text: leases.length ? `Live leases on ${input.repo}:\n${lines.join('\n')}` : `No live leases on ${input.repo}.`,
      structured: { repo: input.repo, leases },
    };
  }

  if (!input.paths?.length) return { ok: false, text: 'claim needs paths', structured: {} };
  const response = await callOrgxApiJson(
    call.env,
    '/api/v1/leases',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: input.repo,
        paths: input.paths,
        holder: call.holder,
        ...(input.minutes ? { minutes: input.minutes } : {}),
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    },
    identity
  );
  const data = ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
  if (data.granted === true) {
    const lease = data.lease as LeaseRow;
    return {
      ok: true,
      text: `${data.extended ? 'Renewed' : 'Claimed'} ${lease.paths.join(', ')} until ${time(lease.expires_at)} (lease ${lease.id.slice(0, 8)}).`,
      structured: data,
    };
  }
  const conflicts = (data.conflicts as Conflict[] | undefined) ?? [];
  const lines = conflicts.map(
    (conflict) =>
      `- ${conflict.holder} holds ${conflict.overlapping_paths.join(', ')} until ${time(conflict.expires_at)}${
        conflict.reason ? ` (${conflict.reason})` : ''
      }`
  );
  return {
    ok: true,
    text: `Not claimed: another agent is editing these paths.\n${lines.join('\n')}\nWait for the lease to end, coordinate, or take other work.`,
    structured: data,
  };
}
