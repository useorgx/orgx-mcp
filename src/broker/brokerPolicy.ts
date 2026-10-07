/**
 * Which brokered tools a run may see and call.
 *
 * Three layers, narrowest wins:
 *   1. the token's grant for the connection: an explicit tool allowlist
 *      (`tools`) and/or read-only (`ro`);
 *   2. the vendor's own annotations, mapped onto OrgX's risk classes:
 *      `readOnlyHint: true` → low; `destructiveHint: false` → key; anything
 *      else (destructive, or unannotated, which MCP treats as destructive) →
 *      high;
 *   3. the person's connector permissions (Settings → Connectors): a per-tool
 *      answer, else the answer for the tool's risk class (default low allow,
 *      key and high ask).
 *
 * `deny` and anything outside the grant are hidden from `tools/list` and
 * refused on `tools/call`. `ask` stays listed (so the agent can say what it
 * needs) but a call is refused with a "needs approval" result for now; the
 * approval hold comes in a later phase. Approvals stay a human click.
 */

import type { BrokerConnectionGrant } from './brokerToken';
import type { BrokerToolPolicy } from './brokerAppClient';

export type RiskClass = 'low' | 'key' | 'high';

export type McpTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } & Record<string, unknown>;
  _meta?: Record<string, unknown>;
} & Record<string, unknown>;

export type ToolDecision =
  | { allow: true; risk: RiskClass }
  | { allow: false; code: 'not_allowed' | 'needs_approval'; risk: RiskClass | null };

export function classifyTool(tool: Pick<McpTool, 'annotations'> | undefined): RiskClass {
  const annotations = tool?.annotations ?? {};
  if (annotations.readOnlyHint === true) return 'low';
  if (annotations.destructiveHint === false) return 'key';
  return 'high';
}

export function decideTool(
  name: string,
  tool: McpTool | undefined,
  grant: BrokerConnectionGrant,
  policy: BrokerToolPolicy
): ToolDecision {
  if (grant.tools && !grant.tools.includes(name)) {
    return { allow: false, code: 'not_allowed', risk: null };
  }
  // A tool the vendor does not list is not one we can classify.
  if (!tool) return { allow: false, code: 'not_allowed', risk: null };
  const risk = classifyTool(tool);
  if (grant.ro && risk !== 'low') return { allow: false, code: 'not_allowed', risk };
  // Own keys only: a tool named `toString` must not read Object.prototype.
  const answer = Object.hasOwn(policy.tools, name) ? policy.tools[name] : policy.groups[risk];
  if (answer === 'allow') return { allow: true, risk };
  if (answer === 'ask') return { allow: false, code: 'needs_approval', risk };
  return { allow: false, code: 'not_allowed', risk };
}

/** `tools/list` result tools, minus what the run may not see. */
export function filterToolList(
  tools: unknown[],
  grant: BrokerConnectionGrant,
  policy: BrokerToolPolicy
): McpTool[] {
  const out: McpTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object' || typeof (raw as McpTool).name !== 'string') continue;
    const tool = raw as McpTool;
    const decision = decideTool(tool.name, tool, grant, policy);
    if (decision.allow) {
      out.push(tool);
    } else if (decision.code === 'needs_approval') {
      out.push({
        ...tool,
        _meta: { ...(tool._meta ?? {}), 'orgx/broker': { approval: 'required', risk: decision.risk } },
      });
    }
  }
  return out;
}

/** The result a refused `tools/call` gets, as a tool error the agent can read. */
export function refusedCallResult(
  name: string,
  decision: Extract<ToolDecision, { allow: false }>
): Record<string, unknown> {
  const text =
    decision.code === 'needs_approval'
      ? `"${name}" needs a person's approval in OrgX, so it was not run. Ask the workspace owner to allow it for this agent in OrgX, or continue without it.`
      : `"${name}" is not available to this run, so it was not run.`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    _meta: { 'orgx/broker': { code: decision.code, tool: name, risk: decision.risk } },
  };
}

/**
 * Per-connection tool catalog learned from `tools/list` responses passing
 * through (and fetched once when a call arrives first), so a call can be
 * classified by the vendor's own annotations.
 */
export class ToolCatalogCache {
  private readonly entries = new Map<string, { tools: Map<string, McpTool>; until: number }>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  get(key: string, now: number): Map<string, McpTool> | null {
    const entry = this.entries.get(key);
    return entry && entry.until > now ? entry.tools : null;
  }

  remember(key: string, tools: unknown[], now: number, append = false) {
    const existing = append ? this.get(key, now) : null;
    const map = new Map(existing ?? []);
    for (const raw of tools) {
      if (raw && typeof raw === 'object' && typeof (raw as McpTool).name === 'string') {
        map.set((raw as McpTool).name, raw as McpTool);
      }
    }
    if (this.entries.size > 512) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    }
    this.entries.set(key, { tools: map, until: now + this.ttlMs });
  }
}
