export function extractMarkdownSection(
  markdown: string,
  heading: string,
  limitChars: number
): string {
  const lines = markdown.split('\n');
  const target = heading.trim();
  const startIdx = lines.findIndex((line) => line.trim() === target);
  if (startIdx === -1) {
    return markdown.slice(0, limitChars);
  }

  const level = target.match(/^#+/)?.[0]?.length ?? 2;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (i !== startIdx) {
      const m = line.match(/^(#+)\s+/);
      if (m && m[1]!.length <= level) break;
    }
    out.push(line);
    if (out.join('\n').length >= limitChars) break;
  }
  return out.join('\n').slice(0, limitChars);
}

export async function hydrateTaskContext(params: {
  context: unknown[];
  fetchEntity: (
    type: string,
    id: string
  ) => Promise<Record<string, unknown> | null>;
  maxChars: number;
}) {
  const { context, fetchEntity, maxChars } = params;

  const fetchKeys = new Map<string, { type: string; id: string }>();
  for (const entry of context) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryType = typeof record.type === 'string' ? record.type : null;

    if (
      entryType === 'entity' &&
      typeof record.entity_type === 'string' &&
      typeof record.entity_id === 'string'
    ) {
      fetchKeys.set(`entity:${record.entity_type}:${record.entity_id}`, {
        type: record.entity_type,
        id: record.entity_id,
      });
      continue;
    }

    if (entryType === 'artifact' && typeof record.artifact_id === 'string') {
      fetchKeys.set(`artifact:${record.artifact_id}`, {
        type: 'artifact',
        id: record.artifact_id,
      });
      continue;
    }

    if (
      entryType === 'plan_session' &&
      typeof record.session_id === 'string'
    ) {
      fetchKeys.set(`plan_session:${record.session_id}`, {
        type: 'plan_session',
        id: record.session_id,
      });
    }
  }

  const resolvedEntries = new Map<string, Record<string, unknown> | null>();
  await Promise.all(
    Array.from(fetchKeys.entries()).map(async ([key, target]) => {
      const value = await fetchEntity(target.type, target.id);
      resolvedEntries.set(key, value);
    })
  );

  const hydrated: Array<Record<string, unknown>> = [];
  let usedChars = 0;
  let truncated = false;

  for (let i = 0; i < context.length; i++) {
    const entry = context[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      hydrated.push({ index: i, entry, hydrated: null });
      continue;
    }

    const record = entry as Record<string, unknown>;
    const entryType = typeof record.type === 'string' ? record.type : null;
    let hydratedValue: unknown = null;

    if (
      entryType === 'entity' &&
      typeof record.entity_type === 'string' &&
      typeof record.entity_id === 'string'
    ) {
      hydratedValue =
        resolvedEntries.get(
          `entity:${record.entity_type}:${record.entity_id}`
        ) ?? null;
    } else if (
      entryType === 'artifact' &&
      typeof record.artifact_id === 'string'
    ) {
      hydratedValue =
        resolvedEntries.get(`artifact:${record.artifact_id}`) ?? null;
    } else if (
      entryType === 'plan_session' &&
      typeof record.session_id === 'string'
    ) {
      const session =
        resolvedEntries.get(`plan_session:${record.session_id}`) ?? null;
      if (session && typeof (session as any).current_plan === 'string') {
        const full = (session as any).current_plan as string;
        const section =
          typeof record.section === 'string' ? record.section : null;
        hydratedValue = {
          ...session,
          current_plan: section
          ? extractMarkdownSection(full, section, 8000)
          : full.slice(0, 8000),
        };
      } else {
        hydratedValue = session;
      }
    }

    const hydratedEntry = { index: i, entry: record, hydrated: hydratedValue };
    const size = JSON.stringify(hydratedEntry).length;
    if (usedChars + size > maxChars) {
      truncated = true;
      break;
    }
    usedChars += size;
    hydrated.push(hydratedEntry);
  }

  return { hydrated, truncated, usedChars };
}
