import { z } from 'zod';

export const CONTROLLER_PROTOCOL_VERSION = 'orgx.controller.v1' as const;

export const ControllerDomainSchema = z.enum([
  'product',
  'engineering',
  'growth',
  'sales',
  'design',
  'operations',
]);

export type ControllerDomain = z.infer<typeof ControllerDomainSchema>;

const NonEmptyStringSchema = z.string().trim().min(1);
const UUIDSchema = z.string().uuid();
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ISODateTimeSchema = z.string().datetime({ offset: true });
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const ControllerIdSchema = z
  .string()
  .regex(/^domain\.[a-z][a-z0-9_-]{1,63}$/);
const ControllerSpecRevisionSchema = z
  .string()
  .regex(/^controller_spec_revision:[a-f0-9]{64}$/);
const ControllerRunIdSchema = z
  .string()
  .regex(/^controller_run:[a-f0-9]{64}$/);

const ControllerSourceHealthSchema = z
  .object({
    state: z.enum([
      'healthy',
      'stale',
      'insufficient_evidence',
      'unavailable',
      'truncated',
    ]),
    observedAt: ISODateTimeSchema,
    freshnessWatermark: ISODateTimeSchema.nullable(),
    sourceCursor: NonEmptyStringSchema.max(512).nullable(),
    recordCount: z.number().int().nonnegative(),
    limitations: z.array(NonEmptyStringSchema.max(500)),
  })
  .strict();

const ControllerDecisionProposalSchema = z
  .object({
    proposalId: z
      .string()
      .regex(/^controller_decision_proposal:[a-f0-9]{64}$/),
    controllerId: ControllerIdSchema,
    domain: ControllerDomainSchema,
    specRevision: ControllerSpecRevisionSchema,
    decisionType: NonEmptyStringSchema.max(120),
    title: NonEmptyStringSchema.max(240),
    summary: NonEmptyStringSchema.max(2_000),
    priority: z.enum(['low', 'medium', 'high']),
    recommendedAction: NonEmptyStringSchema.max(2_000),
    signalRef: z
      .object({
        id: NonEmptyStringSchema,
        digest: DigestSchema,
      })
      .strict(),
    createdAt: ISODateTimeSchema,
    requiresHumanDecision: z.literal(true),
    authorityEffect: z.literal('none'),
  })
  .strict();

const ControllerLearningProposalSchema = z
  .object({
    proposalId: z
      .string()
      .regex(/^controller_learning_proposal:[a-f0-9]{64}$/),
    controllerId: ControllerIdSchema,
    basedOnRunIds: z.array(ControllerRunIdSchema).min(3),
    rationale: NonEmptyStringSchema.max(2_000),
    proposedSpecPatch: JsonObjectSchema,
    createdAt: ISODateTimeSchema,
    requiresRatification: z.literal(true),
    applied: z.literal(false),
  })
  .strict();

export const ControllerStatusDataSchema = z
  .object({
    controller_id: ControllerIdSchema,
    domain: ControllerDomainSchema,
    spec_revision: ControllerSpecRevisionSchema,
    run_id: ControllerRunIdSchema.nullable(),
    last_run_id: ControllerRunIdSchema.nullable(),
    status: z.enum([
      'never_run',
      'running',
      'healthy',
      'degraded',
      'failed',
    ]),
    result: z.enum(['proposal', 'noop']),
    last_result: z.enum(['proposal', 'noop']).nullable(),
    last_signal_id: NonEmptyStringSchema.max(240).nullable(),
    last_signal_state: z.enum(['observed', 'cleared']).nullable(),
    last_error_code: NonEmptyStringSchema.max(120).nullable(),
    event_ids: z.array(NonEmptyStringSchema.max(240)),
    projection_cursor: z.string().regex(/^(0|[1-9]\d*)$/),
    decision_id: UUIDSchema.nullable(),
    decision_event_id: UUIDSchema.nullable(),
    receipt_id: UUIDSchema.nullable(),
    last_receipt_id: UUIDSchema.nullable(),
    duplicate: z.boolean(),
    protocol_version: z.literal(CONTROLLER_PROTOCOL_VERSION),
    mode: z.literal('shadow'),
    proposal: ControllerDecisionProposalSchema.nullable(),
    learning_proposal: ControllerLearningProposalSchema.nullable(),
    noop_reason: z
      .enum([
        'below_threshold',
        'signal_cleared',
        'cooldown_active',
        'stale_input',
        'insufficient_evidence',
        'source_unavailable',
        'truncated_input',
        'stopped_by_policy',
      ])
      .nullable(),
    source_health: ControllerSourceHealthSchema.nullable(),
    limitations: z.array(NonEmptyStringSchema.max(500)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasProposal = value.proposal !== null;
    if ((value.result === 'proposal') !== hasProposal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposal'],
        message:
          'Proposal must be present exactly when the selected result is proposal',
      });
    }

    const decisionLineage = [
      value.decision_id,
      value.decision_event_id,
      value.receipt_id,
    ];
    const presentDecisionLineage = decisionLineage.filter(
      (identifier): identifier is string => identifier !== null
    );
    if (
      presentDecisionLineage.length !== 0 &&
      presentDecisionLineage.length !== decisionLineage.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision_id'],
        message:
          'Decision, decision event, and receipt IDs must be all null or all present',
      });
    } else if (
      presentDecisionLineage.length === decisionLineage.length &&
      new Set(
        presentDecisionLineage.map((identifier) => identifier.toLowerCase())
      ).size !== decisionLineage.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision_event_id'],
        message:
          'Decision, decision event, and receipt IDs must be pairwise distinct',
      });
    }

    if ((value.last_signal_id === null) !== (value.last_signal_state === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['last_signal_state'],
        message: 'Last signal ID and state must be present or absent together',
      });
    }

    if (value.status !== 'never_run') return;

    const nullWhenNeverRun = [
      ['run_id', value.run_id],
      ['last_run_id', value.last_run_id],
      ['last_result', value.last_result],
      ['last_signal_id', value.last_signal_id],
      ['last_signal_state', value.last_signal_state],
      ['last_error_code', value.last_error_code],
      ['decision_id', value.decision_id],
      ['decision_event_id', value.decision_event_id],
      ['receipt_id', value.receipt_id],
      ['last_receipt_id', value.last_receipt_id],
      ['proposal', value.proposal],
      ['learning_proposal', value.learning_proposal],
      ['noop_reason', value.noop_reason],
      ['source_health', value.source_health],
    ] as const;
    for (const [field, fieldValue] of nullWhenNeverRun) {
      if (fieldValue !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be null when status is never_run`,
        });
      }
    }
    if (value.result !== 'noop') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result'],
        message:
          'result must use the API noop sentinel when status is never_run',
      });
    }
    if (value.event_ids.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event_ids'],
        message: 'event_ids must be empty when status is never_run',
      });
    }
    if (value.duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duplicate'],
        message: 'duplicate must be false when status is never_run',
      });
    }
  });

export const ControllerStatusEnvelopeSchema = z
  .object({
    data: ControllerStatusDataSchema,
    meta: z
      .object({
        apiVersion: z.literal('1'),
        workspaceId: UUIDSchema,
      })
      .strict(),
  })
  .strict();

export type ControllerStatusData = z.infer<typeof ControllerStatusDataSchema>;
export type ControllerStatusEnvelope = z.infer<
  typeof ControllerStatusEnvelopeSchema
>;

export type ControllerStatusValidationIssue = {
  path: string;
  message: string;
};

export type ControllerStatusValidationResult =
  | { ok: true; envelope: ControllerStatusEnvelope }
  | {
      ok: false;
      reason: 'malformed_envelope' | 'request_mismatch';
      issues: ControllerStatusValidationIssue[];
    };

export function validateControllerStatusEnvelope(
  value: unknown,
  expected: {
    workspaceId: string;
    domain: ControllerDomain;
    protocolVersion?: typeof CONTROLLER_PROTOCOL_VERSION;
  }
): ControllerStatusValidationResult {
  const parsed = ControllerStatusEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'malformed_envelope',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const protocolVersion =
    expected.protocolVersion ?? CONTROLLER_PROTOCOL_VERSION;
  const issues: ControllerStatusValidationIssue[] = [];
  if (parsed.data.meta.workspaceId !== expected.workspaceId) {
    issues.push({
      path: 'meta.workspaceId',
      message: 'Response workspace does not match the requested workspace',
    });
  }
  if (parsed.data.data.domain !== expected.domain) {
    issues.push({
      path: 'data.domain',
      message: 'Response domain does not match the requested domain',
    });
  }
  if (parsed.data.data.controller_id !== `domain.${expected.domain}`) {
    issues.push({
      path: 'data.controller_id',
      message: 'Response controller does not match the requested domain',
    });
  }
  if (parsed.data.data.protocol_version !== protocolVersion) {
    issues.push({
      path: 'data.protocol_version',
      message: 'Response protocol does not match the requested protocol',
    });
  }

  const proposal = parsed.data.data.proposal;
  if (proposal && proposal.controllerId !== parsed.data.data.controller_id) {
    issues.push({
      path: 'data.proposal.controllerId',
      message: 'Proposal controller does not match the status controller',
    });
  }
  if (proposal && proposal.domain !== parsed.data.data.domain) {
    issues.push({
      path: 'data.proposal.domain',
      message: 'Proposal domain does not match the status domain',
    });
  }
  if (proposal && proposal.specRevision !== parsed.data.data.spec_revision) {
    issues.push({
      path: 'data.proposal.specRevision',
      message: 'Proposal spec revision does not match the status revision',
    });
  }

  if (issues.length > 0) {
    return { ok: false, reason: 'request_mismatch', issues };
  }
  return { ok: true, envelope: parsed.data };
}
