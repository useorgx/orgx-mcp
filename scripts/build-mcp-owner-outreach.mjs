#!/usr/bin/env node
/**
 * Build a source-backed, owner-level prospect universe from the official MCP
 * Registry. It intentionally excludes contact enrichment and any send action.
 *
 * Usage:
 *   pnpm outreach:rank-mcp-owners -- --limit 125 --out artifacts/outreach/mcp-owner-first-125.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const DEFAULT_LIMIT = 125;
const PAGE_SIZE = 100;
const DEFAULT_PAGES_PER_TERM = 2;
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

const SEARCH_TERMS = [
  { term: 'workflow', category: 'workflow', weight: 16 },
  { term: 'project', category: 'project_management', weight: 16 },
  { term: 'task', category: 'project_management', weight: 15 },
  { term: 'issue', category: 'engineering_workflow', weight: 14 },
  { term: 'automation', category: 'workflow', weight: 14 },
  { term: 'orchestration', category: 'agent_workflow', weight: 16 },
  { term: 'agent', category: 'agent_workflow', weight: 12 },
  { term: 'crm', category: 'customer_workflow', weight: 16 },
  { term: 'sales', category: 'customer_workflow', weight: 15 },
  { term: 'support', category: 'customer_workflow', weight: 14 },
  { term: 'notion', category: 'knowledge_workflow', weight: 15 },
  { term: 'linear', category: 'project_management', weight: 15 },
  { term: 'jira', category: 'project_management', weight: 15 },
  { term: 'trello', category: 'project_management', weight: 14 },
  { term: 'asana', category: 'project_management', weight: 14 },
  { term: 'clickup', category: 'project_management', weight: 14 },
  { term: 'monday', category: 'project_management', weight: 13 },
  { term: 'slack', category: 'team_workflow', weight: 13 },
  { term: 'hubspot', category: 'customer_workflow', weight: 16 },
  { term: 'zendesk', category: 'customer_workflow', weight: 15 },
  { term: 'intercom', category: 'customer_workflow', weight: 14 },
  { term: 'confluence', category: 'knowledge_workflow', weight: 15 },
  { term: 'airtable', category: 'knowledge_workflow', weight: 14 },
  { term: 'documentation', category: 'knowledge_workflow', weight: 13 },
  { term: 'github', category: 'engineering_workflow', weight: 13 },
  { term: 'gitlab', category: 'engineering_workflow', weight: 13 },
  { term: 'devops', category: 'engineering_workflow', weight: 12 },
  { term: 'calendar', category: 'team_workflow', weight: 11 },
  { term: 'email', category: 'customer_workflow', weight: 11 },
  { term: 'browser', category: 'agent_workflow', weight: 10 },
];

const EXCLUDED_OWNERS = new Set(['modelcontextprotocol', 'smithery-ai', 'useorgx']);
const CONTINUITY_TERMS = [
  'workflow',
  'project',
  'task',
  'issue',
  'ticket',
  'approval',
  'decision',
  'team',
  'collaborat',
  'knowledge',
  'customer',
  'crm',
  'support',
  'sales',
  'agent',
  'orchestrat',
  'automation',
  'handoff',
];

const RELEVANCE_PATTERN =
  /\b(handoff|workflow|project management|task management|tickets?|support|crm|customers?|sales|approvals?|decisions?|memor(?:y|ies)|knowledge|collaborat|orchestrat|linear|notion|slack|calendar|planning|control plane|teams?|issues?|pull requests?|code review|jira|trello|asana|clickup|monday|hubspot|zendesk|intercom|confluence|airtable|documentation|gitlab|devops)\b/i;

const EXCLUSION_PATTERN =
  /\b(world bank|home automation|user agents?|stock prices?|crypto|solana|micropayment|photos?|lego|image generation|weather|flights?|music|video|game)\b/i;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function parseGitHubRepository(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (!match) return null;

  return {
    owner: match[1],
    repository: match[2].replace(/\.git$/i, ''),
    url: `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, '')}`,
  };
}

function ageScore(updatedAt, now) {
  if (!updatedAt) return 0;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 0;
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays <= 90) return 8;
  if (ageDays <= 180) return 4;
  return 0;
}

function isRelevantServer(server) {
  const text = `${server.name ?? ''} ${server.description ?? ''}`;
  return RELEVANCE_PATTERN.test(text) && !EXCLUSION_PATTERN.test(text);
}

function describeCandidate(server, github, officialMeta, term, now) {
  const description = String(server.description ?? '').replace(/\s+/g, ' ').trim();
  const lowerDescription = description.toLowerCase();
  const matchedContinuityTerms = CONTINUITY_TERMS.filter((needle) => lowerDescription.includes(needle));
  const hasRemote = Array.isArray(server.remotes) && server.remotes.length > 0;
  const updatedAt = officialMeta?.updatedAt ?? null;
  const baseScore =
    10 +
    (hasRemote ? 4 : 0) +
    (server.websiteUrl ? 2 : 0) +
    Math.min(matchedContinuityTerms.length * 3, 24) +
    ageScore(updatedAt, now);

  return {
    githubOwner: github.owner,
    githubRepository: github.repository,
    sourceRepository: github.url,
    registryServerName: String(server.name ?? ''),
    description,
    websiteUrl: typeof server.websiteUrl === 'string' ? server.websiteUrl : null,
    remotes: hasRemote ? server.remotes.map((remote) => remote.type).filter(Boolean) : [],
    publishedAt: officialMeta?.publishedAt ?? null,
    updatedAt,
    baseScore,
    continuitySignals: matchedContinuityTerms,
    categories: new Set([term.category]),
    searchTerms: new Map([[term.term, term.weight]]),
  };
}

function mergeCandidate(existing, candidate) {
  for (const category of candidate.categories) existing.categories.add(category);
  for (const [term, weight] of candidate.searchTerms) existing.searchTerms.set(term, weight);
  for (const signal of candidate.continuitySignals) {
    if (!existing.continuitySignals.includes(signal)) existing.continuitySignals.push(signal);
  }

  if (candidate.baseScore > existing.baseScore) {
    const categories = existing.categories;
    const searchTerms = existing.searchTerms;
    const continuitySignals = existing.continuitySignals;
    Object.assign(existing, candidate, { categories, searchTerms, continuitySignals });
  }
}

function finalizeCandidate(candidate) {
  const termScore = Math.min(
    [...candidate.searchTerms.values()].reduce((total, weight) => total + weight, 0),
    28
  );
  const categoryBreadth = Math.min(candidate.categories.size, 4);
  const score = candidate.baseScore + termScore + categoryBreadth;
  const reasons = [
    `GitHub owner ${candidate.githubOwner} has an MCP server in ${[...candidate.categories].join(', ')}.`,
    `Registry discovery matched: ${[...candidate.searchTerms.keys()].join(', ')}.`,
  ];
  if (candidate.continuitySignals.length) {
    reasons.push(`Description signals: ${candidate.continuitySignals.slice(0, 6).join(', ')}.`);
  }
  if (candidate.updatedAt) reasons.push(`Registry version updated ${candidate.updatedAt}.`);

  return {
    score,
    githubOwner: candidate.githubOwner,
    githubRepository: candidate.githubRepository,
    sourceRepository: candidate.sourceRepository,
    registryServerName: candidate.registryServerName,
    description: candidate.description,
    websiteUrl: candidate.websiteUrl,
    remoteTransports: candidate.remotes,
    categories: [...candidate.categories].sort(),
    searchTerms: [...candidate.searchTerms.keys()].sort(),
    publishedAt: candidate.publishedAt,
    updatedAt: candidate.updatedAt,
    scoreReasons: reasons,
    researchStatus: 'needs_named_contact_and_business_email_verification',
    sendStatus: 'held',
  };
}

async function fetchRegistryPage(term, cursor) {
  const search = new URLSearchParams({
    limit: String(PAGE_SIZE),
    search: term,
    version: 'latest',
  });
  if (cursor) search.set('cursor', cursor);
  const response = await fetch(`${REGISTRY_URL}?${search.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Registry search for ${term} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  const targetCount = boundedInt(readArg('--limit', DEFAULT_LIMIT), DEFAULT_LIMIT, 1, 500);
  const pagesPerTerm = boundedInt(
    readArg('--pages-per-term', DEFAULT_PAGES_PER_TERM),
    DEFAULT_PAGES_PER_TERM,
    1,
    10
  );
  const generatedAt = new Date();
  const defaultOut = `artifacts/outreach/mcp-owner-first-${targetCount}-${generatedAt.toISOString().slice(0, 10)}.json`;
  const outputPath = resolve(process.cwd(), readArg('--out', defaultOut));
  const candidatesByOwner = new Map();
  const failures = [];

  for (const term of SEARCH_TERMS) {
    let cursor = null;
    for (let page = 0; page < pagesPerTerm; page += 1) {
      let payload;
      try {
        payload = await fetchRegistryPage(term.term, cursor);
      } catch (error) {
        failures.push({ term: term.term, error: error instanceof Error ? error.message : String(error) });
        break;
      }

      for (const entry of payload.servers ?? []) {
        const server = entry?.server ?? {};
        const github = parseGitHubRepository(server?.repository?.url);
        if (!github || EXCLUDED_OWNERS.has(github.owner.toLowerCase())) continue;
        if (/useorgx/i.test(server.name ?? '') || /useorgx/i.test(github.url)) continue;
        if (!isRelevantServer(server)) continue;

        const officialMeta = entry?._meta?.[OFFICIAL_META_KEY] ?? {};
        const candidate = describeCandidate(server, github, officialMeta, term, generatedAt);
        const ownerKey = github.owner.toLowerCase();
        const existing = candidatesByOwner.get(ownerKey);
        if (existing) mergeCandidate(existing, candidate);
        else candidatesByOwner.set(ownerKey, candidate);
      }

      cursor = payload?.metadata?.nextCursor ?? null;
      if (!cursor) break;
    }
  }

  const targets = [...candidatesByOwner.values()]
    .map(finalizeCandidate)
    .sort((left, right) => right.score - left.score || left.githubOwner.localeCompare(right.githubOwner))
    .slice(0, targetCount)
    .map((candidate, index) => ({ rank: index + 1, ...candidate }));

  const artifact = {
    generatedAt: generatedAt.toISOString(),
    source: {
      registry: REGISTRY_URL,
      api: 'GET /v0.1/servers?search={term}&version=latest',
      terms: SEARCH_TERMS.map(({ term }) => term),
      pagesPerTerm,
      ownerDeduplication: 'one highest-scoring server per GitHub owner',
    },
    selection: {
      targetCount,
      candidateOwnersFound: candidatesByOwner.size,
      contactDataIncluded: false,
      sendActionIncluded: false,
      rule: 'Research only. A lead stays held until a named owner, business contact path, relevance note, suppression check, and human send approval are recorded.',
    },
    failures,
    targets,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${targets.length} owner-level targets to ${outputPath}`);
  if (failures.length) console.warn(`Registry search failures: ${failures.map((failure) => failure.term).join(', ')}`);
}

await main();
