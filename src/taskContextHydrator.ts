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
      hydratedValue = await fetchEntity(record.entity_type, record.entity_id);
    } else if (
      entryType === 'artifact' &&
      typeof record.artifact_id === 'string'
    ) {
      hydratedValue = await fetchEntity('artifact', record.artifact_id);
    } else if (
      entryType === 'plan_session' &&
      typeof record.session_id === 'string'
    ) {
      const session = await fetchEntity('plan_session', record.session_id);
      if (session && typeof (session as any).current_plan === 'string') {
        const full = (session as any).current_plan as string;
        const section =
          typeof record.section === 'string' ? record.section : null;
        (session as any).current_plan = section
          ? extractMarkdownSection(full, section, 8000)
          : full.slice(0, 8000);
      }
      hydratedValue = session;
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
