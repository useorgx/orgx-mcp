import { describe, expect, it } from 'vitest';

import {
  PLAN_SESSION_ACCEPTED_ID_FORMS,
  buildPlanSessionStructuredResult,
  buildCanonicalPlanSessionRef,
  enrichPlanSessionResult,
  normalizePlanSessionId,
  normalizePlanSessionRequestArgs,
} from '../src/planSessionContract';
import { summarizePlanSessionResult } from '../src/toolDefinitions';

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('plan session contract helpers', () => {
  it('normalizes plain UUIDs and OrgX URIs', () => {
    expect(normalizePlanSessionId(SESSION_ID)).toBe(SESSION_ID);
    expect(
      normalizePlanSessionId(`orgx://plan_session/${SESSION_ID}`)
    ).toBe(SESSION_ID);
  });

  it('normalizes object payloads containing session references', () => {
    expect(normalizePlanSessionId({ session_id: SESSION_ID })).toBe(SESSION_ID);
    expect(normalizePlanSessionId({ uri: `orgx://plan_session/${SESSION_ID}` })).toBe(
      SESSION_ID
    );
  });

  it('builds canonical refs with accepted ID forms', () => {
    expect(buildCanonicalPlanSessionRef(SESSION_ID)).toEqual({
      id: SESSION_ID,
      uuid: SESSION_ID,
      uri: `orgx://plan_session/${SESSION_ID}`,
      accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
    });
  });

  it('maps the compact record_edit summary to the API edit contract', () => {
    expect(
      normalizePlanSessionRequestArgs('record_plan_edit', {
        session_id: SESSION_ID,
        edit_summary: 'Added an authority map and evidence requirements.',
      })
    ).toEqual({
      session_id: SESSION_ID,
      edit_type: 'other',
      after_content: 'Added an authority map and evidence requirements.',
    });
  });

  it('enriches start_plan_session and get_active_sessions payloads', () => {
    const started = enrichPlanSessionResult('start_plan_session', {
      id: SESSION_ID,
      title: 'Feature plan',
    });
    expect(started).toMatchObject({
      session_id: SESSION_ID,
      uuid: SESSION_ID,
      uri: `orgx://plan_session/${SESSION_ID}`,
    });

    const listed = enrichPlanSessionResult('get_active_sessions', {
      sessions: [{ id: SESSION_ID, title: 'Feature plan' }],
    });
    expect(listed).toMatchObject({
      accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
    });
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        session_id: SESSION_ID,
        uri: `orgx://plan_session/${SESSION_ID}`,
      }),
    ]);
  });

  it('keeps the current plan visible after improve and edit mutations', () => {
    const improved = buildPlanSessionStructuredResult(
      'improve_plan',
      { suggestions: [], domains_detected: ['product'] },
      {
        session_id: SESSION_ID,
        plan_content: '# Melissa plan\n\n## Outcome\nProof plus next action.',
      }
    );
    expect(improved).toMatchObject({
      session_id: SESSION_ID,
      plan_session: {
        session_id: SESSION_ID,
        current_plan: '# Melissa plan\n\n## Outcome\nProof plus next action.',
        domains_detected: ['product'],
      },
    });

    const edited = buildPlanSessionStructuredResult(
      'record_plan_edit',
      { id: 'edit-1', session_id: SESSION_ID, edit_type: 'change_approach' },
      {
        session_id: SESSION_ID,
        after_content: '# Four workstreams\n\n## Human gate\nApprove outreach.',
      }
    );
    expect(edited).toMatchObject({
      plan_session: {
        session_id: SESSION_ID,
        current_plan: '# Four workstreams\n\n## Human gate\nApprove outreach.',
      },
    });
  });

  it('renders a visible LLM receipt and grounded plan critique', () => {
    const summary = summarizePlanSessionResult('improve_plan', {
      generation: {
        source: 'model',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        requested_model: 'gpt-5.4-mini',
        response_id: 'resp_plan_123',
        failover_used: false,
        input_tokens: 1946,
        output_tokens: 831,
      },
      analysis_summary:
        'The decision owner is clear, but the acceptance boundary is not.',
      domains_detected: ['product', 'operations'],
      learned_from_past: 1,
      suggestions: [
        {
          type: 'missing',
          section: 'Approval boundary',
          suggestion: 'State what Melissa can approve independently.',
          rationale: 'Decision ownership does not define escalation.',
          evidence: '"Preserve Melissa as decision owner."',
          confidence: 0.92,
          source: 'LLM analysis using your "Evidence loop" pattern',
        },
      ],
    });

    expect(summary).toContain(
      'LLM receipt: openai/gpt-5.4-mini (1,946 input / 831 output tokens)'
    );
    expect(summary).toContain('response resp_plan_123');
    expect(summary).toContain(
      'The decision owner is clear, but the acceptance boundary is not.'
    );
    expect(summary).toContain('**Approval boundary**');
    expect(summary).toContain(
      'Evidence: "Preserve Melissa as decision owner."'
    );
    expect(summary).toContain('92% confidence');
  });

  it('does not invent an LLM receipt for legacy improve responses', () => {
    const summary = summarizePlanSessionResult('improve_plan', {
      suggestions: [
        { type: 'improvement', suggestion: 'Name the acceptance owner.' },
      ],
    });

    expect(summary).not.toContain('LLM receipt');
    expect(summary).toContain('Name the acceptance owner.');
  });
});
