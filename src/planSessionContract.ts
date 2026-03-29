const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PLAN_SESSION_ACCEPTED_ID_FORMS = [
  'uuid',
  'orgx://plan_session/<uuid>',
] as const;

export interface CanonicalPlanSessionRef {
  id: string;
  uuid: string;
  uri: string;
  accepted_id_forms: readonly string[];
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function normalizePlanSessionId(value: unknown): string | null {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (isUuid(trimmed)) return trimmed;
    if (trimmed.startsWith('orgx://plan_session/')) {
      const candidate = trimmed.slice('orgx://plan_session/'.length);
      return isUuid(candidate) ? candidate : null;
    }
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      normalizePlanSessionId(record.session_id) ??
      normalizePlanSessionId(record.id) ??
      normalizePlanSessionId(record.uuid) ??
      normalizePlanSessionId(record.uri)
    );
  }

  return null;
}

export function buildCanonicalPlanSessionRef(
  value: unknown
): CanonicalPlanSessionRef | null {
  const uuid = normalizePlanSessionId(value);
  if (!uuid) return null;

  return {
    id: uuid,
    uuid,
    uri: `orgx://plan_session/${uuid}`,
    accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
  };
}

export function enrichPlanSessionRecord(
  record: Record<string, unknown>
): Record<string, unknown> {
  const ref = buildCanonicalPlanSessionRef(record.session_id ?? record.id ?? record);
  if (!ref) return record;

  return {
    ...record,
    session_id: ref.id,
    uuid: ref.uuid,
    uri: ref.uri,
    accepted_id_forms: ref.accepted_id_forms,
  };
}

export function enrichPlanSessionResult(
  toolId: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  switch (toolId) {
    case 'start_plan_session':
    case 'improve_plan':
    case 'record_plan_edit':
    case 'complete_plan':
      return enrichPlanSessionRecord(data);

    case 'get_active_sessions': {
      const sessions = Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(data)
        ? data
        : [];
      return {
        ...data,
        sessions: sessions.map((session) =>
          session && typeof session === 'object'
            ? enrichPlanSessionRecord(session as Record<string, unknown>)
            : session
        ),
        accepted_id_forms: PLAN_SESSION_ACCEPTED_ID_FORMS,
      };
    }

    default:
      return data;
  }
}
