export const PREFERRED_TOOL_GUIDANCE = {
  pendingDecisions: {
    legacyToolId: 'get_pending_decisions',
    replacementToolId: 'list_entities',
    replacementUsage: 'type=decision and status=pending',
  },
  decisionHistory: {
    legacyToolId: 'get_decision_history',
    replacementToolId: 'query_org_memory',
    replacementUsage: 'scope=decisions with a topic query',
  },
  nextUpQueue: {
    legacyToolId: 'score_next_up_queue',
    replacementToolId: 'recommend_next_action',
    replacementUsage: 'workspace or initiative recommendations',
  },
  outcomeAttribution: {
    legacyToolId: 'get_outcome_attribution',
    replacementToolId: 'get_morning_brief',
    replacementUsage: 'workspace brief with value and exception summaries',
  },
} as const;

export type PreferredToolGuidanceKey = keyof typeof PREFERRED_TOOL_GUIDANCE;

export function preferredToolCallout(key: PreferredToolGuidanceKey): string {
  const guidance = PREFERRED_TOOL_GUIDANCE[key];
  return `Prefer \`${guidance.replacementToolId}\` with ${guidance.replacementUsage} for new prompts, skills, and examples.`;
}

export function compatibilityAliasDescription(
  key: PreferredToolGuidanceKey,
  baseDescription: string
): string {
  return `${baseDescription} Compatibility alias retained for older clients. ${preferredToolCallout(
    key
  )}`;
}
