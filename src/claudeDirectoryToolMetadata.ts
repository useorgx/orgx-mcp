import { CLAUDE_DIRECTORY_TOOL_ADAPTERS } from './claudeDirectoryTools';

/**
 * Narrow descriptions for Anthropic's directory policy. Describe each tool's
 * own function and side effects without instructions to call other tools.
 * General-purpose profile descriptions remain unchanged.
 */
export const CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  orgx_search:
    'Search or browse OrgX entities, decisions, artifacts, organizational memory, and work receipts when prior work or evidence needs to be retrieved. Supports workspace and initiative filters and paginated typed searches. Mixed relevance searches record metered MCP allowance usage; business records are unchanged.',
  orgx_inspect:
    'Read one named OrgX entity by type and ID, including its owners, state, linked decisions, and available execution context. Suitable for checking a specific initiative, task, decision, artifact, or plan session. Does not modify business records.',
  orgx_recommend:
    'Read prioritization context when assessing the next action, or summarize operator activity for a reporting window. next_action recommends work and records metered MCP allowance usage. morning_brief reads the operator chronicle when available; it is a reporting summary rather than an autonomous-session brief. Does not modify business records.',
  get_agent_status:
    'Read current OrgX agent activity, run progress, and status for an agent or workspace when checking delegated work. Successful calls record metered MCP allowance usage without changing business records.',
  get_initiative_pulse:
    'Read health, milestones, blockers, and recent activity for an OrgX initiative selected by ID or name when checking project progress. Successful calls record metered MCP allowance usage without changing business records.',
  get_morning_brief:
    'Read curated receipts, exceptions, value signals, and ROI changes from an OrgX autonomous session when catching up on agent work. Uses the supplied session ID or the most recent session for the workspace. Does not modify business records.',
  get_operator_chronicle:
    'Read an OrgX workspace reporting summary for yesterday, the week, or 30 days when reviewing operator activity. Includes decision chronology, proof, artifacts, PR receipts, active initiatives, goals, priorities, velocity, and reporting gaps when available. Does not modify business records.',
  orgx_bootstrap:
    'Load authenticated OrgX workspace or initiative context, granted scopes, work routing, owners, decisions, acceptance checks, blockers, and linked evidence. Can bind the active context for the MCP session. Does not create or change business work records.',
  check_execution_readiness:
    'Read whether an OrgX workspace has the execution credentials needed for agent dispatch and report missing prerequisites. Does not provision credentials, create work, or dispatch a run.',
  orgx_command_status:
    'Read the current status of an OrgX command, decision, entity, artifact, plan session, or agent run identified by kind and ID. Supports polling asynchronous work without applying a state change.',
  review_artifact:
    'Read an OrgX artifact awaiting review, selected by artifact ID or scoped to an entity or workspace. Returns its preview, versions, provenance, verification, and human review context. Does not approve the artifact or request changes.',
  orgx_attach:
    'Attach a linked artifact or proof URL to an OrgX initiative, workstream, milestone, task, or decision. Requires an artifact title, type, and artifact URL or external URL. Can store business outcome, ownership, review date, verification, and provenance alongside the artifact. An inline markdown preview supports the linked deliverable.',
  orgx_submit_receipt:
    'Append a durable OrgX proof, outcome, quality, attribution, or learning receipt anchored to work or an artifact. Stores the summary, evidence URLs or metrics, business outcome, verification status, work status, and optional timing. An idempotency key prevents duplicate receipts on retries.',
  manage_lifecycle:
    'Pause, resume, retry, or cancel an OrgX initiative, workstream, milestone, task, or agent run. Propagates the action to descendant tasks and active runs. Pause and cancel stop active execution; resume and retry can dispatch agent work, incur model costs, and interact with connected services.',
  resume_agent_run:
    'Resume a paused or automatically closed OrgX agent run after a person activates its Resume control. Updates run status, clears automatic closure markers, and appends resume history. Requires agent write authorization.',
  ...Object.fromEntries(CLAUDE_DIRECTORY_TOOL_ADAPTERS.map((tool) => [tool.id, tool.description])),
};
