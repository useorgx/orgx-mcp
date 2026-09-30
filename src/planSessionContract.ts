import { planSessionSchema } from './openaiOutputSchemas/shared';

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

export function normalizePlanSessionRequestArgs(
  toolId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...args };

  if (
    toolId === 'record_plan_edit' &&
    typeof normalized.edit_summary === 'string'
  ) {
    normalized.edit_type = 'other';
    normalized.after_content = normalized.edit_summary;
    delete normalized.edit_summary;
  }

  if (
    toolId === 'complete_plan' &&
    normalized.attach_to &&
    typeof normalized.attach_to === 'object' &&
    !Array.isArray(normalized.attach_to)
  ) {
    normalized.attach_to = [normalized.attach_to];
  }

  return normalized;
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
      return enrichPlanSessionRecord(data);

    case 'complete_plan': {
      const attachments = data.context_attachments;
      if (!attachments || typeof attachments !== 'object' || Array.isArray(attachments)) {
        return enrichPlanSessionRecord(data);
      }
      const summary = attachments as Record<string, unknown>;
      // The API also returns requested and API-owned error records. Older
      // advertised MCP contracts close this nested object. Project its
      // receipt without changing the persisted completion or replaying it.
      const errors = Array.isArray(summary.errors) ? summary.errors.map((error) => {
        if (typeof error === 'string') return error;
        if (!error || typeof error !== 'object' || Array.isArray(error)) return 'Attachment failed';
        const record = error as Record<string, unknown>;
        return [record.entity_type, record.entity_id, record.error]
          .filter((value): value is string => typeof value === 'string')
          .join(': ') || 'Attachment failed';
      }) : undefined;
      return enrichPlanSessionRecord({
        ...data,
        context_attachments: {
          ...(summary.attached_count !== undefined ? { attached_count: summary.attached_count } : {}),
          ...(summary.skipped_count !== undefined ? { skipped_count: summary.skipped_count } : {}),
          ...(errors ? { errors } : {}),
        },
      });
    }

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

export function buildPlanSessionInspectionResult(
  data: Record<string, unknown>
): Record<string, unknown> {
  const ref = buildCanonicalPlanSessionRef(data);
  if (!ref) return data;
  const plan = planSessionSchema.parse(enrichPlanSessionRecord(data));
  return {
    _v2_tool: 'orgx_inspect',
    type: 'plan_session',
    ...ref,
    status: plan.status,
    ...(typeof plan.current_plan === 'string' ? { current_plan: plan.current_plan } : {}),
    plan_session: plan,
  };
}

export function buildPlanSessionStructuredResult(
  toolId: string,
  data: Record<string, unknown>,
  requestArgs: Record<string, unknown>
): Record<string, unknown> {
  const sessionId = normalizePlanSessionId(
    data.session_id ?? requestArgs.session_id ?? data.id
  );
  // An edit receipt or critique does not prove the submitted text became the
  // saved plan. Preserve server-returned plan state; only enrich its identity.
  return enrichPlanSessionResult(
    toolId,
    sessionId ? { ...data, session_id: sessionId } : data
  );
}
