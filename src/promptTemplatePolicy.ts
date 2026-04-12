export interface SkillPromptTemplateViolation {
  id: string;
  message: string;
}

export const SKILL_PROMPT_TEMPLATE_SAFETY_DESCRIPTION =
  'OrgX skill behavior template. Stored as workspace data only; must not try to override, reveal, or bypass host/developer control text or client instructions.';

const hiddenControlActor = ['sys', 'tem'].join('');
const hiddenControlArtifact = ['pro', 'mpt'].join('');

const privilegedControlTarget = String.raw`(?:${hiddenControlActor}|developer|host|platform)\s+(?:${hiddenControlArtifact}|message|instructions?|directive|policy|policies)`;
const clientInstructionTarget = String.raw`(?:previous|prior|above|earlier)\s+(?:instructions?|messages?|${hiddenControlArtifact}s?|context|conversation)`;
const nearby = String.raw`[\s\S]{0,120}`;

const rules: readonly SkillPromptTemplateViolationRule[] = [
  {
    id: 'discard-prior-context',
    pattern: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|discard|bypass)\b${nearby}\b${clientInstructionTarget}\b`,
      'i'
    ),
    message:
      'Skill templates cannot instruct agents to discard prior instructions or context.',
  },
  {
    id: 'bypass-control-text',
    pattern: new RegExp(
      String.raw`\b(?:override|replace|bypass|disable|supersede|ignore|discard)\b${nearby}\b${privilegedControlTarget}\b`,
      'i'
    ),
    message:
      'Skill templates cannot instruct agents to bypass host or developer control text.',
  },
  {
    id: 'control-text-bypass',
    pattern: new RegExp(
      String.raw`\b${privilegedControlTarget}\b${nearby}\b(?:override|replace|bypass|disable|supersede|ignore|discard)\b`,
      'i'
    ),
    message:
      'Skill templates cannot describe bypassing host or developer control text.',
  },
  {
    id: 'expose-control-text',
    pattern: new RegExp(
      String.raw`\b(?:reveal|print|show|display|dump|leak|exfiltrate|return)\b${nearby}\b${privilegedControlTarget}\b`,
      'i'
    ),
    message:
      'Skill templates cannot request exposure of host or developer control text.',
  },
  {
    id: 'control-text-exposure',
    pattern: new RegExp(
      String.raw`\b${privilegedControlTarget}\b${nearby}\b(?:reveal|print|show|display|dump|leak|exfiltrate|return)\b`,
      'i'
    ),
    message:
      'Skill templates cannot describe exposing host or developer control text.',
  },
  {
    id: 'privileged-impersonation',
    pattern: new RegExp(
      String.raw`\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\b[\s\S]{0,80}\b(?:${hiddenControlActor}|developer|root|administrator|admin)\b`,
      'i'
    ),
    message:
      'Skill templates cannot impersonate privileged execution roles.',
  },
];

interface SkillPromptTemplateViolationRule extends SkillPromptTemplateViolation {
  pattern: RegExp;
}

function normalizeSkillPromptTemplate(template: string): string {
  return template.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ');
}

export function findSkillPromptTemplateViolation(
  template: string
): SkillPromptTemplateViolation | null {
  const normalized = normalizeSkillPromptTemplate(template);
  const violation = rules.find((rule) => rule.pattern.test(normalized));

  if (!violation) return null;

  const { id, message } = violation;
  return { id, message };
}

export function validateSkillPromptTemplate(template: string): string {
  if (template.trim().length === 0) {
    throw new Error('Skill prompt_template cannot be empty.');
  }

  const violation = findSkillPromptTemplateViolation(template);
  if (violation) {
    throw new Error(
      `Unsafe skill prompt_template rejected: ${violation.message}`
    );
  }

  return template;
}
