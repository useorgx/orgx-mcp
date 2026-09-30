import { z } from 'zod';

import { ControllerStatusEnvelopeSchema } from '../controllerStatusContract';
import {
  jsonValueSchema,
  makeErrorCompatibleSchema,
  makeOpenErrorCompatibleSchema,
  type SourceOutputSchema,
} from './shared';

/**
 * Output contracts for the published v2 tools outside the reviewed ChatGPT
 * surface (that registry lives in ./index and is deliberately unchanged).
 *
 * Every declared type below was read from the code that produces the value,
 * not inferred from a sample. Where the producer is the OrgX API, the source is
 * named. Where the worker itself reads a field defensively (`typeof x ===`),
 * the field is left undeclared: that check is the worker admitting it does not
 * know the type, and a schema must not claim more than the code does.
 *
 * Aliases share their target's schema rather than restating it, because they
 * run the target's code path and return its exact payload.
 */

const openObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).catchall(jsonValueSchema);

// orgx_tail — built entirely by the worker (src/index.ts, `case 'orgx_tail'`).
// capsule_id / after_sequence come from buildContextTailRequest (string /
// number); next_after_sequence is meta.nextAfterSequence when it is a number,
// otherwise after_sequence. material_changes is the events-tail API's `data`
// array of event objects.
const orgxTail = makeOpenErrorCompatibleSchema({
  _v2_tool: z.literal('orgx_tail'),
  base_verified: z.boolean(),
  rebootstrap_required: z.boolean(),
  current_capsule_id: z.string().nullable(),
  reusable_for_consequential_action: z.boolean(),
  delivery_mode: z.string(),
  capsule_id: z.string(),
  after_sequence: z.number(),
  next_after_sequence: z.number(),
  has_more: z.boolean(),
  material_changes: z.array(openObject({})),
  coverage: openObject({
    supported_event_types: z.array(z.string()),
    supported_change_classes: z.array(z.string()),
    unavailable_change_classes: z.array(z.string()),
  }),
});

// orgx_controller_status — the one exact contract in this file. The worker
// validates the API envelope against ControllerStatusEnvelopeSchema (strict)
// and returns only the parsed result, so the shape is guaranteed.
const orgxControllerStatus = makeErrorCompatibleSchema(
  ControllerStatusEnvelopeSchema
);

// orgx_expect — the API's expectation response spread under two worker-set
// fields. The worker reads `replayed` and `expectation` defensively, so only
// its own fields are declared.
const orgxExpect = makeOpenErrorCompatibleSchema({
  _v2_tool: z.literal('orgx_expect'),
  idempotency_key: z.string(),
});

// orgx_emit_activity — POST /api/v1/live/activity returns EmitActivityResult
// (lib/server/reporting/activity.ts) plus auth_mode. run_id and event_id are
// null on the unattributed path, which a plain string would have rejected.
const orgxEmitActivity = makeOpenErrorCompatibleSchema({
  run_id: z.string().nullable(),
  event_id: z.string().nullable(),
  reused_run: z.boolean(),
  session_row_id: z.string(),
  attribution: openObject({}),
  auth_mode: z.string(),
});

// orgx_request_question / orgx_request_attention — both POST to the questions
// route (attention re-exports it). The body is flat, with no `data` wrapper,
// so the worker passes the whole response through. changeset_id, run_id and
// replayed come from applyChangesetResponseSchema.
const orgxRequestQuestion = makeOpenErrorCompatibleSchema({
  decision_id: z.string(),
  status: z.string(),
  attention_url: z.string(),
  answer_url: z.string(),
  changeset_id: z.string(),
  run_id: z.string(),
  replayed: z.boolean(),
});

// orgx_poll_question / orgx_poll_attention — GET /api/v1/live/questions/[id]
// (attention re-exports it). `question` is absent when the call is a list read
// with no id, which the open top level allows.
const orgxPollQuestion = makeOpenErrorCompatibleSchema({
  question: openObject({
    id: z.string(),
    status: z.string(),
    resolved: z.boolean(),
    resolved_at: z.string().nullable(),
    source: openObject({}),
    continuation: openObject({
      should_resume: z.boolean(),
    }),
  }),
});

// orgx_ack_attention — POST /api/v1/live/questions/[id]. `replayed` and the
// continuation's inner fields are not typed at the source, so they pass
// through undeclared.
const orgxAckAttention = makeOpenErrorCompatibleSchema({
  decision_id: z.string(),
});

// orgx_emit_execution_graph — POST /api/v1/live/execution-graph returns its
// projection under `data`; the only field this worker can vouch for is the
// auth mode the route stamps on every response.
const orgxEmitExecutionGraph = makeOpenErrorCompatibleSchema({
  session_row_id: z.string(),
  auth_mode: z.string(),
});

// consolidate_pr — POST /api/v1/consolidate-pr returns the consolidation
// service's data plus auth_mode. The service result is untyped at the route,
// and the worker reads every other field defensively.
const consolidatePr = makeOpenErrorCompatibleSchema({
  auth_mode: z.string(),
});

// request_independent_artifact_review — POST
// /api/v1/artifacts/[artifactId]/independent-review. artifact_version is
// `artifact.version ?? 1`; agent_type is a nullable column.
const requestIndependentArtifactReview = makeOpenErrorCompatibleSchema({
  artifact_id: z.string(),
  artifact_version: z.number(),
  agent_type: z.string().nullable(),
  status: z.string(),
  rubric_version: z.string(),
  rating_scale: z.string(),
  independent_of_producer: z.boolean(),
});

// query_org_memory (and recall_memory, which runs it) — the API tool executor
// returns several differently shaped successes depending on what the query
// matched. live_url is added by the worker as a string when the result
// carries an initiative.
const queryOrgMemory = makeOpenErrorCompatibleSchema({
  live_url: z.string(),
});

// spawn_agent_task (and delegate_agent_task, which runs it) — three success
// shapes in lib/agents/tools/chatgptApp.ts (dedup, direct spawn, routed
// spawn). These fields are present in all three; ids and names are nullable
// columns.
const spawnAgentTask = makeOpenErrorCompatibleSchema({
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  status: z.string(),
  live_url: z.string(),
});

// recommend_next_action — two success shapes (canonical-only and scored).
const recommendNextAction = makeOpenErrorCompatibleSchema({
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  canonical_only: z.boolean(),
});

export const V2_OUTPUT_SCHEMAS: Readonly<Record<string, SourceOutputSchema>> =
  Object.freeze({
    orgx_tail: orgxTail,
    orgx_controller_status: orgxControllerStatus,
    orgx_expect: orgxExpect,
    orgx_emit_activity: orgxEmitActivity,
    orgx_request_question: orgxRequestQuestion,
    orgx_request_attention: orgxRequestQuestion,
    orgx_poll_question: orgxPollQuestion,
    orgx_poll_attention: orgxPollQuestion,
    orgx_ack_attention: orgxAckAttention,
    orgx_emit_execution_graph: orgxEmitExecutionGraph,
    consolidate_pr: consolidatePr,
    request_independent_artifact_review: requestIndependentArtifactReview,
    query_org_memory: queryOrgMemory,
    recall_memory: queryOrgMemory,
    spawn_agent_task: spawnAgentTask,
    delegate_agent_task: spawnAgentTask,
    recommend_next_action: recommendNextAction,
  });

/**
 * Tools that run another tool's exact code path, so they must advertise that
 * tool's contract. track_project_progress runs get_initiative_pulse, whose
 * schema lives in the reviewed ChatGPT registry.
 */
export const OUTPUT_SCHEMA_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    track_project_progress: 'get_initiative_pulse',
  });
