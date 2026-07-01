#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RUN_DATE = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_DIR = `artifacts/outreach/mcp-owner-outreach-${RUN_DATE}`;
const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const SMITHERY_SERVERS_URL = 'https://api.smithery.ai/servers';
const SMITHERY_PAGE_URL = 'https://smithery.ai/servers';
const SMITHERY_SEED = '20260630';

const suppressedOwnerKeys = new Set([
  'domain:mcp.useorgx.com',
  'domain:useorgx.com',
  'github:useorgx',
  'smithery:useorgx',
]);

const genericHostnames = new Set([
  'github.com',
  'gitlab.com',
  'npmjs.com',
  'pypi.org',
  'apify.com',
  'smithery.ai',
  'modelcontextprotocol.io',
]);

const args = parseArgs(process.argv.slice(2));
const outDir = args.outDir || DEFAULT_OUT_DIR;
const githubLimit = Number.parseInt(args.githubLimit ?? '40', 10);

const positiveKeywords = [
  ['agent', 10],
  ['agents', 10],
  ['workflow', 9],
  ['automation', 9],
  ['orchestration', 9],
  ['task', 8],
  ['tasks', 8],
  ['project', 8],
  ['approval', 8],
  ['decision', 8],
  ['memory', 8],
  ['team', 7],
  ['collaboration', 7],
  ['slack', 7],
  ['email', 6],
  ['gmail', 6],
  ['calendar', 6],
  ['github', 7],
  ['linear', 8],
  ['jira', 7],
  ['notion', 7],
  ['asana', 7],
  ['crm', 8],
  ['salesforce', 8],
  ['hubspot', 8],
  ['support', 7],
  ['customer', 6],
  ['issue', 6],
  ['incident', 7],
  ['docs', 5],
  ['knowledge', 6],
  ['repository', 5],
  ['deployment', 7],
  ['pipeline', 7],
  ['browser', 5],
  ['code', 5],
  ['data', 4],
];

const negativeKeywords = [
  ['calculator', -12],
  ['weather', -10],
  ['crypto', -8],
  ['price', -6],
  ['image generation', -7],
  ['video generation', -7],
  ['single api', -6],
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });

  console.log('Fetching official MCP registry...');
  const officialServers = await fetchOfficialRegistry();

  console.log('Fetching Smithery registry...');
  const smitheryServers = await fetchSmitheryServers();

  const serverCandidates = buildServerCandidates(officialServers, smitheryServers);
  const allTargetOwners = buildTargetOwners(serverCandidates);
  const targetOwners = allTargetOwners.filter((owner) => !owner.suppressed);

  console.log(`Enriching up to ${githubLimit} GitHub owners...`);
  await enrichGithubOwners(targetOwners, githubLimit);

  rankTargets(targetOwners);
  rankServers(serverCandidates);

  const sortedTargets = [...targetOwners].sort((a, b) => b.score - a.score);
  const sortedServers = [...serverCandidates].sort((a, b) => b.score - a.score);

  await writeArtifacts({
    startedAt,
    finishedAt: new Date().toISOString(),
    officialServers,
    smitheryServers,
    allTargetOwners,
    targetOwners: sortedTargets,
    serverCandidates: sortedServers,
  });

  console.log(`Wrote outreach bundle: ${outDir}`);
  console.log(`Targets: ${sortedTargets.length}`);
  console.log(`Server candidates: ${sortedServers.length}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') parsed.outDir = argv[++i];
    else if (arg === '--github-limit') parsed.githubLimit = argv[++i];
  }
  return parsed;
}

async function fetchOfficialRegistry() {
  const servers = [];
  let cursor = null;
  for (;;) {
    const url = new URL(OFFICIAL_REGISTRY_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);

    const json = await fetchJson(url);
    for (const entry of json.servers ?? []) servers.push(entry);
    cursor = json.metadata?.nextCursor ?? null;
    if (!cursor) break;
  }
  return servers;
}

async function fetchSmitheryServers() {
  const servers = [];
  let totalPages = 1;
  let page = 1;
  do {
    const url = new URL(SMITHERY_SERVERS_URL);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('seed', SMITHERY_SEED);
    url.searchParams.set(
      'fields',
      [
        'id',
        'qualifiedName',
        'displayName',
        'description',
        'homepage',
        'verified',
        'useCount',
        'remote',
        'isDeployed',
        'createdAt',
        'bySmithery',
        'owner',
        'namespace',
        'slug',
      ].join(',')
    );

    const json = await fetchJson(url);
    for (const server of json.servers ?? []) servers.push(server);
    totalPages = json.pagination?.totalPages ?? page;
    page += 1;
  } while (page <= totalPages);
  return servers;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'orgx-mcp-owner-outreach/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function buildServerCandidates(officialEntries, smitheryEntries) {
  const byKey = new Map();

  for (const entry of officialEntries) {
    const server = entry.server ?? {};
    const meta = entry._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
    const key = canonicalServerKey({
      source: 'official',
      name: server.name,
      repositoryUrl: server.repository?.url,
      websiteUrl: server.websiteUrl,
    });
    const candidate = byKey.get(key) ?? createServerCandidate(key);
    candidate.sources.add('official_registry');
    candidate.officialName = server.name ?? candidate.officialName;
    candidate.title = candidate.title || server.title || server.name || '';
    candidate.description = longest(candidate.description, server.description);
    candidate.repositoryUrl = candidate.repositoryUrl || normalizeUrl(server.repository?.url);
    candidate.websiteUrl = candidate.websiteUrl || normalizeUrl(server.websiteUrl);
    candidate.vendorName = candidate.vendorName || server.vendor?.name || '';
    candidate.remote = candidate.remote || Boolean(server.remotes?.length);
    candidate.officialPublishedAt = meta.publishedAt ?? candidate.officialPublishedAt;
    candidate.officialUpdatedAt = meta.updatedAt ?? candidate.officialUpdatedAt;
    candidate.toolCount = Math.max(candidate.toolCount, Array.isArray(server.tools) ? server.tools.length : 0);
    candidate.rawNames.add(server.name);
    byKey.set(key, candidate);
  }

  for (const server of smitheryEntries) {
    const key = canonicalServerKey({
      source: 'smithery',
      name: server.qualifiedName,
      websiteUrl: server.homepage,
    });
    const candidate = byKey.get(key) ?? createServerCandidate(key);
    candidate.sources.add('smithery');
    candidate.smitheryQualifiedName = server.qualifiedName ?? candidate.smitheryQualifiedName;
    candidate.title = candidate.title || server.displayName || server.qualifiedName || '';
    candidate.description = longest(candidate.description, server.description);
    candidate.websiteUrl = candidate.websiteUrl || normalizeUrl(server.homepage);
    candidate.smitheryNamespace = server.namespace ?? candidate.smitheryNamespace;
    candidate.smitheryOwnerId = server.owner ?? candidate.smitheryOwnerId;
    candidate.verified = candidate.verified || Boolean(server.verified);
    candidate.remote = candidate.remote || Boolean(server.remote);
    candidate.isDeployed = candidate.isDeployed || Boolean(server.isDeployed);
    candidate.bySmithery = candidate.bySmithery || Boolean(server.bySmithery);
    candidate.useCount = Math.max(candidate.useCount, Number(server.useCount ?? 0));
    candidate.createdAt = server.createdAt ?? candidate.createdAt;
    candidate.rawNames.add(server.qualifiedName);
    byKey.set(key, candidate);
  }

  return [...byKey.values()].map((candidate) => {
    const repo = parseGithubRepo(candidate.repositoryUrl);
    candidate.githubOwner = repo?.owner ?? '';
    candidate.githubRepo = repo ? `${repo.owner}/${repo.repo}` : '';
    candidate.primaryName =
      candidate.title ||
      candidate.officialName ||
      candidate.smitheryQualifiedName ||
      [...candidate.rawNames][0] ||
      '';
    candidate.sources = [...candidate.sources].sort();
    candidate.rawNames = [...candidate.rawNames].sort();
    candidate.score = scoreServer(candidate);
    candidate.fitReasons = fitReasonsForServer(candidate);
    candidate.outreachAngle = outreachAngleForServer(candidate);
    return candidate;
  });
}

function createServerCandidate(key) {
  return {
    key,
    sources: new Set(),
    rawNames: new Set(),
    primaryName: '',
    title: '',
    description: '',
    officialName: '',
    smitheryQualifiedName: '',
    smitheryNamespace: '',
    smitheryOwnerId: '',
    vendorName: '',
    repositoryUrl: '',
    websiteUrl: '',
    githubOwner: '',
    githubRepo: '',
    verified: false,
    remote: false,
    isDeployed: false,
    bySmithery: false,
    useCount: 0,
    toolCount: 0,
    createdAt: '',
    officialPublishedAt: '',
    officialUpdatedAt: '',
    score: 0,
    fitReasons: [],
    outreachAngle: '',
  };
}

function canonicalServerKey({ source, name, repositoryUrl, websiteUrl }) {
  const repo = parseGithubRepo(repositoryUrl);
  if (repo) return `github:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
  const normalizedName = String(name ?? '').trim().toLowerCase();
  if (normalizedName) return `${source}:${normalizedName}`;
  const domain = hostname(websiteUrl);
  if (domain) return `domain:${domain}`;
  return `${source}:unknown:${Math.random().toString(16).slice(2)}`;
}

function buildTargetOwners(serverCandidates) {
  const byOwner = new Map();
  for (const server of serverCandidates) {
    const ownerKey = ownerKeyForServer(server);
    const owner = byOwner.get(ownerKey) ?? createTargetOwner(ownerKey, server);
    owner.servers.push(server);
    owner.sources = new Set([...owner.sources, ...server.sources]);
    owner.maxUseCount = Math.max(owner.maxUseCount, server.useCount);
    owner.totalUseCount += server.useCount;
    owner.repositoryUrls.add(server.repositoryUrl);
    owner.websites.add(server.websiteUrl);
    owner.githubRepos.add(server.githubRepo);
    if (!owner.githubOwner && server.githubOwner) owner.githubOwner = server.githubOwner;
    if (!owner.ownerDisplay && server.vendorName) owner.ownerDisplay = server.vendorName;
    if (!owner.ownerDisplay && server.smitheryNamespace) owner.ownerDisplay = server.smitheryNamespace;
    byOwner.set(ownerKey, owner);
  }

  return [...byOwner.values()].map((owner) => {
    owner.sources = [...owner.sources].sort();
    owner.repositoryUrls = [...owner.repositoryUrls].filter(Boolean).sort();
    owner.websites = [...owner.websites].filter(Boolean).sort();
    owner.githubRepos = [...owner.githubRepos].filter(Boolean).sort();
    owner.serverCount = owner.servers.length;
    owner.topServerNames = [...owner.servers]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((server) => server.primaryName);
    owner.bestServer = owner.topServerNames[0] ?? '';
    owner.ownerDisplay = owner.ownerDisplay || owner.githubOwner || owner.ownerKey.replace(/^[^:]+:/, '');
    owner.contactPath = contactPathForOwner(owner);
    owner.pageSlug = slugify(owner.ownerDisplay || owner.ownerKey);
    owner.suppressed = suppressedOwnerKeys.has(owner.ownerKey);
    return owner;
  });
}

function createTargetOwner(ownerKey, server) {
  return {
    ownerKey,
    ownerDisplay: server.vendorName || server.githubOwner || server.smitheryNamespace || '',
    ownerType: ownerKey.split(':')[0],
    githubOwner: server.githubOwner || '',
    githubOwnerType: '',
    githubOwnerName: '',
    githubOwnerBlog: '',
    githubOwnerCompany: '',
    contactPath: '',
    pageSlug: '',
    sources: new Set(),
    repositoryUrls: new Set(),
    websites: new Set(),
    githubRepos: new Set(),
    servers: [],
    topServerNames: [],
    bestServer: '',
    serverCount: 0,
    maxUseCount: 0,
    totalUseCount: 0,
    score: 0,
    fitReasons: [],
    pitchThesis: '',
    firstAsk: '',
  };
}

function ownerKeyForServer(server) {
  if (server.githubOwner) return `github:${server.githubOwner.toLowerCase()}`;
  if (server.smitheryNamespace) return `smithery:${server.smitheryNamespace.toLowerCase()}`;
  const vendorDomain = hostname(server.websiteUrl);
  if (vendorDomain && !genericHostnames.has(vendorDomain)) return `domain:${vendorDomain}`;
  const officialNamespace = String(server.officialName || '').split('/')[0];
  if (officialNamespace) return `registry:${officialNamespace.toLowerCase()}`;
  return `unknown:${server.key}`;
}

async function enrichGithubOwners(targetOwners, limit) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'orgx-mcp-owner-outreach/1.0',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const owners = targetOwners
    .filter((owner) => owner.githubOwner)
    .sort((a, b) => b.maxUseCount - a.maxUseCount)
    .slice(0, Math.max(0, limit));

  for (const owner of owners) {
    try {
      const json = await fetchJsonWithHeaders(`https://api.github.com/users/${encodeURIComponent(owner.githubOwner)}`, headers);
      owner.githubOwnerType = json.type ?? '';
      owner.githubOwnerName = json.name ?? '';
      owner.githubOwnerBlog = normalizeUrl(json.blog);
      owner.githubOwnerCompany = json.company ?? '';
      owner.ownerDisplay = owner.githubOwnerName || owner.ownerDisplay || owner.githubOwner;
      if (owner.githubOwnerBlog) owner.websites = [...new Set([...owner.websites, owner.githubOwnerBlog])].sort();
    } catch (error) {
      owner.githubOwnerType = 'unresolved';
    }
  }
}

async function fetchJsonWithHeaders(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function rankTargets(targetOwners) {
  for (const owner of targetOwners) {
    const topServers = [...owner.servers].sort((a, b) => b.score - a.score);
    const sourceCoverage = new Set(owner.sources);
    const bestServerScore = topServers[0]?.score ?? 0;
    let score = bestServerScore;
    score += Math.min(18, Math.log10(owner.totalUseCount + 1) * 5);
    score += Math.min(12, owner.serverCount * 2);
    if (sourceCoverage.has('official_registry') && sourceCoverage.has('smithery')) score += 15;
    if (owner.githubOwner) score += 8;
    if (owner.websites.length) score += 5;
    if (owner.githubOwnerType === 'Organization') score += 4;
    if (topServers.some((server) => server.bySmithery)) score -= 16;

    owner.score = Math.round(score);
    owner.fitReasons = fitReasonsForOwner(owner, topServers);
    owner.pitchThesis = pitchThesisForOwner(owner, topServers);
    owner.firstAsk = firstAskForOwner(owner, topServers);
  }
}

function rankServers(serverCandidates) {
  for (const server of serverCandidates) {
    server.score = Math.round(server.score);
  }
}

function scoreServer(server) {
  let score = 0;
  if (server.sources.includes('official_registry')) score += 14;
  if (server.sources.includes('smithery')) score += 10;
  if (server.sources.includes('official_registry') && server.sources.includes('smithery')) score += 18;
  if (server.verified) score += 20;
  if (server.remote) score += 6;
  if (server.isDeployed) score += 5;
  if (server.repositoryUrl) score += 8;
  if (server.websiteUrl) score += 4;
  if (server.useCount) score += Math.min(34, Math.log10(server.useCount + 1) * 9);
  if (server.useCount >= 10000) score += 20;
  else if (server.useCount >= 5000) score += 16;
  else if (server.useCount >= 1000) score += 12;
  else if (server.useCount >= 100) score += 6;
  if (server.toolCount) score += Math.min(8, server.toolCount);
  if (server.bySmithery) score -= 15;

  const text = searchableText(server);
  let keywordScore = 0;
  for (const [keyword, points] of positiveKeywords) {
    if (text.includes(keyword)) keywordScore += points;
  }
  score += Math.min(34, keywordScore);
  for (const [keyword, points] of negativeKeywords) {
    if (text.includes(keyword)) score += points;
  }
  if (!server.verified && server.useCount < 100 && server.sources.length === 1 && server.sources[0] === 'smithery') score -= 18;
  return score;
}

function fitReasonsForServer(server) {
  const reasons = [];
  if (server.sources.includes('official_registry') && server.sources.includes('smithery')) reasons.push('listed in both official registry and Smithery');
  else if (server.sources.includes('smithery')) reasons.push('active Smithery listing');
  else if (server.sources.includes('official_registry')) reasons.push('official MCP registry listing');
  if (server.verified) reasons.push('verified on Smithery');
  if (server.useCount) reasons.push(`${server.useCount.toLocaleString()} Smithery connections`);
  if (server.repositoryUrl) reasons.push('public GitHub repository owner path');
  const text = searchableText(server);
  if (/(workflow|automation|task|project|approval|decision|agent|orchestration)/.test(text)) reasons.push('workflow/agent coordination surface');
  if (/(slack|email|gmail|calendar|github|linear|jira|notion|asana|crm|salesforce|hubspot)/.test(text)) reasons.push('system-of-work or business app context');
  return reasons.slice(0, 5);
}

function fitReasonsForOwner(owner, topServers) {
  const reasons = [];
  if (owner.sources.includes('official_registry') && owner.sources.includes('smithery')) reasons.push('present across both major MCP directories');
  if (owner.serverCount > 1) reasons.push(`${owner.serverCount} MCP listings under this owner target`);
  if (owner.maxUseCount) reasons.push(`top Smithery listing has ${owner.maxUseCount.toLocaleString()} connections`);
  if (owner.githubOwner) reasons.push(`public GitHub owner: ${owner.githubOwner}`);
  for (const reason of topServers.flatMap((server) => server.fitReasons)) {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (reasons.length >= 5) break;
  }
  return reasons.slice(0, 5);
}

function outreachAngleForServer(server) {
  const text = searchableText(server);
  if (/(slack|email|gmail|calendar|outlook|notion|linear|jira|asana|github)/.test(text)) {
    return 'turn observed work-system context into OrgX tasks, decisions, owners, and receipts';
  }
  if (/(agent|workflow|automation|orchestration|pipeline|deployment)/.test(text)) {
    return 'give their agent/workflow MCP a durable execution and proof layer';
  }
  if (/(memory|knowledge|docs|search|browser|data)/.test(text)) {
    return 'convert retrieved context into accountable follow-through instead of another answer';
  }
  return 'show an integration walkthrough where OrgX supplies memory, approvals, and proof after their MCP finds or triggers work';
}

function pitchThesisForOwner(owner, topServers) {
  const best = topServers[0];
  const target = owner.ownerDisplay;
  const serverName = best?.primaryName ?? owner.bestServer;
  const angle = best?.outreachAngle ?? 'connect their MCP context to OrgX execution and proof';
  return `${target}'s ${serverName} MCP can ${angle}. Lead with a private integration walkthrough, not a generic platform pitch.`;
}

function firstAskForOwner(owner, topServers) {
  const best = topServers[0];
  if (!best) return 'Ask for one concrete workflow or server use case to map into an OrgX proof room.';
  return `Ask for one real ${best.primaryName} workflow where context is found but follow-through is still manual; offer a one-page OrgX integration walkthrough plus a 20-minute call.`;
}

function contactPathForOwner(owner) {
  if (owner.githubOwner) return `https://github.com/${owner.githubOwner}`;
  if (owner.websites[0]) return owner.websites[0];
  const smitheryServer = owner.servers.find((server) => server.smitheryQualifiedName);
  if (smitheryServer) return `${SMITHERY_PAGE_URL}/${smitheryServer.smitheryQualifiedName}`;
  return '';
}

async function writeArtifacts({
  startedAt,
  finishedAt,
  officialServers,
  smitheryServers,
  allTargetOwners,
  targetOwners,
  serverCandidates,
}) {
  const manifest = {
    generatedAt: finishedAt,
    startedAt,
    sources: {
      officialRegistry: {
        url: `${OFFICIAL_REGISTRY_URL}?limit=100&version=latest`,
        count: officialServers.length,
      },
      smithery: {
        url: `${SMITHERY_SERVERS_URL}?pageSize=100&page=1&seed=${SMITHERY_SEED}`,
        count: smitheryServers.length,
      },
      githubOwnerEnrichment: {
        attemptedLimit: githubLimit,
        usedToken: Boolean(process.env.GITHUB_TOKEN),
      },
    },
    targetCounts: {
      totalBeforeSuppression: allTargetOwners.length,
      rankedAfterSuppression: targetOwners.length,
      suppressed: allTargetOwners.length - targetOwners.length,
    },
    outputs: {
      prospectsCsv: 'mcp-owner-prospects.csv',
      prospectsJson: 'mcp-owner-prospects.json',
      serverCandidatesCsv: 'mcp-server-candidates.csv',
      pitchTemplates: 'pitch-templates.md',
      hostedPageTemplate: 'hosted-page-template.html',
    },
    caveats: [
      'OrgX/useorgx self-listings are suppressed from the ranked outreach target list.',
      'Smithery public server summaries expose namespace, homepage, opaque owner id, and use count; they do not expose a named human owner.',
      'Official MCP registry rows often expose repository/vendor/website data, but not a guaranteed contact email.',
      'Generic marketplace domains such as github.com, apify.com, and smithery.ai are not treated as owner domains.',
      'No outreach was sent; contact paths are review inputs, not approval to message.',
    ],
  };

  await writeFile(path.join(outDir, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outDir, 'mcp-owner-prospects.json'), `${JSON.stringify(targetOwners.map(serializeOwner), null, 2)}\n`);
  await writeFile(path.join(outDir, 'mcp-owner-prospects.csv'), toCsv(targetOwners.map(ownerCsvRow)));
  await writeFile(path.join(outDir, 'mcp-server-candidates.csv'), toCsv(serverCandidates.map(serverCsvRow)));
  await writeFile(path.join(outDir, 'pitch-templates.md'), pitchTemplates(targetOwners.slice(0, 12)));
  await writeFile(path.join(outDir, 'hosted-page-template.html'), hostedPageTemplate(targetOwners[0]));
  await writeFile(path.join(outDir, 'README.md'), readme(manifest, targetOwners.slice(0, 15)));
}

function serializeOwner(owner) {
  return {
    score: owner.score,
    ownerKey: owner.ownerKey,
    ownerDisplay: owner.ownerDisplay,
    ownerType: owner.ownerType,
    contactPath: owner.contactPath,
    pageSlug: owner.pageSlug,
    sources: owner.sources,
    githubOwner: owner.githubOwner,
    githubOwnerType: owner.githubOwnerType,
    githubOwnerName: owner.githubOwnerName,
    githubOwnerBlog: owner.githubOwnerBlog,
    githubOwnerCompany: owner.githubOwnerCompany,
    websites: owner.websites,
    repositoryUrls: owner.repositoryUrls,
    githubRepos: owner.githubRepos,
    serverCount: owner.serverCount,
    totalUseCount: owner.totalUseCount,
    maxUseCount: owner.maxUseCount,
    topServerNames: owner.topServerNames,
    fitReasons: owner.fitReasons,
    pitchThesis: owner.pitchThesis,
    firstAsk: owner.firstAsk,
  };
}

function ownerCsvRow(owner, index) {
  return {
    rank: index + 1,
    score: owner.score,
    owner: owner.ownerDisplay,
    owner_key: owner.ownerKey,
    contact_path: owner.contactPath,
    sources: owner.sources.join('; '),
    github_owner: owner.githubOwner,
    github_owner_type: owner.githubOwnerType,
    top_server: owner.bestServer,
    server_count: owner.serverCount,
    max_smithery_connections: owner.maxUseCount,
    top_servers: owner.topServerNames.join('; '),
    fit_reasons: owner.fitReasons.join('; '),
    pitch_thesis: owner.pitchThesis,
    first_ask: owner.firstAsk,
    hosted_page_slug: owner.pageSlug,
  };
}

function serverCsvRow(server, index) {
  return {
    rank: index + 1,
    score: server.score,
    name: server.primaryName,
    official_name: server.officialName,
    smithery_name: server.smitheryQualifiedName,
    sources: server.sources.join('; '),
    verified: server.verified,
    remote: server.remote,
    deployed: server.isDeployed,
    smithery_connections: server.useCount,
    repository_url: server.repositoryUrl,
    website_url: server.websiteUrl,
    github_owner: server.githubOwner,
    fit_reasons: server.fitReasons.join('; '),
    outreach_angle: server.outreachAngle,
    description: server.description,
  };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function pitchTemplates(topOwners) {
  const examples = topOwners
    .slice(0, 5)
    .map((owner) => `- ${owner.ownerDisplay}: ${owner.pitchThesis}`)
    .join('\n');

  return `# MCP Owner Outreach Templates

Generated: ${new Date().toISOString()}

## Use This Motion

Send only after a human reviews the row, confirms the owner/contact path, and creates a prospect-specific walkthrough page.

## Short Email / DM

Subject: ${'{{MCP_SERVER}}'} + OrgX proof loop?

Hey ${'{{FIRST_NAME_OR_TEAM}}'} — I was looking at ${'{{MCP_SERVER}}'} and think there is a concrete integration angle with OrgX.

${'{{MCP_SERVER}}'} already brings ${'{{CONTEXT_IT_EXPOSES}}'} into the agent runtime. OrgX can take the next step: turn that context into an initiative/task/decision, route the human approval if needed, and send a receipt back when work actually happens.

I mocked the flow here so it is easy to react to: ${'{{PRIVATE_WALKTHROUGH_URL}}'}

Worth 20 minutes to see if one real ${'{{MCP_SERVER}}'} workflow should become an OrgX proof loop?

## Follow-Up

Quick bump. The useful version is not a broad partnership call; it is picking one real workflow where ${'{{MCP_SERVER}}'} finds the signal and OrgX closes the loop with owner, approval, artifact, and receipt.

If that is interesting, I can adapt the walkthrough to one of your actual examples before we talk.

## What The Walkthrough Should Show

1. ${'{{MCP_SERVER}}'} emits or retrieves a real context object.
2. OrgX creates a task, decision, or initiative from that context.
3. A human approval or specialist agent handles the next step.
4. OrgX returns a receipt/proof object ${'{{MCP_SERVER}}'} can display or store.
5. CTA is one specific pilot workflow and a booking link.

## Top Example Theses

${examples}
`;
}

function hostedPageTemplate(owner) {
  const safeOwner = escapeHtml(owner?.ownerDisplay || 'MCP Owner');
  const safeServer = escapeHtml(owner?.bestServer || '{{MCP_SERVER}}');
  const safeThesis = escapeHtml(owner?.pitchThesis || '{{PITCH_THESIS}}');
  const safeAsk = escapeHtml(owner?.firstAsk || '{{FIRST_ASK}}');
  const safeSlug = escapeHtml(owner?.pageSlug || 'mcp-owner');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OrgX x ${safeOwner} - MCP proof loop</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #05070a;
    --panel: #0b1016;
    --panel-2: #101820;
    --ink: #f4f7fb;
    --muted: rgba(244,247,251,.64);
    --faint: rgba(244,247,251,.42);
    --line: rgba(244,247,251,.12);
    --lime: #d4ed31;
    --teal: #19c6ad;
    --blue: #28a8ff;
    --max: 1080px;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    background-image:
      linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  main { min-height: 100vh; }
  .wrap { width: min(var(--max), calc(100% - 36px)); margin: 0 auto; }
  .nav { height: 68px; display: flex; align-items: center; justify-content: space-between; color: var(--faint); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
  .mark { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, var(--lime), var(--teal), var(--blue)); display: inline-block; margin-right: 10px; vertical-align: -4px; }
  .hero { padding: 62px 0 54px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .eyebrow { color: var(--lime); font-size: 12px; letter-spacing: .16em; text-transform: uppercase; font-weight: 700; margin-bottom: 18px; }
  h1 { max-width: 920px; font-size: clamp(42px, 7vw, 86px); line-height: .95; letter-spacing: -.05em; margin: 0; font-weight: 680; }
  .lede { max-width: 720px; margin-top: 24px; color: var(--muted); font-size: clamp(18px, 2.2vw, 24px); line-height: 1.45; }
  .cta-row { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
  a.button { color: #061014; background: var(--lime); text-decoration: none; padding: 13px 18px; border-radius: 8px; font-weight: 700; }
  a.secondary { color: var(--ink); border: 1px solid var(--line); background: rgba(255,255,255,.04); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 32px 0; }
  .card { background: linear-gradient(180deg, var(--panel-2), var(--panel)); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
  .card h2 { margin: 0 0 12px; font-size: 22px; letter-spacing: -.02em; }
  .card p, .card li { color: var(--muted); line-height: 1.55; }
  .steps { list-style: none; padding: 0; margin: 0; counter-reset: step; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 32px 1fr; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
  .steps li:first-child { border-top: 0; }
  .steps li::before { content: counter(step); color: var(--lime); font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding-top: 4px; }
  .proof { grid-column: 1 / -1; }
  .proof code { color: var(--lime); }
  footer { color: var(--faint); padding: 36px 0 48px; font-size: 13px; }
  @media (max-width: 760px) {
    .grid { grid-template-columns: 1fr; }
    .nav { height: auto; padding: 20px 0; gap: 16px; align-items: flex-start; flex-direction: column; }
  }
</style>
</head>
<body>
<main>
  <div class="wrap">
    <nav class="nav">
      <div><span class="mark"></span>OrgX x ${safeOwner}</div>
      <div>private MCP proof-loop walkthrough / ${safeSlug}</div>
    </nav>
  </div>
  <section class="hero">
    <div class="wrap">
      <div class="eyebrow">One real workflow, not a generic integration</div>
      <h1>${safeServer} finds the signal. OrgX makes the work happen and proves it.</h1>
      <p class="lede">${safeThesis}</p>
      <div class="cta-row">
        <a class="button" href="{{BOOKING_URL}}">Book 20 minutes</a>
        <a class="button secondary" href="https://mcp.useorgx.com/.well-known/mcp.json">Inspect OrgX MCP</a>
      </div>
    </div>
  </section>
  <div class="wrap grid">
    <section class="card">
      <h2>The integration bet</h2>
      <p>${safeServer} already gets useful context into an agent. OrgX is the durable layer after that: owner, task, approval, specialist agent, artifact, receipt.</p>
    </section>
    <section class="card">
      <h2>The pilot ask</h2>
      <p>${safeAsk}</p>
    </section>
    <section class="card proof">
      <h2>Proof loop</h2>
      <ol class="steps">
        <li>${safeServer} emits or retrieves a real context object.</li>
        <li>OrgX writes an initiative, task, or decision with owner and source link.</li>
        <li>Human approval or a specialist agent handles the next step.</li>
        <li><code>orgx_submit_receipt</code> returns outcome, artifact, attribution, and proof.</li>
      </ol>
    </section>
  </div>
</main>
<footer class="wrap">No outreach should send until the owner/contact path and booking URL are reviewed.</footer>
</body>
</html>
`;
}

function readme(manifest, topOwners) {
  const rows = topOwners
    .map(
      (owner, index) =>
        `| ${index + 1} | ${owner.score} | ${owner.ownerDisplay} | ${owner.bestServer} | ${owner.fitReasons.join('; ')} |`
    )
    .join('\n');

  return `# MCP Owner Outreach Bundle

Generated: ${manifest.generatedAt}

## What This Is

First-pass ranked owner targets from the official MCP registry and Smithery. This is built for artifact-led outreach: make a private integration walkthrough page for each reviewed target, then invite the owner to a specific pilot call.

No outreach was sent.

## Source Counts

- Official MCP registry latest listings: ${manifest.sources.officialRegistry.count}
- Smithery public server summaries: ${manifest.sources.smithery.count}
- GitHub owner enrichment attempted for top ${manifest.sources.githubOwnerEnrichment.attemptedLimit} GitHub owners

## Top Targets

| Rank | Score | Owner | Best Server | Why It Fits |
| --- | ---: | --- | --- | --- |
${rows}

## Files

- \`mcp-owner-prospects.csv\` - ranked owner/contact-path table
- \`mcp-owner-prospects.json\` - same data with nested owner metadata
- \`mcp-server-candidates.csv\` - server-level scoring table
- \`pitch-templates.md\` - first-touch and follow-up copy
- \`hosted-page-template.html\` - prospect-facing page template
- \`run-manifest.json\` - source counts, caveats, generation metadata

## Caveats

${manifest.caveats.map((item) => `- ${item}`).join('\n')}
`;
}

function searchableText(server) {
  return [server.primaryName, server.title, server.description, server.officialName, server.smitheryQualifiedName]
    .join(' ')
    .toLowerCase();
}

function parseGithubRepo(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const match = normalized.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/#?\s]+)(?:[/?#].*)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

function normalizeUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value.startsWith('http') ? value : `https://${value}`);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function hostname(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return '';
  try {
    return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function longest(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return right.length > left.length ? right : left;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
