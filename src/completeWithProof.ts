type RecordLike = Record<string, unknown>;

export type CompleteWithProofApiCall = (
  path: string,
  init?: RequestInit,
) => Promise<RecordLike>;

export interface CompleteWithProofFlowInput {
  entityType: string;
  entityId: string;
  attachPayload?: RecordLike | null;
  completeBody?: RecordLike;
  callApi: CompleteWithProofApiCall;
}

export interface CompleteWithProofFlowResult {
  completed: boolean;
  attachResult: RecordLike | null;
  verifyResult: RecordLike;
  verification: RecordLike | null;
  completeResult: RecordLike | null;
}

function readString(...values: unknown[]): string | null {
  return (
    values
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      ?.trim() ?? null
  );
}

/**
 * Canonical vocabularies from lib/server/proof/proofPacketContract.ts.
 *
 * These are validated at RUNTIME, not just typed. TypeScript casts do not
 * protect an API boundary: a probe with proof_state:"bogus" previously emitted
 * "bogus" verbatim into the packet at both levels, because nothing checked
 * membership on the way through.
 */
const PROOF_STATES = new Set([
  "draft",
  "in_review",
  "approved",
  "changes_requested",
  "superseded",
]);
const EVAL_STATES = new Set([
  "missing",
  "pending",
  "passed",
  "failed",
  "skipped",
]);

/**
 * NOTE ON PLACEMENT — this is preflight, not the security boundary.
 *
 * Authority is enforced in the private monorepo at the write boundary. It has
 * to be: this worker is a CLIENT of that API (it calls /api/client/artifacts,
 * /api/entities/verify, /api/entities/:type/:id/complete), so a caller with an
 * API key reaches those endpoints without passing through here at all.
 *
 * What this file does is refuse to CONSTRUCT a claim the caller did not make,
 * and refuse to pass through a value the contract does not define. That is
 * useful as defense in depth and as an honest-client guarantee. It is NOT
 * security, and must not be relied on as such — notably `created_by_type` is
 * caller-supplied, so any check keyed on it can be defeated by sending a
 * different string. Publishing these rules costs nothing; authorization has to
 * hold when its rules are known.
 */
function contractValue(
  claimed: string | null,
  allowed: Set<string>,
  fallback: string,
): string {
  if (!claimed) return fallback;
  return allowed.has(claimed) ? claimed : fallback;
}

export interface CompletionProofMetadataInput {
  metadata?: RecordLike | null;
  artifact?: RecordLike | null;
  entityType: string;
  entityId: string;
  artifactId?: unknown;
  artifactUrl?: unknown;
  externalUrl?: unknown;
  atomicUnitType?: unknown;
  artifactHash?: unknown;
  qualityScore?: unknown;
  verification?: unknown;
  schemaValidated?: unknown;
  schemaValidatedArtifact?: unknown;
  createdByType?: unknown;
  createdById?: unknown;
  sourceClient?: unknown;
  runOrSessionRef?: unknown;
}

/**
 * Build the proof packet consumed by OrgX's L1/L2 completion verifier.
 *
 * `complete_with_proof` used to attach only artifact identity and quality. The
 * verifier then (correctly) rejected the incomplete packet for missing
 * outcome, owner/source, and next-action fields, leaving callers no path except
 * `force=true`. These defaults describe the actual MCP action and keep caller
 * metadata authoritative when a more specific value is supplied.
 */
export function buildCompletionProofMetadata(
  input: CompletionProofMetadataInput,
): RecordLike {
  const artifact = input.artifact ?? {};
  const metadata = input.metadata ?? {};
  const existingProof =
    metadata.proof &&
    typeof metadata.proof === "object" &&
    !Array.isArray(metadata.proof)
      ? (metadata.proof as RecordLike)
      : {};
  const existingProofEval =
    existingProof.eval &&
    typeof existingProof.eval === "object" &&
    !Array.isArray(existingProof.eval)
      ? (existingProof.eval as RecordLike)
      : {};
  const verification = Array.isArray(input.verification)
    ? input.verification.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const artifactReference = readString(
    input.artifactHash,
    artifact.artifact_hash,
    input.artifactId,
    input.artifactUrl,
    input.externalUrl,
  );
  const createdByType = readString(input.createdByType) ?? "agent";
  const createdById = readString(input.createdById);
  const runOrSessionRef =
    readString(
      metadata.run_or_session_ref,
      metadata.run_ref,
      metadata.run_id,
      metadata.session_id,
      input.runOrSessionRef,
    ) ?? `mcp:entity_action:${input.entityType}:${input.entityId}`;

  return {
    ...metadata,
    ...(artifactReference ? { artifact_identity: artifactReference } : {}),
    atomic_unit_type:
      readString(input.atomicUnitType, artifact.atomic_unit_type) ??
      "completion_proof",
    ...(artifactReference ? { artifact_hash: artifactReference } : {}),
    // Absence of evidence is not evidence. Every default below used to assert
    // something the caller never claimed: an agent calling complete_with_proof
    // with no flags received schema_validated:true, proof_state:"approved",
    // quality_eval_state:"passed" and outcome_event_status:"completion_verified"
    // — six unearned assertions manufactured by `??`.
    //
    // The whole product claim is that OrgX can tell you what was actually
    // verified and accepted. A default that fabricates approval is not a
    // cosmetic bug; it is the product asserting the one thing it sells.
    //
    // A caller that HAS validated or HAS been approved still passes those
    // values through untouched. Only silence changed meaning.
    schema_validated: input.schemaValidated ?? false,
    schema_validated_artifact:
      input.schemaValidatedArtifact ?? input.schemaValidated ?? false,
    completion_state: "completed",
    // Values come from the canonical proof-packet contract in the monorepo
    // (lib/server/proof/proofPacketContract.ts), NOT invented here:
    //   proof_state       draft | in_review | approved | changes_requested | superseded
    //   quality_eval_state missing | pending | passed | failed | skipped
    // An earlier pass used "pending"/"not_run", which read as honest but are not
    // in either enum — inventing vocabulary to describe a contract is the same
    // error as inventing a claim about it.
    //
    // in_review = evidence attached, awaiting a ruling.
    // missing   = no eval ran. ("pending" would imply one is queued.)
    //
    // Whether a caller is PERMITTED to assert "approved" or "passed" is decided
    // in the private monorepo at the write boundary, not here — see the
    // placement note above.
    proof_state: contractValue(
      readString(metadata.proof_state, existingProof.state),
      PROOF_STATES,
      "in_review",
    ),
    quality_eval_state: contractValue(
      readString(metadata.quality_eval_state, existingProofEval.status),
      EVAL_STATES,
      "missing",
    ),
    // Consumed by a PRESENCE check (lib/server/proof/status.ts
    // IMPACT_SIGNAL_PATHS via hasNonEmptyValue), so ANY non-empty string here
    // counts as impact evidence. The producer is therefore barred from writing
    // the privileged value, but note this only narrows the hole: the presence
    // check still treats "completion_claimed" as impact. Closing that properly
    // means status.ts must stop reading a self-asserted string as evidence,
    // which is a monorepo change and is NOT done here.
    // Reads the nested value too. Previously the top level ignored
    // metadata.proof.outcome_status while the nested packet accepted it, so a
    // nested-only caller produced a packet whose two halves disagreed.
    outcome_event_status:
      readString(
        metadata.outcome_event_status,
        existingProof.outcome_status,
      ) ?? "completion_claimed",
    source_tool:
      readString(metadata.source_tool) ?? "entity_action.complete_with_proof",
    source_client:
      readString(metadata.source_client, input.sourceClient) ?? "mcp",
    owner_source:
      readString(metadata.owner_source, metadata.source_tool) ??
      "entity_action.complete_with_proof",
    run_or_session_ref: runOrSessionRef,
    run_ref: runOrSessionRef,
    created_by_type: readString(metadata.created_by_type) ?? createdByType,
    ...(createdById && !readString(metadata.created_by_id)
      ? { created_by_id: createdById }
      : {}),
    // "monitor adoption and impact" told the caller to go watch the outcome of
    // work nobody had verified yet. The honest next step after a claim is the
    // verification that has not happened.
    next_action:
      readString(metadata.next_action, existingProof.next_action) ??
      "verify_before_claiming_outcome",
    ...(typeof input.qualityScore === "number"
      ? { quality_score: input.qualityScore }
      : {}),
    ...(verification.length > 0 ? { verification } : {}),
    entity_type: input.entityType,
    entity_id: input.entityId,
    ...(input.entityType === "task" ? { task_id: input.entityId } : {}),
    // The nested packet MUST agree with the top-level fields above. A previous
    // pass fixed only the top level and left these defaulting to
    // "completion_verified" / "monitor_adoption_and_impact", producing a record
    // that contradicted itself — and the nested values win, because
    // lib/server/proof/proofPacketMigrationPlan.ts reads proof.* as the
    // canonical source with the top level only as fallback. A half-fixed packet
    // is worse than an unfixed one: it looks corrected while still asserting
    // verification.
    proof: {
      ...existingProof,
      state: contractValue(
        readString(metadata.proof_state, existingProof.state),
        PROOF_STATES,
        "in_review",
      ),
      eval: {
        ...existingProofEval,
        status: contractValue(
          readString(metadata.quality_eval_state, existingProofEval.status),
          EVAL_STATES,
          "missing",
        ),
      },
      outcome_status:
        readString(
          metadata.outcome_event_status,
          existingProof.outcome_status,
        ) ?? "completion_claimed",
      next_action:
        readString(metadata.next_action, existingProof.next_action) ??
        "verify_before_claiming_outcome",
    },
  };
}

/**
 * Execute the virtual complete_with_proof action against canonical OrgX APIs.
 *
 * complete_with_proof is intentionally not a backend lifecycle action. It is an
 * MCP composition that attaches proof, checks the proof gate, and only then
 * calls the canonical /complete endpoint. Keeping this sequence in one helper
 * prevents the compact and compatibility tool surfaces from drifting apart.
 */
export async function executeCompleteWithProofFlow(
  input: CompleteWithProofFlowInput,
): Promise<CompleteWithProofFlowResult> {
  const attachResult = input.attachPayload
    ? await input.callApi("/api/client/artifacts", {
        method: "POST",
        body: JSON.stringify(input.attachPayload),
      })
    : null;

  const verifyParams = new URLSearchParams({
    type: input.entityType,
    id: input.entityId,
  });
  const verifyResult = await input.callApi(
    `/api/entities/verify?${verifyParams.toString()}`,
  );
  const verification =
    verifyResult.verification &&
    typeof verifyResult.verification === "object" &&
    !Array.isArray(verifyResult.verification)
      ? (verifyResult.verification as RecordLike)
      : null;

  if (verification?.verified !== true) {
    return {
      completed: false,
      attachResult,
      verifyResult,
      verification,
      completeResult: null,
    };
  }

  const completeResult = await input.callApi(
    `/api/entities/${input.entityType}/${input.entityId}/complete`,
    {
      method: "POST",
      body: JSON.stringify(input.completeBody ?? {}),
    },
  );

  return {
    completed: true,
    attachResult,
    verifyResult,
    verification,
    completeResult,
  };
}
