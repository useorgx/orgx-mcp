// Forward-provisioned: no runtime path imports this module yet (only
// tests/scaffoldShareCard.spec.ts exercises it). It builds the share-ready
// Initiative Velocity Card artifact for the scaffold flow to attach once the
// scaffold_initiative pipeline posts share artifacts; wiring it into
// scaffoldResponse/scaffoldFollowups today would be speculative product work.
import { PROOF_SURFACE_QUIET_CTA } from './widgetArtifactProof';

export const INITIATIVE_VELOCITY_CARD_WIDGET_ASSETS = [
  '/blog/widgets/scaffolded-initiative-widget.png',
  '/blog/widgets/query-org-memory-widget.png',
  '/blog/widgets/pending-decision-card.png',
] as const;

export type InitiativeVelocityCardStats = {
  workstreams: number;
  milestones: number;
  tasks: number;
  domains: string[];
  expected_tokens: number;
  expected_duration_hours: number;
  expected_budget_usd: number;
};

export type InitiativeVelocityCardArtifact = {
  entity_type: 'initiative';
  entity_id: string;
  initiative_id: string;
  name: string;
  artifact_type: 'shared.project_handbook';
  description: string;
  artifact_url: string;
  external_url: string;
  preview_markdown: string;
  status: 'approved';
  metadata: {
    kind: 'initiative_velocity_card';
    source: 'scaffold_initiative';
    initiative_id: string;
    live_url: string;
    og_image_url: string;
    stats: InitiativeVelocityCardStats;
    widget_assets: typeof INITIATIVE_VELOCITY_CARD_WIDGET_ASSETS;
    quiet_cta: typeof PROOF_SURFACE_QUIET_CTA;
    card_version: '2026-04-13';
  };
  created_by_type: 'agent';
};

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeTitle(value: Record<string, unknown>, fallback: string): string {
  const title =
    typeof value.title === 'string'
      ? value.title
      : typeof value.name === 'string'
        ? value.name
        : fallback;
  return title.trim().slice(0, 160) || fallback;
}

function finiteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function addEstimate(stats: InitiativeVelocityCardStats, node: unknown) {
  const record = safeRecord(node);
  stats.expected_tokens += finiteNumber(record.expected_tokens);
  stats.expected_duration_hours += finiteNumber(record.expected_duration_hours);
  stats.expected_budget_usd += finiteNumber(record.expected_budget_usd);
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase();
  return domain ? domain : null;
}

export function buildInitiativeVelocityCardStats(
  hierarchy: unknown
): InitiativeVelocityCardStats {
  const root = safeRecord(hierarchy);
  const workstreams = Array.isArray(root.workstreams) ? root.workstreams : [];
  const stats: InitiativeVelocityCardStats = {
    workstreams: workstreams.length,
    milestones: 0,
    tasks: 0,
    domains: [],
    expected_tokens: 0,
    expected_duration_hours: 0,
    expected_budget_usd: 0,
  };
  const domains = new Set<string>();

  addEstimate(stats, root.initiative);
  for (const workstream of workstreams) {
    const ws = safeRecord(workstream);
    addEstimate(stats, ws);
    const domain = normalizeDomain(ws.domain ?? ws.agent_domain ?? ws.persona);
    if (domain) domains.add(domain);

    const milestones = Array.isArray(ws.milestones) ? ws.milestones : [];
    stats.milestones += milestones.length;
    for (const milestone of milestones) {
      const ms = safeRecord(milestone);
      addEstimate(stats, ms);
      const tasks = Array.isArray(ms.tasks) ? ms.tasks : [];
      stats.tasks += tasks.length;
      for (const task of tasks) addEstimate(stats, task);
    }
  }

  stats.domains = Array.from(domains).sort();
  stats.expected_tokens = Math.round(stats.expected_tokens);
  stats.expected_duration_hours =
    Math.round(stats.expected_duration_hours * 10) / 10;
  stats.expected_budget_usd = Math.round(stats.expected_budget_usd * 100) / 100;
  return stats;
}

export function buildInitiativeVelocityCardImageUrl(liveUrl: string): string {
  const live = new URL(liveUrl);
  const path = live.pathname.replace(/\/$/, '');
  return new URL(`${path}/opengraph-image`, live.origin).toString();
}

export function buildInitiativeVelocityCardArtifact({
  hierarchy,
  initiativeId,
  liveUrl,
}: {
  hierarchy: unknown;
  initiativeId: string;
  liveUrl: string;
}): InitiativeVelocityCardArtifact {
  const root = safeRecord(hierarchy);
  const initiative = safeRecord(root.initiative);
  const title = safeTitle(initiative, `Initiative ${initiativeId.slice(0, 8)}`);
  const stats = buildInitiativeVelocityCardStats(hierarchy);
  const ogImageUrl = buildInitiativeVelocityCardImageUrl(liveUrl);

  const previewMarkdown = [
    `# Initiative Velocity Card: ${title}`,
    '',
    `Live view: ${liveUrl}`,
    `Branded OG image: ${ogImageUrl}`,
    '',
    `Workstreams: ${stats.workstreams}`,
    `Milestones: ${stats.milestones}`,
    `Tasks: ${stats.tasks}`,
    stats.domains.length ? `Domains: ${stats.domains.join(', ')}` : null,
    '',
    'Widget anchors:',
    ...INITIATIVE_VELOCITY_CARD_WIDGET_ASSETS.map((asset) => `- ${asset}`),
    '',
    // Positioning spine: share cards carry one quiet CTA, verbatim, as the
    // final unobtrusive caption line.
    PROOF_SURFACE_QUIET_CTA,
  ]
    .filter((line): line is string => typeof line === 'string')
    .join('\n');

  return {
    entity_type: 'initiative',
    entity_id: initiativeId,
    initiative_id: initiativeId,
    name: `Initiative Velocity Card: ${title}`,
    artifact_type: 'shared.project_handbook',
    description:
      'Share-ready Initiative Velocity Card generated by scaffold_initiative and anchored to OrgX Live.',
    artifact_url: ogImageUrl,
    external_url: liveUrl,
    preview_markdown: previewMarkdown,
    status: 'approved',
    metadata: {
      kind: 'initiative_velocity_card',
      source: 'scaffold_initiative',
      initiative_id: initiativeId,
      live_url: liveUrl,
      og_image_url: ogImageUrl,
      stats,
      widget_assets: INITIATIVE_VELOCITY_CARD_WIDGET_ASSETS,
      quiet_cta: PROOF_SURFACE_QUIET_CTA,
      card_version: '2026-04-13',
    },
    created_by_type: 'agent',
  };
}
