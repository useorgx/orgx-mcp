import { buildEntityLink } from './deepLinks';

/**
 * Decision resolution is intentionally session-only in the OrgX API. An MCP
 * service assertion proves delegation, not that a person made the ruling.
 */
export function directHumanDecisionActionRequired(
  decisionId: string,
  action: 'approve' | 'reject'
) {
  const review = buildEntityLink('decision', decisionId, {
    label: `${action === 'approve' ? 'Approve' : 'Reject'} decision`,
  });
  return {
    message: `Direct human action required: open ${review.url} to ${action} this decision.`,
    options: {
      code: 'direct_human_decision_action_required',
      status: 403,
      details: {
        decision_id: decisionId,
        requested_action: action,
        review_url: review.url,
        authority_kind: 'human_session',
        reason:
          'MCP delegation is not evidence that a person made the ruling.',
      },
    },
  } as const;
}

