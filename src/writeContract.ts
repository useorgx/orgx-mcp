/**
 * orgx_write create-path contract validation (A4).
 *
 * orgx_write already validates operation="update" (id + fields) at the handler,
 * but the CREATE path documents per-type required fields that the schema does
 * not enforce, so malformed creates fail confusingly downstream. This enforces
 * only the UNAMBIGUOUS, exception-free per-type requirements (artifact / blocker
 * / workstream) — the rules with no documented auto-resolution caveat — so it
 * cannot false-block a valid call that relies on backend auto-resolution.
 *
 * Pure and deterministic.
 */

export interface WriteContractResult {
  ok: boolean;
  message?: string;
}

function has(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateWriteCreateContract(
  args: Record<string, unknown>
): WriteContractResult {
  const type = typeof args.type === 'string' ? args.type : '';

  if (type === 'workspace' && !has(args.name) && !has(args.title)) {
    return {
      ok: false,
      message: 'orgx_write type="workspace" requires name or title.',
    };
  }

  // type=workstream REQUIRES initiative_id (no auto-resolution caveat).
  if (type === 'workstream' && !has(args.initiative_id)) {
    return {
      ok: false,
      message: 'orgx_write type="workstream" requires initiative_id.',
    };
  }

  // type=blocker REQUIRES run_id.
  if (type === 'blocker' && !has(args.run_id)) {
    return {
      ok: false,
      message: 'orgx_write type="blocker" requires run_id.',
    };
  }

  // type=artifact: must attach to something (task_id, or entity_type+entity_id),
  // and carry an artifact_type plus a real URL (preview_markdown alone is not
  // accepted) — all explicitly documented as required.
  if (type === 'artifact') {
    if (!has(args.task_id) && !(has(args.entity_type) && has(args.entity_id))) {
      return {
        ok: false,
        message:
          'orgx_write type="artifact" requires task_id, or both entity_type and entity_id, to attach to.',
      };
    }
    if (!has(args.artifact_type)) {
      return { ok: false, message: 'orgx_write type="artifact" requires artifact_type.' };
    }
    if (!has(args.artifact_url) && !has(args.external_url)) {
      return {
        ok: false,
        message:
          'orgx_write type="artifact" requires artifact_url or external_url (preview_markdown alone is not accepted).',
      };
    }
  }

  return { ok: true };
}
