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


/**
 * The normal (non-error) result for a model's approve/reject request on
 * orgx_decide / approve_agent_work. The safety rule is unchanged: MCP never
 * settles a decision. The request is valid, so it is answered as a result,
 * not an MCP error: `status: "needs_human"` plus where the person decides.
 * The model must relay review_url and must not say the decision was settled.
 */
export function directHumanDecisionReviewResult(
  decisionId: string,
  action: 'approve' | 'reject'
) {
  const required = directHumanDecisionActionRequired(decisionId, action);
  const reviewUrl = required.options.details.review_url;
  const verb = action === 'approve' ? 'approve' : 'reject';
  return {
    status: 'needs_human' as const,
    decision_id: decisionId,
    requested_action: action,
    review_url: reviewUrl,
    authority_kind: 'human_session' as const,
    message: `Not settled. Only a person can ${verb} this decision: open ${reviewUrl} to decide. Nothing was approved or rejected from this chat.`,
  };
}
