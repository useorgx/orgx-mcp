import type { SkillSeed } from './skillCatalog';

type SkillLike = {
  id?: string;
  name?: string;
  title?: string;
  description?: string | null;
  trigger_keywords?: unknown;
  trigger_domains?: unknown;
  _link?: string;
  [key: string]: unknown;
};

export type SkillCatalogEntry = {
  id?: string;
  name: string;
  title: string;
  description: string;
  trigger_keywords: string[];
  trigger_domains: string[];
  installed: boolean;
  available_to_seed: boolean;
  source_type: string;
  _link?: string;
};

type NormalizedSkill = {
  id?: string;
  name: string;
  title: string;
  description: string;
  trigger_keywords: string[];
  trigger_domains: string[];
  _link?: string;
  installed: boolean;
  source_type: string;
};

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function normalizeSkillCatalogSearchTerms(search?: string | null): string[] {
  if (!search || !search.trim()) return [];
  return search
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function normalizeSkill(skill: SkillLike | SkillSeed, installed: boolean): NormalizedSkill {
  const skillRecord = skill as Record<string, unknown>;
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
    id: typeof skillRecord.id === 'string' ? skillRecord.id : undefined,
    name,
    title,
    description,
    trigger_keywords: asStringArray(
      'trigger_keywords' in skill ? skill.trigger_keywords : []
    ),
    trigger_domains: asStringArray(
      'trigger_domains' in skill ? skill.trigger_domains : []
    ),
    _link: typeof skillRecord._link === 'string' ? skillRecord._link : undefined,
    installed,
    source_type:
      typeof (skill as { source_type?: unknown }).source_type === 'string'
        ? String((skill as { source_type?: unknown }).source_type)
        : installed
        ? 'user_created'
        : 'seed_catalog',
  };
}

function scoreSkillSearchMatch(skill: NormalizedSkill, searchTerms: string[]): number {
  if (searchTerms.length === 0) return 0;

  let score = 0;
  for (const term of searchTerms) {
    if (
      skill.name.toLowerCase().includes(term) ||
      skill.title.toLowerCase().includes(term)
    ) {
      score += 3;
    }
    if (skill.description.toLowerCase().includes(term)) {
      score += 2;
    }
    if (
      skill.trigger_keywords.some((keyword) =>
        keyword.toLowerCase().includes(term)
      )
    ) {
      score += 2;
    }
    if (
      skill.trigger_domains.some((domain) => domain.toLowerCase().includes(term))
    ) {
      score += 1;
    }
  }

  return score;
}

export function buildSkillCatalogView(params: {
  skills: SkillLike[];
  defaultCatalog: SkillSeed[];
  search?: string | null;
}): {
  entries: SkillCatalogEntry[];
  installed_count: number;
  available_count: number;
  visible_count: number;
} {
  const searchTerms = normalizeSkillCatalogSearchTerms(params.search);
  const installed = params.skills.map((skill) => normalizeSkill(skill, true));
  const defaults = params.defaultCatalog.map((skill) =>
    normalizeSkill(skill, false)
  );
  const merged = new Map<string, NormalizedSkill>();

  for (const skill of defaults) merged.set(skill.name, skill);
  for (const skill of installed) merged.set(skill.name, skill);

  const allEntries = Array.from(merged.values());
  const filtered = allEntries
    .map((skill) => ({
      skill,
      searchScore: scoreSkillSearchMatch(skill, searchTerms),
    }))
    .filter(({ searchScore }) => searchTerms.length === 0 || searchScore > 0)
    .sort((a, b) => {
      if (searchTerms.length > 0 && b.searchScore !== a.searchScore) {
        return b.searchScore - a.searchScore;
      }
      if (a.skill.installed !== b.skill.installed) {
        return a.skill.installed ? -1 : 1;
      }
      return a.skill.title.localeCompare(b.skill.title);
    })
    .map(({ skill }) => ({
      ...(skill.id ? { id: skill.id } : {}),
      ...(skill._link ? { _link: skill._link } : {}),
      name: skill.name,
      title: skill.title,
      description: skill.description,
      trigger_keywords: skill.trigger_keywords,
      trigger_domains: skill.trigger_domains,
      installed: skill.installed,
      available_to_seed: !skill.installed,
      source_type: skill.source_type,
    }));

  return {
    entries: filtered,
    installed_count: installed.length,
    available_count: allEntries.length,
    visible_count: filtered.length,
  };
}
