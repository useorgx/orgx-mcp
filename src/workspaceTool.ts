export type WorkspaceCreateBody = {
  name: string;
  identity?: {
    tagline?: string | null;
    narrative?: string | null;
    keyMetrics?: string[];
    roadmapUrl?: string | null;
    sourceLinks?: string[];
  };
};

export type WorkspaceCreateBodyResult =
  | { ok: true; body: WorkspaceCreateBody; setActive: boolean }
  | { ok: false; error: string };

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function getStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function buildWorkspaceCreateBody(
  args: Record<string, unknown>
): WorkspaceCreateBodyResult {
  const name = getString(args.name ?? args.title);
  if (!name) {
    return {
      ok: false,
      error: 'name is required when workspace action=create',
    };
  }

  const tagline = getString(args.tagline);
  const narrative = getString(args.narrative ?? args.description);
  const roadmapUrl = getString(args.roadmap_url ?? args.roadmapUrl);
  const keyMetrics = getStringArray(args.key_metrics ?? args.keyMetrics);
  const sourceLinks = getStringArray(args.source_links ?? args.sourceLinks);

  const identity: WorkspaceCreateBody['identity'] = {};
  if (tagline) identity.tagline = tagline;
  if (narrative) identity.narrative = narrative;
  if (roadmapUrl) identity.roadmapUrl = roadmapUrl;
  if (keyMetrics) identity.keyMetrics = keyMetrics;
  if (sourceLinks) identity.sourceLinks = sourceLinks;

  return {
    ok: true,
    body: {
      name,
      ...(Object.keys(identity).length > 0 ? { identity } : {}),
    },
    setActive: getBoolean(args.set_active ?? args.setActive, true),
  };
}
