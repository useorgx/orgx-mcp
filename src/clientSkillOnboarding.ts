import {
  detectSourceClient,
  type McpClientInfo,
  type SourceClient,
} from './cross-pollination';
import type { SkillSeed } from './skillCatalog';

type SkillLike = {
  id?: string;
  name?: string;
  title?: string;
  description?: string | null;
  trigger_keywords?: unknown;
  trigger_domains?: unknown;
};

export type SkillSuggestion = {
  skill_name: string;
  title: string;
  reason: string;
  score: number;
  already_available: boolean;
};

export type ClientSkillOnboarding = {
  source_client: SourceClient | null;
  first_use: boolean;
  seeded_defaults: boolean;
  suggestions: SkillSuggestion[];
  message: string | null;
  next_action?: {
    tool: 'list_entities';
    label: string;
    args: {
      type: 'skill';
      seed_defaults: true;
    };
  };
};

const CLIENT_STARTER_SKILLS: Record<SourceClient, string[]> = {
  cursor: [
    'sprint_plan_optimizer',
    'release_readiness_review',
    'quality_gate_review',
  ],
  claude: [
    'initiative_breakdown',
    'quality_gate_review',
    'retro_synthesis',
  ],
  chatgpt: ['initiative_breakdown', 'stakeholder_update', 'competitive_scan'],
  vscode: [
    'sprint_plan_optimizer',
    'quality_gate_review',
    'release_readiness_review',
  ],
  goose: ['incident_triage', 'postmortem_draft', 'retro_synthesis'],
  api: ['initiative_breakdown', 'release_readiness_review', 'quality_gate_review'],
  webapp: ['initiative_breakdown', 'stakeholder_update', 'competitive_scan'],
  other: ['initiative_breakdown', 'quality_gate_review', 'stakeholder_update'],
};

const CLIENT_DOMAIN_WEIGHTS: Record<SourceClient, Record<string, number>> = {
  cursor: { engineering: 3, operations: 2, product: 1 },
  claude: { engineering: 2, product: 2, operations: 1 },
  chatgpt: { product: 3, marketing: 2, sales: 2, operations: 1 },
  vscode: { engineering: 3, operations: 1 },
  goose: { operations: 3, engineering: 2 },
  api: { engineering: 2, operations: 1, product: 1 },
  webapp: { product: 2, marketing: 1, sales: 1 },
  other: { product: 1, engineering: 1, operations: 1 },
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function normalizeSkill(skill: SkillLike | SkillSeed) {
  const rawTitle =
    'title' in skill && typeof skill.title === 'string'
      ? skill.title.trim()
      : '';
  const name =
    (typeof skill.name === 'string' && skill.name.trim()) ||
    rawTitle ||
    'unknown_skill';
  const title =
    rawTitle ||
    (typeof skill.name === 'string' && skill.name.trim()) ||
    name;
  const description =
    typeof skill.description === 'string' ? skill.description.trim() : '';

  return {
    name,
    title,
    description,
    triggerKeywords: asStringArray(
      'trigger_keywords' in skill ? skill.trigger_keywords : []
    ),
    triggerDomains: asStringArray(
      'trigger_domains' in skill ? skill.trigger_domains : []
    ),
  };
}

function normalizeSearchTerms(search?: string | null): string[] {
  if (!search || !search.trim()) return [];
  return search
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

export function resolveSourceClientFromContext(
  context: unknown
): SourceClient | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }

  const client = (context as { client?: McpClientInfo }).client;
  if (!client?.name) return null;
  return detectSourceClient(client);
}

export function buildClientSkillOnboarding(params: {
  context?: unknown;
  search?: string | null;
  skills: SkillLike[];
  defaultCatalog: SkillSeed[];
  seededDefaults?: boolean;
}): ClientSkillOnboarding | null {
  const sourceClient = resolveSourceClientFromContext(params.context);
  const searchTerms = normalizeSearchTerms(params.search);
  const availableSkills = params.skills.map(normalizeSkill);
  const catalog = params.defaultCatalog.map(normalizeSkill);
  const byName = new Map<string, ReturnType<typeof normalizeSkill>>();

  for (const skill of catalog) byName.set(skill.name, skill);
  for (const skill of availableSkills) byName.set(skill.name, skill);

  const candidatePool = Array.from(byName.values());
  const availableNames = new Set(availableSkills.map((skill) => skill.name));
  const firstUse = availableSkills.length === 0;
  const domainWeights = CLIENT_DOMAIN_WEIGHTS[sourceClient ?? 'other'];
  const starterSkills = CLIENT_STARTER_SKILLS[sourceClient ?? 'other'];

  const suggestions = candidatePool
    .map((skill) => {
      let score = 0;
      const reasons: string[] = [];

      if (starterSkills.includes(skill.name)) {
        score += firstUse ? 5 : 2;
        reasons.push(
          firstUse
            ? 'good first skill for this client'
            : 'still fits this client well'
        );
      }

      const domainScore = skill.triggerDomains.reduce(
        (sum, domain) => sum + (domainWeights[domain] ?? 0),
        0
      );
      if (domainScore > 0) {
        score += domainScore;
        reasons.push('matches the client workflow domain');
      }

      const keywordMatches = searchTerms.filter((term) => {
        return (
          skill.name.toLowerCase().includes(term) ||
          skill.title.toLowerCase().includes(term) ||
          skill.description.toLowerCase().includes(term) ||
          skill.triggerKeywords.some((keyword) =>
            keyword.toLowerCase().includes(term)
          )
        );
      });
      if (keywordMatches.length > 0) {
        score += keywordMatches.length * 6;
        reasons.push(`matches "${keywordMatches.join(', ')}"`);
      }

      if (availableNames.has(skill.name)) {
        score += 1;
      }

      return {
        skill_name: skill.name,
        title: skill.title,
        reason: reasons.join('; '),
        score,
        already_available: availableNames.has(skill.name),
      } satisfies SkillSuggestion;
    })
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.skill_name.localeCompare(b.skill_name))
    .slice(0, 3);

  if (!sourceClient && suggestions.length === 0) {
    return null;
  }

  const message = firstUse
    ? sourceClient
      ? `Detected ${sourceClient}. Start with one of the recommended skills below.`
      : 'Start with one of the recommended skills below.'
    : sourceClient
    ? `Detected ${sourceClient}. These skills fit this workflow best right now.`
    : null;

  return {
    source_client: sourceClient,
    first_use: firstUse,
    seeded_defaults: params.seededDefaults === true,
    suggestions,
    message,
    ...(firstUse && !params.seededDefaults
      ? {
          next_action: {
            tool: 'list_entities' as const,
            label: 'Seed the default skill catalog',
            args: {
              type: 'skill' as const,
              seed_defaults: true as const,
            },
          },
        }
      : {}),
  };
}

export function formatClientSkillOnboarding(
  onboarding: ClientSkillOnboarding | null
): string {
  if (!onboarding || onboarding.suggestions.length === 0) return '';

  const lines: string[] = [''];
  if (onboarding.message) {
    lines.push(onboarding.message);
  }
  lines.push('Recommended skills:');
  for (const suggestion of onboarding.suggestions) {
    lines.push(
      `- ${suggestion.title}: ${suggestion.reason || 'recommended for this workflow'}`
    );
  }
  if (onboarding.first_use && !onboarding.seeded_defaults) {
    lines.push(
      'Tip: set `seed_defaults=true` on `list_entities type=skill` to seed the default skill catalog first.'
    );
  }
  return lines.join('\n');
}
