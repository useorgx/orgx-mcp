import type { SourceClient } from './cross-pollination';
import type { ClientActivationAction } from './clientActivationExperience';

export type ClientHookCoverageStatus =
  | 'wired'
  | 'partial'
  | 'fallback'
  | 'missing';

export type ClientHookSurface = {
  surface: string;
  status: ClientHookCoverageStatus;
  proof: string;
  reporting_role: string;
};

export type ClientHookCoverage = {
  source_client: SourceClient;
  coverage_level: 'native_hooks' | 'tool_actions' | 'mcp_fallback' | 'generic';
  surfaces: ClientHookSurface[];
  reporting_entrypoints: ClientActivationAction[];
  required_proof: string[];
  gaps: string[];
};

const OPERATOR_CHRONICLE_ENTRYPOINT: ClientActivationAction = {
  tool: 'get_operator_chronicle',
  label: 'Read decision chronology and delivery proof',
  prompt:
    'Run get_operator_chronicle period=30d and lead with reportingNarrative.briefMarkdown, topPriorities, PR velocity, artifacts, goals, and gaps.',
  args: { period: '30d' },
};

const MORNING_BRIEF_ENTRYPOINT: ClientActivationAction = {
  tool: 'orgx_recommend',
  label: 'Fallback to the morning brief',
  prompt:
    'Run orgx_recommend mode=morning_brief when a host has not exposed get_operator_chronicle directly.',
  args: { mode: 'morning_brief' },
};

const REPORTING_ENTRYPOINTS = [
  OPERATOR_CHRONICLE_ENTRYPOINT,
  MORNING_BRIEF_ENTRYPOINT,
];

const CLIENT_HOOK_COVERAGE: Record<SourceClient, ClientHookCoverage> = {
  chatgpt: {
    source_client: 'chatgpt',
    coverage_level: 'tool_actions',
    surfaces: [
      {
        surface: 'ChatGPT action list',
        status: 'wired',
        proof: 'workers/orgx-mcp/chatgpt-app-submission.json includes get_operator_chronicle and regression tests require submission/server tool parity.',
        reporting_role:
          'Lets the assistant call the full decision/artifact/PR/velocity/goal report directly.',
      },
      {
        surface: 'Apps SDK tool metadata and widgets',
        status: 'wired',
        proof: 'registerChatGPTTools preserves output templates and openai/toolInvocation metadata for ChatGPT widgets.',
        reporting_role:
          'Renders report and decision surfaces inline instead of forcing a plain-text summary.',
      },
      {
        surface: 'Ambient lifecycle hooks',
        status: 'missing',
        proof: 'No ChatGPT-specific OrgX lifecycle hook bundle is registered in this worker; reporting depends on explicit tool calls.',
        reporting_role:
          'Session-end or post-tool auto-capture still needs a client-supported path before it can be called seamless.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Inspect the installed ChatGPT app action list after dashboard/import refresh and confirm get_operator_chronicle appears.',
      'Call get_operator_chronicle from ChatGPT and verify reportingNarrative, decisions, artifacts, PR velocity, goals, and gaps render.',
    ],
    gaps: [
      'Dashboard/import refresh proof is still required even though the submission source is updated.',
      'No ambient session lifecycle capture is proven for ChatGPT; use explicit actions until a host hook path exists.',
    ],
  },
  cursor: {
    source_client: 'cursor',
    coverage_level: 'native_hooks',
    surfaces: [
      {
        surface: 'MCP server',
        status: 'wired',
        proof: '/cursor/config declares mcpServers.orgx against the hosted MCP endpoint.',
        reporting_role:
          'Exposes OrgX read/write/reporting tools directly inside Cursor.',
      },
      {
        surface: 'Lifecycle hooks',
        status: 'wired',
        proof: '/cursor/config bundle.hooks lists SessionStart, PostToolUse, and Stop.',
        reporting_role:
          'Provides the native path for session start, tool-use, and stop reporting.',
      },
      {
        surface: 'Rules, commands, and subagents',
        status: 'wired',
        proof: '/cursor metadata advertises rules, commands, and domain subagents.',
        reporting_role:
          'Keeps execution behavior and follow-up actions available without leaving the editor.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Run cursor-agent mcp list-tools orgx and confirm get_operator_chronicle is present.',
      'Run a Cursor session that triggers SessionStart, PostToolUse, and Stop, then verify OrgX chronicle receives activity/receipt rows.',
    ],
    gaps: [
      'Tool listing proves availability; a live hook-emission trace is still needed for full seamless-reporting proof.',
    ],
  },
  codex: {
    source_client: 'codex',
    coverage_level: 'mcp_fallback',
    surfaces: [
      {
        surface: 'MCP config',
        status: 'wired',
        proof: '/codex/config emits ~/.codex/config.toml server config for the hosted MCP endpoint.',
        reporting_role:
          'Connects Codex to OrgX tools when the local client loads the MCP server.',
      },
      {
        surface: 'Read-only hosted metadata',
        status: 'wired',
        proof: '/codex metadata marks safe read-only tools for the hosted descriptor.',
        reporting_role:
          'Helps Codex discover bootstrap/search/recommend/reporting tools safely.',
      },
      {
        surface: 'Native lifecycle hooks',
        status: 'missing',
        proof: 'No Codex-specific OrgX hook bundle is registered in this worker.',
        reporting_role:
          'Execution proof currently depends on explicit orgx_emit_activity/orgx_submit_receipt calls.',
      },
      {
        surface: 'Direct chronicle action in active Codex sessions',
        status: 'partial',
        proof: 'Server/bootstrap exposes get_operator_chronicle, but some active Codex tool namespaces may still expose only compatibility wrappers.',
        reporting_role:
          'Use orgx_recommend mode=morning_brief as fallback until the direct tool is visible in the client namespace.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Run Codex MCP tool discovery in a fresh session and confirm get_operator_chronicle is directly callable.',
      'Emit a Codex receipt or activity event, then confirm it appears in the operator chronicle.',
    ],
    gaps: [
      'Direct get_operator_chronicle visibility must be proven in the active Codex tool namespace.',
      'No Codex-native lifecycle hook path is wired; reporting is explicit-call based.',
    ],
  },
  claude: {
    source_client: 'claude',
    coverage_level: 'mcp_fallback',
    surfaces: [
      {
        surface: 'MCP config',
        status: 'wired',
        proof: '/claude-code/config emits the hosted OrgX MCP server configuration.',
        reporting_role:
          'Exposes OrgX tools to Claude Code and Claude-compatible MCP clients.',
      },
      {
        surface: 'MCP tools and widgets',
        status: 'wired',
        proof: 'server.json and tool registration include get_operator_chronicle, morning brief, decisions, widgets, and write/action tools.',
        reporting_role:
          'Supports direct reporting plus inline decision/status surfaces.',
      },
      {
        surface: 'Native lifecycle hooks',
        status: 'partial',
        proof: 'The app has plugin ingestion endpoints for activity, receipts, and deviations, but /claude-code/config does not advertise a hook bundle.',
        reporting_role:
          'Claude work can report through tools, but ambient hook capture is not proven from this config surface.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'List Claude MCP tools and confirm get_operator_chronicle is visible.',
      'Run a Claude Code session that emits activity or a receipt, then verify the chronicle includes it.',
    ],
    gaps: [
      'Claude Code needs live receipt/activity proof; config alone only proves MCP availability.',
    ],
  },
  openclaw: {
    source_client: 'openclaw',
    coverage_level: 'native_hooks',
    surfaces: [
      {
        surface: 'Gateway heartbeat and run receipt APIs',
        status: 'wired',
        proof: 'app/api/v1/gateway/heartbeat and app/api/v1/runs/[runId]/receipt accept plugin-peer reporting.',
        reporting_role:
          'Lets local gateway peers prove connection state and completed work.',
      },
      {
        surface: 'Deviation ingestion',
        status: 'wired',
        proof: 'app/api/v1/skills/[skillId]/deviations accepts plugin_openclaw deviation reports.',
        reporting_role:
          'Captures rule misses and execution deviations for later skill/reporting improvement.',
      },
      {
        surface: 'Operator chronicle',
        status: 'wired',
        proof: 'get_operator_chronicle is a public read-only reporting tool.',
        reporting_role:
          'Closes the loop by showing gateway work, decisions, artifacts, and gaps.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Send heartbeat, activity/deviation, and receipt events from the gateway plugin and verify they appear in the chronicle.',
    ],
    gaps: [
      'Gateway proof must be end-to-end: heartbeat plus emitted receipt/deviation plus chronicle visibility.',
    ],
  },
  vscode: {
    source_client: 'vscode',
    coverage_level: 'mcp_fallback',
    surfaces: [
      {
        surface: 'MCP-compatible tools',
        status: 'fallback',
        proof: 'VS Code routes through the same MCP tool registry and client activation path.',
        reporting_role:
          'Provides explicit reporting actions, but no VS Code-specific hook bundle is declared here.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Verify VS Code tool discovery exposes get_operator_chronicle.',
      'Submit a receipt/activity event and confirm chronicle visibility.',
    ],
    gaps: ['No VS Code-specific lifecycle hook bundle is declared in this worker.'],
  },
  goose: {
    source_client: 'goose',
    coverage_level: 'mcp_fallback',
    surfaces: [
      {
        surface: 'MCP-compatible tools',
        status: 'fallback',
        proof: 'Goose uses the generic MCP activation path.',
        reporting_role:
          'Explicit reporting calls work, but native hook capture is not represented in this worker.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Verify Goose tool discovery exposes get_operator_chronicle.',
      'Submit a receipt/activity event and confirm chronicle visibility.',
    ],
    gaps: ['No Goose-specific lifecycle hook bundle is declared in this worker.'],
  },
  api: {
    source_client: 'api',
    coverage_level: 'generic',
    surfaces: [
      {
        surface: 'HTTP API and MCP tools',
        status: 'wired',
        proof: 'API callers can use the shared tool executor and reporting tools.',
        reporting_role:
          'Machine clients can call explicit reporting endpoints, but must own their own lifecycle events.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Call get_operator_chronicle with API auth and verify the expected reporting sections.',
    ],
    gaps: ['API clients need explicit caller-side lifecycle instrumentation.'],
  },
  webapp: {
    source_client: 'webapp',
    coverage_level: 'generic',
    surfaces: [
      {
        surface: 'OrgX web reporting routes',
        status: 'wired',
        proof: '/api/operator/chronicle and Today-page wiring read the shared operator chronicle.',
        reporting_role:
          'Shows the same reporting truth in product UI when the user is not inside an AI client.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Load Today/operator chronicle UI and verify desktop plus mobile render the same reporting sections.',
    ],
    gaps: ['Web UI still needs visual proof whenever reporting layout changes.'],
  },
  other: {
    source_client: 'other',
    coverage_level: 'generic',
    surfaces: [
      {
        surface: 'Generic MCP tools',
        status: 'fallback',
        proof: 'Unknown clients receive the public MCP tool registry and generic activation loop.',
        reporting_role:
          'Explicit report calls can work, but client-native lifecycle capture is unknown.',
      },
    ],
    reporting_entrypoints: REPORTING_ENTRYPOINTS,
    required_proof: [
      'Verify tool discovery and one chronicle call in the target client.',
    ],
    gaps: ['Unknown client hooks must be audited before claiming seamless reporting.'],
  },
};

export function getClientHookCoverage(
  sourceClient: SourceClient | null | undefined
): ClientHookCoverage {
  return CLIENT_HOOK_COVERAGE[sourceClient ?? 'other'];
}
