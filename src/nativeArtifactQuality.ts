import { z } from "zod";

const ratio = z.number().finite().min(0).max(1);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().nullable();
const number = z.number().finite().nullable();
const checkStatus = z.enum([
  "passed",
  "failed",
  "pending",
  "running",
  "error",
  "skipped",
  "missing",
]);
export const artifactCurrentChecksSchema = z
  .object({
    state: z.union([checkStatus, z.enum(["none", "unavailable"])]),
    total: z.number().int().nonnegative().nullable(),
    passed: z.number().int().nonnegative().nullable(),
    reason: text,
    checks: z.array(
      z
        .object({
          profileId: text,
          profileName: z.string(),
          profileVersion: number,
          status: checkStatus,
          score: number,
          threshold: number,
          runId: text,
          reason: text.optional(),
        })
        .strict()
    ),
  })
  .strict();

/** Exact app-owned projection. This is not an artifact-metadata input schema. */
export const nativeArtifactQualitySchema = z
  .object({
    source: z.literal("native_four_lens"),
    verificationId: z.string().uuid(),
    subjectDigest: digest,
    report: z
      .object({
        id: z.string().uuid(),
        uri: z.string().trim().min(1),
        digest,
        mediaType: z.string().trim().min(1).optional(),
        schemaVersion: z
          .string()
          .regex(/^1\.\d+\.\d+$/)
          .optional(),
      })
      .strict(),
  })
  .strict();

export const artifactEvaluationAnatomySchema = z
  .object({
    schemaVersion: z.literal("artifact_evaluation_anatomy.v1"),
    source: z.enum(["recorded_snapshot", "legacy_report", "native_four_lens"]),
    runId: text,
    artifactVersion: z.number().int().nonnegative().nullable(),
    profile: z
      .object({
        id: text,
        name: text,
        version: number,
        scope: text,
        policyDigest: text.optional(),
      })
      .strict(),
    threshold: ratio,
    runner: z.object({ key: text, label: z.string(), model: text }).strict(),
    inputSummary: z
      .object({
        artifactType: text,
        modality: text,
        referenceCount: number,
        contentDigest: text,
      })
      .strict(),
    criteria: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          score: ratio.nullable(),
          passed: z.boolean().nullable(),
          weight: number,
        })
        .strict()
    ),
    aggregation: z
      .object({
        method: z.enum(["mean", "weighted_mean", "holistic", "unknown"]),
        count: z.number().int().nonnegative(),
      })
      .strict(),
    decision: z
      .object({ score: ratio.nullable(), status: z.string() })
      .strict(),
    completedAt: text,
  })
  .strict();

export const artifactQualityPresentationSchema = z
  .object({
    state: z.string().optional(),
    score: number.optional(),
    summary: z.string().optional(),
    required: z.boolean().optional(),
    scoreBasis: z.literal("judged_lower_bound").optional(),
    previousScore: number.optional(),
    threshold: ratio.optional(),
    thresholdSource: z
      .object({
        kind: z.enum([
          "eval_run_report",
          "eval_profile",
          "embedded_eval",
          "contract_default",
          "system_default",
          "default",
          "native_quality_bar",
        ]),
        profileName: text.optional(),
        profileScope: text.optional(),
        profileVersion: number.optional(),
      })
      .strict()
      .optional(),
    isFresh: z.boolean().optional(),
    blocksAdvance: z.boolean().optional(),
    reason: z.string().optional(),
    runId: text.optional(),
    anatomy: artifactEvaluationAnatomySchema.nullable().optional(),
    findings: z
      .array(
        z
          .object({
            label: z.string(),
            tone: z.enum(["danger", "good", "muted"]),
            score: ratio.nullable().optional(),
          })
          .strict()
      )
      .optional(),
    native: nativeArtifactQualitySchema.optional(),
  })
  .superRefine((quality, context) => {
    const claimsNative =
      quality.native ||
      quality.scoreBasis ||
      quality.anatomy?.source === "native_four_lens" ||
      quality.thresholdSource?.kind === "native_quality_bar";
    if (!claimsNative) return;
    const coherent =
      quality.native &&
      quality.scoreBasis === "judged_lower_bound" &&
      quality.required === true &&
      quality.isFresh === true &&
      quality.runId === null &&
      quality.previousScore === null &&
      (quality.state === "cleared" || quality.state === "failed") &&
      quality.blocksAdvance === (quality.state === "failed") &&
      typeof quality.score === "number" &&
      quality.score >= 0 &&
      quality.score <= 1 &&
      typeof quality.threshold === "number" &&
      quality.thresholdSource?.kind === "native_quality_bar" &&
      quality.thresholdSource.profileScope === "workspace" &&
      typeof quality.thresholdSource.profileName === "string" &&
      typeof quality.thresholdSource.profileVersion === "number" &&
      Number.isInteger(quality.thresholdSource.profileVersion) &&
      quality.thresholdSource.profileVersion > 0 &&
      quality.anatomy?.source === "native_four_lens" &&
      quality.anatomy.runId === null &&
      quality.anatomy.profile.id === null &&
      quality.anatomy.profile.name === quality.thresholdSource.profileName &&
      quality.anatomy.profile.version ===
        quality.thresholdSource.profileVersion &&
      quality.anatomy.profile.scope === "workspace" &&
      digest.safeParse(quality.anatomy.profile.policyDigest).success &&
      quality.anatomy.threshold === quality.threshold &&
      quality.anatomy.decision.score === quality.score &&
      quality.anatomy.inputSummary.contentDigest ===
        quality.native.subjectDigest &&
      quality.native.report.uri ===
        `orgx://agent-run-artifacts/${quality.native.report.id}`;
    if (!coherent)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Native quality must retain its exact canonical verification, score basis and subject binding.",
      });
  });

/** Only an admitted canonical detail response can supply native quality. */
export function canonicalNativeArtifactQuality(envelope: {
  artifact: Record<string, unknown>;
  reviewContract: Record<string, unknown> | null;
  reviewContractSource: string;
}) {
  if (
    envelope.reviewContractSource !== "canonical" ||
    envelope.reviewContract?.schemaVersion !== "artifact_review_contract.v1"
  )
    return null;
  const result = artifactQualityPresentationSchema.safeParse(
    envelope.reviewContract?.quality
  );
  if (
    !result.success ||
    !result.data.native ||
    result.data.anatomy?.artifactVersion !== envelope.artifact.version
  )
    return null;
  const checks = artifactCurrentChecksSchema.safeParse(
    envelope.reviewContract?.checks
  );
  if (
    !checks.success ||
    checks.data.total !== checks.data.checks.length ||
    checks.data.passed !==
      checks.data.checks.filter((check) => check.status === "passed").length ||
    checks.data.state !==
      (result.data.state === "cleared" ? "passed" : "failed") ||
    checks.data.checks.some(
      (check) => check.runId !== null || check.profileId !== null
    )
  )
    return null;
  return result.data;
}
