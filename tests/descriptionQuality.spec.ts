import { describe, expect, it } from 'vitest';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';

/**
 * Description-quality lint.
 *
 * Every MCP tool description is the agent's primary navigation aid. When a
 * description loses its USE WHEN / NEXT / DO NOT USE anchors, agents drift
 * from the canonical tool to a generic one. This test enforces the floor so
 * description rot fails CI instead of degrading agent selection accuracy
 * silently.
 *
 * Anchors required on every registered tool:
 *   - "USE WHEN:" — when the agent should reach for this tool
 *   - "NEXT:" — what the agent should do after a successful call
 *
 * Anchors required on write/destructive tools (annotations.readOnlyHint !== true):
 *   - "DO NOT USE:" — the most common wrong-tool mistakes to avoid
 *
 * Tools listed in EXEMPT_FROM_ANCHORS are explicitly opted out (e.g. low-level
 * introspection tools where the description is already self-evident from the
 * title and the tool surface is not part of the agent's normal selection
 * space). Removing an exemption requires that the tool gain the anchors.
 */

/**
 * Tools where anchors are not required because the tool is not part of the
 * agent's normal selection space (bootstrap/introspection/protocol).
 */
const PERMANENTLY_EXEMPT = new Set<string>([
  'orgx_bootstrap',
  'orgx_describe_tool',
  'orgx_describe_action',
  'workspace',
  'configure_org',
  'stats',
  'sync_client_state',
  'authenticate',
  'complete_authentication',
]);

/**
 * Acknowledged tech debt: tools that ship without one or more anchors today.
 * The lint enforces the floor — adding a new entry here on a tool that
 * previously had its anchor will fail in the regression check below.
 *
 * Removing a tool from these sets requires giving it the missing anchor.
 *
 * Tracked: OrgX initiative `Agent ↔ OrgX intersection verification`,
 *          milestone `Tool discovery + description anchors locked`.
 */
const KNOWN_MISSING_USE_WHEN = new Set<string>([
  'remember_decision',
  'recall_memory',
  'approve_agent_work',
  'delegate_agent_task',
  'track_project_progress',
  'get_outcome_attribution',
  'configure_outcome_type',
  'record_outcome',
  'get_my_trust_context',
  'orgx_free_audit',
  'start_autonomous_session',
  'get_morning_brief',
  'get_relevant_learnings',
  'submit_learning',
]);

const KNOWN_MISSING_NEXT = new Set<string>([
  'queue_action',
  'remember_decision',
  'recall_memory',
  'approve_agent_work',
  'delegate_agent_task',
  'track_project_progress',
  'resume_plan_session',
  'create_milestone',
  'create_decision',
  'validate_studio_content',
  'pin_workstream',
  'get_outcome_attribution',
  'configure_outcome_type',
  'record_outcome',
  'get_my_trust_context',
  'orgx_free_audit',
  'start_autonomous_session',
  'get_morning_brief',
  'get_relevant_learnings',
  'submit_learning',
]);

const KNOWN_MISSING_DO_NOT_USE = new Set<string>([
  'scoring_config',
  'queue_action',
  'remember_decision',
  'approve_agent_work',
  'delegate_agent_task',
  'create_task',
  'create_milestone',
  'create_decision',
  'validate_studio_content',
  'pin_workstream',
  'configure_outcome_type',
  'record_outcome',
  'start_autonomous_session',
  'submit_learning',
]);

interface ToolDef {
  id: string;
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function collectTools(): ToolDef[] {
  const all: ToolDef[] = [];
  const sources = [
    CHATGPT_TOOL_DEFINITIONS,
    PLAN_SESSION_TOOLS,
    STREAM_TOOL_DEFINITIONS,
    CLIENT_INTEGRATION_TOOL_DEFINITIONS,
    CONTRACT_TOOL_DEFINITIONS,
    FLYWHEEL_TOOL_DEFINITIONS,
  ] as ReadonlyArray<ReadonlyArray<unknown>>;
  for (const source of sources) {
    for (const tool of source) {
      const t = tool as ToolDef;
      if (typeof t.id === 'string' && typeof t.description === 'string') {
        all.push(t);
      }
    }
  }
  return all;
}

describe('description quality lint', () => {
  const tools = collectTools();

  it('collects at least 50 tool definitions', () => {
    // Sanity check — if this drops below the floor, a definition array stopped exporting.
    expect(tools.length).toBeGreaterThanOrEqual(50);
  });

  it('every tool description has a "USE WHEN:" anchor (excluding known debt)', () => {
    const missing = tools
      .filter((t) => !PERMANENTLY_EXEMPT.has(t.id))
      .filter((t) => !KNOWN_MISSING_USE_WHEN.has(t.id))
      .filter((t) => !t.description.includes('USE WHEN:'))
      .map((t) => t.id);
    expect(
      missing,
      `new tools missing "USE WHEN:" anchor: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every tool description has a "NEXT:" anchor (excluding known debt)', () => {
    const missing = tools
      .filter((t) => !PERMANENTLY_EXEMPT.has(t.id))
      .filter((t) => !KNOWN_MISSING_NEXT.has(t.id))
      .filter((t) => !t.description.includes('NEXT:'))
      .map((t) => t.id);
    expect(
      missing,
      `new tools missing "NEXT:" anchor: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every write-capable tool description has a "DO NOT USE" anchor (excluding known debt)', () => {
    const missing = tools
      .filter((t) => !PERMANENTLY_EXEMPT.has(t.id))
      .filter((t) => !KNOWN_MISSING_DO_NOT_USE.has(t.id))
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .filter((t) => !t.description.includes('DO NOT USE'))
      .map((t) => t.id);
    expect(
      missing,
      `new write-capable tools missing "DO NOT USE" anchor: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('known-debt sets only contain tools that actually lack the anchor', () => {
    // If a debt entry no longer matches reality (anchor was added), we want
    // CI to fail so the entry is removed and the floor moves up.
    const stillMissingUseWhen = (id: string) => {
      const tool = tools.find((t) => t.id === id);
      return tool ? !tool.description.includes('USE WHEN:') : false;
    };
    const stillMissingNext = (id: string) => {
      const tool = tools.find((t) => t.id === id);
      return tool ? !tool.description.includes('NEXT:') : false;
    };
    const stillMissingDoNotUse = (id: string) => {
      const tool = tools.find((t) => t.id === id);
      if (!tool) return false;
      if (tool.annotations?.readOnlyHint === true) return false;
      return !tool.description.includes('DO NOT USE');
    };

    const stale: string[] = [];
    for (const id of KNOWN_MISSING_USE_WHEN) {
      if (!stillMissingUseWhen(id)) stale.push(`USE WHEN debt stale: ${id}`);
    }
    for (const id of KNOWN_MISSING_NEXT) {
      if (!stillMissingNext(id)) stale.push(`NEXT debt stale: ${id}`);
    }
    for (const id of KNOWN_MISSING_DO_NOT_USE) {
      if (!stillMissingDoNotUse(id)) stale.push(`DO NOT USE debt stale: ${id}`);
    }
    expect(
      stale,
      `Remove these from the KNOWN_MISSING_* sets — they now have the anchor: ${stale.join('; ')}`
    ).toEqual([]);
  });

  it('descriptions stay within an agent-friendly length budget (<= 1200 chars)', () => {
    // Long descriptions blow up tools/list payload size and degrade selection.
    const oversized = tools
      .filter((t) => t.description.length > 1200)
      .map((t) => `${t.id} (${t.description.length} chars)`);
    expect(
      oversized,
      `tool descriptions over 1200 chars: ${oversized.join(', ')}`
    ).toEqual([]);
  });

  it('descriptions open with a verb-first action word, not an article', () => {
    // "The pending decisions list" → bad. "List pending decisions" → good.
    const ARTICLE_RE = /^(?:a|an|the)\s/i;
    const opensWithArticle = tools
      .filter((t) => ARTICLE_RE.test(t.description.trim()))
      .map((t) => t.id);
    expect(
      opensWithArticle,
      `tool descriptions open with an article: ${opensWithArticle.join(', ')}`
    ).toEqual([]);
  });
});
