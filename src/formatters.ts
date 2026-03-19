import { entityLinkMarkdown } from './deepLinks';

export interface OrgXInitiative {
  id: string;
  title: string;
  summary?: string | null;
  objective_id?: string | null;
  objective?: string | null;
  impact?: string | null;
  status?: string | null;
  milestones?: Array<{
    id: string;
    title: string;
    status?: string | null;
    due_date?: string | null;
  }>;
}

export function formatInitiativeMarkdown(initiative: OrgXInitiative) {
  const milestoneLines = initiative.milestones?.map((m) => {
    const dueDate = m.due_date ? ` (due: ${m.due_date})` : '';
    const status = m.status ? `[${m.status}]` : '';
    const link = entityLinkMarkdown('milestone', m.id, m.title);
    return `- ${status} ${link}${dueDate}`.trim();
  });

  const initiativeLink = entityLinkMarkdown(
    'initiative',
    initiative.id,
    'View in OrgX'
  );

  return [
    `# ${initiative.title}`,
    '',
    initiative.summary ? `**Summary**: ${initiative.summary}` : null,
    initiative.objective ? `**Objective**: ${initiative.objective}` : null,
    initiative.impact ? `**Impact**: ${initiative.impact}` : null,
    initiative.status ? `**Status**: ${initiative.status}` : null,
    '',
    '## Milestones',
    milestoneLines && milestoneLines.length > 0
      ? milestoneLines.join('\n')
      : '- None yet',
    '',
    initiativeLink,
  ]
    .filter(Boolean)
    .join('\n');
}
