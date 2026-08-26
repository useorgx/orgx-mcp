import { describe, expect, it } from 'vitest';

import { directHumanDecisionActionRequired } from '../src/directHumanDecisionAction';

describe('directHumanDecisionActionRequired', () => {
  it.each(['approve', 'reject'] as const)(
    'fails %s closed with an actionable human-session URL',
    (action) => {
      const result = directHumanDecisionActionRequired('decision-123', action);
      expect(result.options).toEqual({
        code: 'direct_human_decision_action_required',
        status: 403,
        details: {
          decision_id: 'decision-123',
          requested_action: action,
          review_url: 'https://useorgx.com/decisions/decision-123',
          authority_kind: 'human_session',
          reason:
            'MCP delegation is not evidence that a person made the ruling.',
        },
      });
      expect(result.message).toContain(result.options.details.review_url);
    }
  );
});
