import { z } from 'zod';

/**
 * Structural projection of the portable v0.2 contract, accepting v0.1's subset.
 * The OrgX SDK remains authoritative for version semantics, reference integrity,
 * bounded complexity and the org.orgx.review/v1 extension. Arbitrary JSON is
 * accepted only in the standard's explicitly namespaced extension/metadata slots.
 * Metadata carries producer data and never selects an operation or grants trust.
 */
const portable_json_object = z.record(z.unknown());

const portable_id = z.string().min(1).max(512).regex(new RegExp("\\S"));

const portable_long_string = z.string().min(1).max(20000).regex(new RegExp("\\S"));

const portable_short_string = z.string().min(1).max(512).regex(new RegExp("\\S"));

const portable_digest = z.object({
  algorithm: portable_short_string,
  value: z.string().min(1).max(8192),
  encoding: z.enum(["hex", "base64", "base64url"]).optional(),
}).strict();

const portable_external_reference = z.object({
  system: portable_short_string,
  type: portable_short_string,
  id: portable_id,
  uri: z.string().min(1).max(8192).optional(),
  version: portable_short_string.optional(),
  digest: portable_digest.optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_criterion = z.object({
  id: portable_id,
  text: portable_long_string,
  kind: portable_short_string.optional(),
  required: z.boolean().optional(),
  source: z.enum(["requested", "inferred", "policy", "agent_proposed"]).optional(),
}).strict();

const portable_expected_outcome = z.object({
  id: portable_id,
  description: portable_long_string,
  metric: portable_short_string.optional(),
  unit: portable_short_string.optional(),
  min: z.number().finite().min(-9007199254740991).max(9007199254740991).optional(),
  max: z.number().finite().min(-9007199254740991).max(9007199254740991).optional(),
  target: z.number().finite().min(-9007199254740991).max(9007199254740991).optional(),
}).strict();

const portable_intent = z.object({
  summary: portable_long_string,
  objective: portable_long_string.optional(),
  acceptance_criteria: z.array(portable_long_string).max(1000).optional(),
  constraints: z.array(portable_long_string).max(1000).optional(),
  request_ref: portable_external_reference.optional(),
  metadata: portable_json_object.optional(),
  criteria: z.array(portable_criterion).max(1000).optional(),
  expected_outcomes: z.array(portable_expected_outcome).max(100).optional(),
}).strict();

const portable_runtime = z.object({
  name: portable_short_string,
  version: portable_short_string.optional(),
}).strict();

const portable_model = z.object({
  provider: portable_short_string,
  name: portable_short_string,
  version: portable_short_string.optional(),
}).strict();

const portable_actor = z.object({
  type: z.enum(["agent", "service", "human", "team", "system", "other"]),
  id: portable_id,
  display_name: portable_short_string.optional(),
  runtime: portable_runtime.optional(),
  model: portable_model.optional(),
  external_refs: z.array(portable_external_reference).max(1000).optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_money_limit = z.object({
  currency: z.string().min(3).max(12).regex(new RegExp("^[A-Z][A-Z0-9_-]+$")),
  amount: z.number().finite().min(0).max(9007199254740991),
}).strict();

const portable_authority_scope = z.object({
  actions: z.array(portable_short_string).max(1000),
  resources: z.array(portable_external_reference).max(1000),
  systems: z.array(portable_short_string).max(1000).optional(),
  spend_limit: portable_money_limit.optional(),
}).strict();

const portable_approval = z.object({
  status: z.enum(["requested", "granted", "denied", "revoked", "expired"]),
  approver: portable_actor,
  scope: portable_long_string.optional(),
  occurred_at: z.string().datetime({ offset: true }),
  ref: portable_external_reference.optional(),
}).strict();

const portable_authority = z.object({
  mode: z.enum(["explicit", "delegated", "inherited", "policy", "none", "unknown"]),
  status: z.enum(["granted", "restricted", "denied", "expired", "unknown"]),
  scope: portable_authority_scope,
  delegated_by: portable_actor.optional(),
  authorization_ref: portable_external_reference.optional(),
  approvals: z.array(portable_approval).max(1000).optional(),
  constraints: z.array(portable_long_string).max(1000).optional(),
  valid_from: z.string().datetime({ offset: true }).optional(),
  valid_until: z.string().datetime({ offset: true }).optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_action = z.object({
  id: portable_id,
  type: portable_short_string,
  summary: portable_long_string,
  status: z.enum(["planned", "running", "completed", "failed", "skipped", "blocked"]),
  system: portable_short_string.optional(),
  tool_ref: portable_external_reference.optional(),
  target_refs: z.array(portable_external_reference).max(1000).optional(),
  input_refs: z.array(portable_external_reference).max(1000).optional(),
  output_refs: z.array(portable_external_reference).max(1000).optional(),
  started_at: z.string().datetime({ offset: true }).optional(),
  completed_at: z.string().datetime({ offset: true }).optional(),
  error: portable_long_string.optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_artifact = z.object({
  id: portable_id,
  kind: portable_short_string,
  name: portable_short_string,
  ref: portable_external_reference,
  role: z.enum(["input", "intermediate", "output", "log", "report", "other"]).optional(),
  media_type: portable_short_string.optional(),
  digest: portable_digest.optional(),
  size_bytes: z.number().finite().int().min(0).max(9007199254740991).optional(),
  created_at: z.string().datetime({ offset: true }).optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_evidence = z.object({
  id: portable_id,
  kind: portable_short_string,
  summary: portable_long_string,
  ref: portable_external_reference.optional(),
  digest: portable_digest.optional(),
  observed_at: z.string().datetime({ offset: true }),
  excerpt: portable_long_string.optional(),
  supports: z.array(portable_short_string).max(1000).optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_outcome_metric = z.object({
  name: portable_short_string,
  value: z.number().finite().min(-9007199254740991).max(9007199254740991),
  unit: portable_short_string,
  baseline: z.number().finite().min(-9007199254740991).max(9007199254740991).optional(),
  target: z.number().finite().min(-9007199254740991).max(9007199254740991).optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
  evidence_ids: z.array(portable_id).max(1000).optional(),
}).strict();

const portable_acceptance = z.object({
  status: z.enum(["pending", "accepted", "rejected", "changes_requested"]),
  actor: portable_actor.optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  evidence_ids: z.array(portable_id).max(1000).optional(),
  notes: portable_long_string.optional(),
}).strict();

const portable_confidence = z.number().finite().min(0).max(1);

const portable_criterion_result = z.object({
  criterion_id: portable_id,
  status: z.enum(["met", "unmet", "unknown", "waived"]),
  evidence_ids: z.array(portable_id).max(1000),
  confidence: portable_confidence.optional(),
  decided_by: portable_actor.optional(),
  notes: portable_long_string.optional(),
}).strict();

const portable_expected_result = z.object({
  expected_id: portable_id,
  status: z.enum(["within", "outside", "unknown"]),
  observed: z.union([z.number().finite().min(-9007199254740991).max(9007199254740991), portable_long_string]).optional(),
  evidence_ids: z.array(portable_id).max(1000),
  confidence: portable_confidence.optional(),
}).strict();

const portable_outcome = z.object({
  status: z.enum(["succeeded", "partially_succeeded", "failed", "blocked", "cancelled", "unknown"]),
  summary: portable_long_string,
  observed_effects: z.array(portable_long_string).max(1000).optional(),
  metrics: z.array(portable_outcome_metric).max(1000).optional(),
  acceptance: portable_acceptance.optional(),
  metadata: portable_json_object.optional(),
  criteria_results: z.array(portable_criterion_result).max(1000).optional(),
  expected_results: z.array(portable_expected_result).max(100).optional(),
}).strict();

const portable_verification_check = z.object({
  id: portable_id,
  name: portable_short_string,
  status: z.enum(["passed", "failed", "skipped", "inconclusive"]),
  method: portable_long_string.optional(),
  evidence_ids: z.array(portable_id).max(1000),
  details: portable_long_string.optional(),
  criterion_ids: z.array(portable_id).max(1000).optional(),
}).strict();

const portable_verification = z.object({
  status: z.enum(["unverified", "passed", "failed", "partial", "inconclusive"]),
  method: portable_long_string,
  verifier: portable_actor.optional(),
  checks: z.array(portable_verification_check).max(10000),
  evidence_ids: z.array(portable_id).max(10000),
  verified_at: z.string().datetime({ offset: true }).optional(),
  notes: portable_long_string.optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_cost_component = z.object({
  category: portable_short_string,
  amount: z.number().finite().min(0).max(9007199254740991),
  description: portable_long_string.optional(),
}).strict();

const portable_usage = z.object({
  name: portable_short_string,
  quantity: z.number().finite().min(0).max(9007199254740991),
  unit: portable_short_string,
  cost: z.number().finite().min(0).max(9007199254740991).optional(),
}).strict();

const portable_cost = z.object({
  currency: z.string().min(3).max(12).regex(new RegExp("^[A-Z][A-Z0-9_-]+$")),
  total: z.number().finite().min(0).max(9007199254740991),
  components: z.array(portable_cost_component).max(1000).optional(),
  usage: z.array(portable_usage).max(1000).optional(),
  human_minutes: z.number().finite().min(0).max(9007199254740991).optional(),
  estimated: z.boolean().optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_lineage_edge = z.object({
  relationship: portable_short_string,
  ref: portable_external_reference,
  confidence: portable_confidence.optional(),
}).strict();

const portable_lineage = z.object({
  run_ref: portable_external_reference.optional(),
  parent_receipt_refs: z.array(portable_external_reference).max(1000),
  references: z.array(portable_lineage_edge).max(10000),
  trace_id: portable_id.optional(),
  span_id: portable_id.optional(),
  metadata: portable_json_object.optional(),
  workstream_ref: portable_external_reference.optional(),
}).strict();

const portable_human_intervention = z.object({
  id: portable_id,
  kind: z.enum(["approval", "correction", "input", "execution", "escalation", "override", "review", "other"]),
  actor: portable_actor,
  summary: portable_long_string,
  occurred_at: z.string().datetime({ offset: true }),
  duration_minutes: z.number().finite().min(0).max(9007199254740991).optional(),
  evidence_ids: z.array(portable_id).max(1000).optional(),
  refs: z.array(portable_external_reference).max(1000).optional(),
  metadata: portable_json_object.optional(),
}).strict();

const portable_timestamps = z.object({
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }),
  issued_at: z.string().datetime({ offset: true }),
  observed_at: z.string().datetime({ offset: true }).optional(),
  duration_ms: z.number().finite().int().min(0).max(9007199254740991).optional(),
}).strict();

const portable_content_hash = z.object({
  algorithm: z.enum(["sha-256", "sha256"]),
  value: z.string().min(1).max(128),
  encoding: z.enum(["hex", "base64", "base64url"]).optional(),
}).strict();

const portable_signature = z.object({
  algorithm: z.literal("ed25519"),
  encoding: z.literal("base64url"),
  value: z.string().regex(new RegExp("^[A-Za-z0-9_-]{85}[AQgw]$")),
  key_id: portable_id,
  signer: portable_actor.optional(),
  signed_at: z.string().datetime({ offset: true }).optional(),
}).strict();

const portable_integrity = z.object({
  content_hash: portable_content_hash,
  signatures: z.array(portable_signature).min(1).max(100).optional(),
}).strict();

const portable_provenance_entry = z.object({
  path: z.string().max(512).regex(new RegExp("^(/([^~/]|~[01])*)*$")),
  basis: z.enum(["observed", "declared", "inferred", "human"]),
  confidence: portable_confidence.optional(),
  method: portable_short_string.optional(),
  by: portable_actor.optional(),
  at: z.string().datetime({ offset: true }).optional(),
}).strict();

const portable_trajectory_step = z.object({
  id: portable_id,
  kind: z.enum(["change_of_course", "retry", "escalation", "handoff", "compaction", "pause", "resume"]),
  summary: portable_long_string,
  trigger: z.enum(["error", "denial", "human", "self", "policy", "timeout", "other"]).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  action_ids: z.array(portable_id).max(1000).optional(),
  evidence_ids: z.array(portable_id).max(1000).optional(),
  confidence: portable_confidence.optional(),
}).strict();

export const portableReceiptInput = z.object({
  schema_version: z.enum(["agent-work-receipt/v0.1", "agent-work-receipt/v0.2"]),
  receipt_id: portable_id,
  intent: portable_intent,
  actor: portable_actor,
  authority: portable_authority,
  actions: z.array(portable_action).min(1).max(10000),
  artifacts: z.array(portable_artifact).max(10000),
  evidence: z.array(portable_evidence).min(1).max(10000),
  outcome: portable_outcome,
  verification: portable_verification,
  cost: portable_cost,
  lineage: portable_lineage,
  human_interventions: z.array(portable_human_intervention).max(10000),
  timestamps: portable_timestamps,
  integrity: portable_integrity.optional(),
  extensions: portable_json_object.optional(),
  provenance: z.array(portable_provenance_entry).max(1000).optional(),
  trajectory: z.array(portable_trajectory_step).max(1000).optional(),
}).strict()
  .superRefine((receipt, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(receipt)).byteLength;
    if (bytes > 262_144) context.addIssue({ code: 'custom', message: 'Receipt must be at most 262144 UTF-8 bytes.' });
  });
