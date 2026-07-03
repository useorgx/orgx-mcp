// @vitest-environment jsdom
// Ported from the orgx monorepo when the vendored worker copy was removed.
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function loadInteractionKit() {
  const scriptPath = path.join(
    process.cwd(),
    'public/widgets/shared/interaction-kit.js'
  );
  const script = fs.readFileSync(scriptPath, 'utf8');
  delete (window as typeof window & { OrgXInteractionKit?: unknown })
    .OrgXInteractionKit;
  window.eval(script);
  return (
    window as typeof window & {
      OrgXInteractionKit: {
        filterVisibleInteraction: (
          interaction: Record<string, unknown>,
          state: {
            selectedOptionId: string | null;
            answers: Record<string, unknown>;
          }
        ) => { steps: Array<Record<string, unknown>> };
        getCurrentStep: (
          interaction: Record<string, unknown>,
          currentStepId: string,
          state: {
            selectedOptionId: string | null;
            answers: Record<string, unknown>;
          }
        ) => { id: string };
        getCurrentStepIndex: (
          interaction: Record<string, unknown>,
          currentStepId: string,
          state: {
            selectedOptionId: string | null;
            answers: Record<string, unknown>;
          }
        ) => number;
        resolveSelectedOption: (
          interaction: Record<string, unknown>,
          selectedOptionId: string | null,
          state: {
            selectedOptionId: string | null;
            answers: Record<string, unknown>;
          }
        ) => Record<string, unknown> | null;
        validateStep: (params: {
          interaction: Record<string, unknown>;
          step: Record<string, unknown>;
          selectedOptionId: string | null;
          answers: Record<string, unknown>;
          selectedSurfaceIds: string[];
          note: string;
          configRequirements: Record<string, unknown>;
          subrequestPendingCount: number;
          finalPrimaryStatus: 'approved' | 'declined' | 'cancelled';
        }) => { valid: boolean; message: string | null };
      };
    }
  ).OrgXInteractionKit;
}

describe('OrgX widget interaction kit', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the decision queue shell aligned with card actions and pagination states', () => {
    const widgetPath = path.join(
      process.cwd(),
      'public/widgets/decisions.html'
    );
    const html = fs.readFileSync(widgetPath, 'utf8');

    expect(html).toContain('class="decision-shell animate-in"');
    expect(html).toContain('data-page-direction="');
    expect(html).toContain('class="decision-card urgency-');
    expect(html).toContain('decision-action-btn');
    expect(html).toContain('class="reject-composer"');
    expect(html).toContain('class="pagination"');
    expect(html).toContain('class="page-progress" aria-hidden="true"');
    expect(html).toContain('class="page-btn page-btn--prev');
    expect(html).toContain('class="page-btn page-btn--next');
    expect(html).toContain('params-well');
    expect(html).toContain('normalizeDecision');
    expect(html).toContain('approveDecision');
    expect(html).toContain('submitReject');
  });

  it('filters visible steps and fields using the shared interaction rules', () => {
    const kit = loadInteractionKit();
    const interaction = {
      kind: 'compound',
      version: 1,
      steps: [
        {
          id: 'options',
          type: 'options',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'revise', label: 'Request changes' },
          ],
        },
        {
          id: 'questions',
          type: 'questions',
          fields: [
            { id: 'always', type: 'text', label: 'Always' },
            {
              id: 'onlyWhenRevise',
              type: 'text',
              label: 'Revision reason',
              visibility: [{ optionId: 'revise' }],
            },
          ],
        },
        {
          id: 'config',
          type: 'config',
          visibility: [{ fieldId: 'always', truthy: true }],
        },
      ],
    };

    const approveView = kit.filterVisibleInteraction(interaction, {
      selectedOptionId: 'approve',
      answers: {},
    });
    expect(approveView.steps).toHaveLength(2);
    expect(approveView.steps[1].fields).toHaveLength(1);

    const reviseView = kit.filterVisibleInteraction(interaction, {
      selectedOptionId: 'revise',
      answers: { always: 'Ready' },
    });
    expect(reviseView.steps).toHaveLength(3);
    expect(reviseView.steps[1].fields).toHaveLength(2);
  });

  it('keeps step navigation aligned with the filtered interaction state', () => {
    const kit = loadInteractionKit();
    const interaction = {
      kind: 'compound',
      version: 1,
      steps: [
        { id: 'context', type: 'context' },
        {
          id: 'options',
          type: 'options',
          options: [{ id: 'approve', label: 'Approve' }],
        },
      ],
    };

    const currentStep = kit.getCurrentStep(interaction, 'missing', {
      selectedOptionId: null,
      answers: {},
    });
    const currentIndex = kit.getCurrentStepIndex(interaction, 'missing', {
      selectedOptionId: null,
      answers: {},
    });

    expect(currentStep.id).toBe('context');
    expect(currentIndex).toBe(0);
  });

  it('validates option, config, and confirm steps using the shared rules', () => {
    const kit = loadInteractionKit();
    const interaction = {
      kind: 'compound',
      version: 1,
      steps: [
        {
          id: 'options',
          type: 'options',
          required: true,
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'revise', label: 'Request changes', requiresNote: true },
          ],
        },
        {
          id: 'config',
          type: 'config',
          required: true,
          config: { status: 'idle', message: 'Atlas is not configured yet.' },
        },
        {
          id: 'confirm',
          type: 'confirm',
          required: true,
        },
      ],
    };

    expect(
      kit.validateStep({
        interaction,
        step: interaction.steps[0],
        selectedOptionId: null,
        answers: {},
        selectedSurfaceIds: [],
        note: '',
        configRequirements: {},
        subrequestPendingCount: 0,
        finalPrimaryStatus: 'approved',
      })
    ).toEqual({
      valid: false,
      message: 'Choose an option to continue.',
    });

    expect(
      kit.validateStep({
        interaction,
        step: interaction.steps[1],
        selectedOptionId: 'approve',
        answers: {},
        selectedSurfaceIds: [],
        note: '',
        configRequirements: {},
        subrequestPendingCount: 0,
        finalPrimaryStatus: 'approved',
      })
    ).toEqual({
      valid: false,
      message: 'Atlas is not configured yet.',
    });

    expect(
      kit.validateStep({
        interaction,
        step: interaction.steps[2],
        selectedOptionId: 'revise',
        answers: {},
        selectedSurfaceIds: [],
        note: '',
        configRequirements: {},
        subrequestPendingCount: 0,
        finalPrimaryStatus: 'approved',
      })
    ).toEqual({
      valid: false,
      message: 'Add a decision note before submitting.',
    });
  });
});
