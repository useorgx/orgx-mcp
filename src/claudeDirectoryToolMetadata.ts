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
};
