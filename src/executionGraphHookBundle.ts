/**
 * Execution-graph auto-emit hook bundle (the WEG keystone, client side).
 *
 * Every client config endpoint advertises this bundle so an install can wire a
 * lifecycle hook that emits the SAME instrument the benchmark records — a
 * deterministic execution graph derived from the real session transcript —
 * to OrgX's ingestion endpoint at the session/turn boundary.
 *
 * The emitter itself is a single dependency-free Node script that lives in the
 * OrgX app repo (scripts/hooks/orgx-emit-execution-graph.mjs) and is proven
 * working end-to-end against the live endpoint. This module is the per-client
 * INSTALL CONTRACT: which lifecycle event fires it, the exact command, and the
 * opt-in environment it requires.
 *
 * SAFETY: the hook is OPT-IN. Advertising it in a config never causes a session
 * to phone home; the emitter no-ops unless ORGX_EMIT_EXECUTION_GRAPH is truthy
 * AND auth + initiative id are present.
 *
 * @see orgx/scripts/hooks/orgx-emit-execution-graph.mjs (the emitter)
 * @see orgx/app/api/client/live/execution-graph/route.ts (ingestion)
 * @see orgx/docs/integrations/execution-graph-hook.md (operator install)
 */

import type { SourceClient } from './cross-pollination';

/** Filename of the portable emitter the install delivers locally. */
export const EXECUTION_GRAPH_EMITTER_SCRIPT = 'orgx-emit-execution-graph.mjs';

/** Path of the emitter within the OrgX app repo (source of truth). */
export const EXECUTION_GRAPH_EMITTER_REPO_PATH =
  'scripts/hooks/orgx-emit-execution-graph.mjs';

/**
 * The command a hook runs. Note: NO `.claude`-style local paths here — the
 * hosted claude-code config must not advertise local file writes. The operator
 * points ORGX_HOOK_SCRIPT at wherever the install placed the emitter; the
 * client passes its hook payload (with transcript_path) on stdin.
 */
export const EXECUTION_GRAPH_HOOK_COMMAND = 'node "$ORGX_HOOK_SCRIPT"';

/** The opt-in environment contract shared by every client. */
export const EXECUTION_GRAPH_HOOK_ENV = {
  /** Master opt-in switch — the emitter no-ops unless this is truthy. */
  enableFlag: 'ORGX_EMIT_EXECUTION_GRAPH',
  required: [
    'ORGX_EMIT_EXECUTION_GRAPH', // =1 to enable
    'ORGX_INITIATIVE_ID', // which initiative the run belongs to (uuid)
    // Auth: a per-user key OR the service pair.
    'ORGX_CLIENT_KEY', // oxk_...  (preferred)
  ],
  authAlternative: ['ORGX_SERVICE_KEY', 'ORGX_USER_ID'],
  optional: [
    'ORGX_BASE_URL', // default https://useorgx.com
    'ORGX_SOURCE_CLIENT', // defaults from the installing client
    'ORGX_EMIT_MAX_NODES', // default 40
    'ORGX_EMIT_TIMEOUT_MS', // default 4000
    'ORGX_EMIT_DEBUG', // stderr logging
  ],
} as const;

/**
 * Which native lifecycle event(s) fire the emitter for a given client, and how
 * complete that path is. Clients with a real session-end hook (Claude Code,
 * Cursor) get a native hook; Codex has no native hook bundle so it uses its
 * `notify` program; OpenClaw emits from the gateway's run-completed peer.
 */
export interface ClientExecutionGraphHook {
  source_client: SourceClient;
  /** How the emitter is invoked on this client. */
  mechanism: 'native_hook' | 'notify_program' | 'gateway_peer' | 'wrapper';
  /** The native event name(s) the client fires the emitter on. */
  events: string[];
  /** Human-readable note on the install path for this client. */
  install: string;
}

const HOOK_BY_CLIENT: Partial<Record<SourceClient, ClientExecutionGraphHook>> = {
  claude: {
    source_client: 'claude',
    mechanism: 'native_hook',
    events: ['Stop', 'SessionEnd'],
    install:
      'Register a Stop (and/or SessionEnd) hook that runs the emitter; the host passes session_id + transcript_path on stdin.',
  },
  cursor: {
    source_client: 'cursor',
    mechanism: 'native_hook',
    events: ['Stop'],
    install:
      'Cursor already declares SessionStart/PostToolUse/Stop; bind the Stop hook to the emitter command.',
  },
  codex: {
    source_client: 'codex',
    mechanism: 'notify_program',
    events: ['notify'],
    install:
      'Codex has no native hook bundle; set notify in ~/.codex/config.toml to the emitter (pass ORGX_TRANSCRIPT_PATH or rely on the notify payload).',
  },
  openclaw: {
    source_client: 'openclaw',
    mechanism: 'gateway_peer',
    events: ['run.completed'],
    install:
      'The OpenClaw gateway already posts run receipts; emit the execution graph from the same run-completed peer event.',
  },
};

/** Get the per-client hook install contract, if this client supports it. */
export function executionGraphHookForClient(
  sourceClient: SourceClient | null | undefined
): ClientExecutionGraphHook | null {
  return HOOK_BY_CLIENT[sourceClient ?? 'other'] ?? null;
}

/**
 * The bundle a config endpoint embeds. `webUrl` is the OrgX app origin so the
 * docs/source pointers resolve to the caller's deployment.
 */
export function buildExecutionGraphHookBundle(input: {
  sourceClient: SourceClient;
  webUrl: string;
}) {
  const web = input.webUrl.replace(/\/+$/, '');
  const perClient = executionGraphHookForClient(input.sourceClient);
  if (!perClient) return null;

  return {
    id: 'orgx-execution-graph-auto-emit',
    purpose:
      'Emit the deterministic execution graph + trust ledger derived from the real session transcript at the session boundary (the WEG keystone, continuous proof).',
    optIn: true,
    enableFlag: EXECUTION_GRAPH_HOOK_ENV.enableFlag,
    env: EXECUTION_GRAPH_HOOK_ENV,
    command: EXECUTION_GRAPH_HOOK_COMMAND,
    emitter: {
      script: EXECUTION_GRAPH_EMITTER_SCRIPT,
      repoPath: EXECUTION_GRAPH_EMITTER_REPO_PATH,
      ingestionEndpoint: `${web}/api/client/live/execution-graph`,
      docs: `${web}/docs/integrations/execution-graph-hook`,
    },
    mechanism: perClient.mechanism,
    events: perClient.events,
    install: perClient.install,
  };
}
