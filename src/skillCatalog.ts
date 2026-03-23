export interface SkillSeed {
  name: string;
  description: string;
  prompt_template: string;
  trigger_keywords: string[];
  trigger_domains: string[];
  checklist: string[];
}

export const DEFAULT_SKILL_CATALOG: SkillSeed[] = [
  {
    name: 'initiative_breakdown',
    description: 'Break a high-level initiative into scoped workstreams and milestones.',
    prompt_template:
      'Given an initiative goal, produce workstreams, milestones, and tasks with dependencies and sequencing.',
    trigger_keywords: ['initiative', 'breakdown', 'workstream', 'milestone'],
    trigger_domains: ['product', 'engineering', 'operations'],
    checklist: ['Clear goal', 'Named workstreams', 'Dependencies captured'],
  },
  {
    name: 'release_readiness_review',
    description: 'Run a release readiness check before shipping.',
    prompt_template:
      'Review the release scope and produce blockers, risk level, and go/no-go recommendation.',
    trigger_keywords: ['release', 'go-live', 'readiness', 'launch'],
    trigger_domains: ['engineering', 'operations'],
    checklist: ['Tests pass', 'Rollback plan', 'Monitoring coverage'],
  },
  {
    name: 'prd_outline',
    description: 'Generate a concise PRD outline with measurable outcomes.',
    prompt_template:
      'Produce a PRD outline with problem statement, goals, requirements, success metrics, and non-goals.',
    trigger_keywords: ['prd', 'requirements', 'product doc'],
    trigger_domains: ['product'],
    checklist: ['Problem framing', 'Scope boundaries', 'Metrics'],
  },
  {
    name: 'incident_triage',
    description: 'Triage incidents with severity, impact, and next actions.',
    prompt_template:
      'Summarize incident impact, probable root cause, and immediate containment steps.',
    trigger_keywords: ['incident', 'outage', 'sev', 'triage'],
    trigger_domains: ['operations', 'engineering'],
    checklist: ['Severity set', 'Owner assigned', 'Containment actions listed'],
  },
  {
    name: 'postmortem_draft',
    description: 'Draft a blameless postmortem from timeline and evidence.',
    prompt_template:
      'Create a postmortem with timeline, contributing factors, customer impact, and corrective actions.',
    trigger_keywords: ['postmortem', 'retro', 'incident review'],
    trigger_domains: ['operations', 'engineering'],
    checklist: ['Timeline complete', 'Root causes', 'Action owners'],
  },
  {
    name: 'stakeholder_update',
    description: 'Create executive and team stakeholder updates from workstream state.',
    prompt_template:
      'Summarize status, wins, blockers, and asks in an executive-ready weekly update.',
    trigger_keywords: ['status update', 'stakeholder', 'weekly update'],
    trigger_domains: ['product', 'operations', 'sales'],
    checklist: ['Progress summary', 'Risks', 'Decisions needed'],
  },
  {
    name: 'competitive_scan',
    description: 'Analyze competitive landscape and positioning implications.',
    prompt_template:
      'Produce a competitor scan with differentiators, risks, and recommended positioning moves.',
    trigger_keywords: ['competitive', 'positioning', 'market'],
    trigger_domains: ['marketing', 'sales', 'product'],
    checklist: ['Top competitors', 'Differentiators', 'Messaging recommendations'],
  },
  {
    name: 'sprint_plan_optimizer',
    description: 'Optimize sprint scope based on capacity and dependency risk.',
    prompt_template:
      'Rebalance sprint tasks for capacity, dependency order, and delivery confidence.',
    trigger_keywords: ['sprint', 'planning', 'capacity'],
    trigger_domains: ['engineering', 'product'],
    checklist: ['Capacity fit', 'Dependency order', 'Risk-adjusted commitments'],
  },
  {
    name: 'quality_gate_review',
    description: 'Evaluate output quality against acceptance criteria.',
    prompt_template:
      'Review deliverables against acceptance criteria and provide pass/fail with remediation steps.',
    trigger_keywords: ['quality gate', 'acceptance criteria', 'review'],
    trigger_domains: ['engineering', 'design', 'operations'],
    checklist: ['Criteria coverage', 'Defects listed', 'Remediation plan'],
  },
  {
    name: 'retro_synthesis',
    description: 'Synthesize retrospectives into durable learnings and follow-ups.',
    prompt_template:
      'Convert retrospective notes into themes, root causes, and prioritized improvement tasks.',
    trigger_keywords: ['retro', 'retrospective', 'learnings'],
    trigger_domains: ['product', 'engineering', 'operations'],
    checklist: ['Themes identified', 'Action items prioritized', 'Owners assigned'],
  },
];
