type EntityRow = Record<string, unknown>;

export interface ContextPackSummaryOptions {
  maxItems: number;
  maxFieldLength: number;
}

const CONTEXT_CAPSULE_SCHEMA_VERSION = 'orgx.context-capsule/v1';

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function firstRecord(value: unknown): EntityRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as EntityRow;
}

function recordArray(value: unknown): EntityRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is EntityRow => Boolean(firstRecord(item)));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter(Boolean);
}

function truncateText(text: string | null | undefined, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function joinLimited(values: string[], maxItems: number): string {
  const shown = values.slice(0, maxItems);
  const remaining = values.length - shown.length;
  return `${shown.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''}`;
}

function formatCents(cents: unknown): string {
  return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '';
}

function contextPackAsOf(iso: unknown): string {
  const match = /T(\d{2}):(\d{2})/.exec(str(iso));
  return match ? `${match[1]}:${match[2]}` : '';
}

function formatCapsuleStateItems(
  lines: string[],
  heading: string,
  values: unknown,
  opts: ContextPackSummaryOptions
): void {
  const items = recordArray(values);
  if (items.length === 0) return;
  lines.push(`${heading}:`);
  for (const item of items.slice(0, Math.min(3, opts.maxItems))) {
    const summary = str(item.summary);
    const status = str(item.status);
    const ref = firstRecord(item.ref);
    const fallback = [str(ref?.type), str(ref?.id)].filter(Boolean).join(':');
    const value = summary || fallback;
    if (!value) continue;
    lines.push(
      `- ${truncateText(
        `${status ? `[${status}] ` : ''}${value}`,
        opts.maxFieldLength
      )}`
    );
  }
}

/** Mirror the exact v1 capsule into bootstrap text for hookless clients. */
export function formatContextCapsuleSummary(
  contextCapsule: unknown,
  opts: ContextPackSummaryOptions
): string {
  const capsule = firstRecord(contextCapsule);
  if (capsule?.schema_version !== CONTEXT_CAPSULE_SCHEMA_VERSION) return '';

  const id = str(capsule.capsule_id);
  const sequence = str(capsule.as_of_global_sequence);
  const digest = str(capsule.content_digest);
  const lines = [
    `Context capsule${id ? ` ${id}` : ''}${
      sequence ? ` (as of sequence ${sequence})` : ''
    }:`,
  ];

  lines.push(capsule.projection_consistency === 'database_snapshot'
    ? 'Capsule sources: one database snapshot. Additional entity-frame reads may be best-effort. Recheck permissions and required revisions before acting.'
    : 'Consistency: best-effort reads. Recheck permissions and required revisions before acting.');
  const completeness = firstRecord(capsule.source_completeness);
  if (!completeness || Object.values(completeness).some((value) => firstRecord(value)?.status !== 'complete')) {
    lines.push('Source coverage is incomplete or unknown. Expand the relevant evidence before relying on it.');
  }

  const intent = firstRecord(capsule.current_intent);
  const intentSummary = str(intent?.summary);
  if (intentSummary) {
    lines.push(`Current intent: ${truncateText(intentSummary, opts.maxFieldLength)}`);
  }
  formatCapsuleStateItems(
    lines,
    'Active constraints',
    capsule.active_constraints,
    opts
  );
  formatCapsuleStateItems(
    lines,
    'Accepted decisions',
    capsule.authoritative_decisions,
    opts
  );

  const appliedLearnings = recordArray(capsule.applied_learnings);
  if (appliedLearnings.length === 0) {
    lines.push('Applied learnings: none returned in this bounded projection.');
  } else {
    formatCapsuleStateItems(
      lines,
      'Accepted applied learnings',
      appliedLearnings,
      opts
    );
  }
  formatCapsuleStateItems(
    lines,
    'Pending expectations',
    capsule.pending_expectations,
    opts
  );
  formatCapsuleStateItems(lines, 'Open risks', capsule.open_risks, opts);

  const receiptRefs = recordArray(capsule.recent_receipt_refs);
  if (receiptRefs.length > 0) {
    const ids = receiptRefs.map((ref) => str(ref.id)).filter(Boolean);
    if (ids.length > 0) {
      lines.push(`Recent receipt refs: ${joinLimited(ids, opts.maxItems)}`);
    }
  }

  const omittedCounts = firstRecord(capsule.omitted_counts);
  if (omittedCounts) {
    const omitted = Object.entries(omittedCounts)
      .filter(([, value]) => typeof value === 'number' && value > 0)
      .map(([key, value]) => `${key} ${value}`);
    if (omitted.length > 0) lines.push(`Omitted by budget: ${omitted.join(', ')}.`);
  }
  if (digest) lines.push(`Digest: ${digest}`);

  return lines.join('\n');
}

export function formatContextPackSummary(
  contextPack: unknown,
  opts: ContextPackSummaryOptions
): string {
  const pack = firstRecord(contextPack);
  if (!pack) return '';

  const frame = firstRecord(pack.frame);
  const lines: string[] = ['Context pack:'];
  if (frame) {
    const anchor = firstRecord(frame.anchor);
    const title = str(anchor?.title);
    const anchorType = str(anchor?.type);
    const asOf = contextPackAsOf(pack.compiledAt);
    const flags = [
      asOf ? `as of ${asOf}` : '',
      frame.degraded === true ? 'partial context' : '',
    ].filter(Boolean);
    if (title || anchorType || flags.length > 0) {
      lines.push(
        `Working from: ${title || anchorType || 'current entity'}${
          flags.length > 0 ? ` (${flags.join(', ')})` : ''
        }`
      );
    }

    const definitionOfDone = firstRecord(frame.definitionOfDone);
    const expectedArtifacts = recordArray(definitionOfDone?.expectedArtifacts);
    if (expectedArtifacts.length > 0) {
      const artifactTypes = expectedArtifacts
        .map((artifact) => str(artifact.type) || str(artifact.title))
        .filter(Boolean);
      lines.push(
        `Definition of done: ${expectedArtifacts.length} artifact(s)${
          artifactTypes.length > 0
            ? ` - ${joinLimited(artifactTypes, 4)}`
            : ''
        }`
      );
    }

    const checks = stringArray(definitionOfDone?.checks);
    if (checks.length > 0) {
      lines.push(`Checks: ${joinLimited(checks, 4)}`);
    }

    const earnedBoundary = firstRecord(frame.earnedBoundary);
    const boundary = str(earnedBoundary?.sentence);
    if (boundary) {
      lines.push(`Boundary: ${truncateText(boundary, opts.maxFieldLength)}`);
    }

    const coverage = firstRecord(frame.coverage);
    const coverageBand = str(coverage?.band);
    if (coverageBand) {
      const ratio =
        typeof coverage?.ratio === 'number'
          ? ` ${coverage.ratio.toFixed(2)}`
          : '';
      lines.push(`Confidence: ${coverageBand}${ratio}`);
    }

    const budget = firstRecord(frame.budget);
    const cap = formatCents(budget?.capCents);
    if (cap) {
      const remaining = formatCents(budget?.remainingCents);
      lines.push(`Budget: ${remaining || 'unknown'} of ${cap} left`);
    }

    const artifacts = firstRecord(frame.artifacts);
    const producedArtifacts = recordArray(artifacts?.produced);
    if (producedArtifacts.length > 0) {
      const producedTypes = producedArtifacts
        .map((artifact) => str(artifact.type))
        .filter(Boolean);
      lines.push(
        `Produced artifacts: ${producedArtifacts.length}${
          producedTypes.length > 0 ? ` - ${joinLimited(producedTypes, 4)}` : ''
        }`
      );
    }

    const blockers = recordArray(frame.blockers);
    if (blockers.length > 0) {
      lines.push('Open blockers:');
      for (const blocker of blockers.slice(0, Math.min(3, opts.maxItems))) {
        const title = str(blocker.title) || 'Untitled blocker';
        const description = str(blocker.description);
        lines.push(
          `- ${truncateText(
            description ? `${title}: ${description}` : title,
            opts.maxFieldLength
          )}`
        );
      }
    }

    const decisions = recordArray(frame.decisions);
    if (decisions.length > 0) {
      lines.push('Decisions already made:');
      for (const decision of decisions.slice(0, Math.min(3, opts.maxItems))) {
        const choice = str(decision.choice) || 'Decision';
        const disposition = str(decision.disposition);
        const labelledChoice = disposition
          ? `[${disposition}] ${choice}`
          : choice;
        const rationale = str(decision.rationale);
        lines.push(
          `- ${truncateText(
            rationale
              ? `${labelledChoice} - because ${rationale}`
              : labelledChoice,
            opts.maxFieldLength
          )}`
        );
      }
    }

    const expectations = recordArray(frame.expectations).filter(
      (expectation) =>
        expectation.metricRegistryId === 'orgx.run_receipt_coverage.v1' &&
        (expectation.state === 'pending' ||
          expectation.state === 'met' ||
          expectation.state === 'not_met' ||
          expectation.state === 'inconclusive')
    );
    if (expectations.length > 0) {
      lines.push('Metric expectations (observations do not prove causation):');
      for (const expectation of expectations.slice(
        0,
        Math.min(3, opts.maxItems)
      )) {
        const metric = str(expectation.metricRegistryId);
        const state = str(expectation.state);
        const predicate = firstRecord(expectation.predicate);
        const operator = str(predicate?.operator);
        const threshold = str(predicate?.threshold);
        const predicateText = [operator, threshold].filter(Boolean).join(' ');
        const minimumSampleSize = str(expectation.minimumSampleSize);
        if (state === 'pending') {
          const detail = [
            predicateText,
            minimumSampleSize ? `minimum sample ${minimumSampleSize}` : '',
          ]
            .filter(Boolean)
            .join('; ');
          lines.push(
            `- ${truncateText(
              `[pending] ${metric}${detail ? ` - ${detail}` : ''}`,
              opts.maxFieldLength
            )}`
          );
          continue;
        }

        const observation = firstRecord(expectation.observation);
        const numerator = str(observation?.numerator);
        const denominator = str(observation?.denominator);
        const value = str(observation?.value);
        const observed =
          numerator && denominator
            ? `observed ${numerator}/${denominator}${value ? ` (${value})` : ''}`
            : 'resolved; observation details unavailable';
        const detail = `${observed}${
          predicateText ? `; predicate ${predicateText}` : ''
        }`;
        lines.push(
          `- ${truncateText(
            `[${state}] ${metric} - ${detail}`,
            opts.maxFieldLength
          )}`
        );
      }
    }

    const chronology = firstRecord(frame.chronology);
    const recent = [
      str(chronology?.lastRun),
      str(chronology?.yesterday),
      str(chronology?.lastWeek),
    ].find(Boolean);
    if (recent) {
      lines.push(`Recent context: ${truncateText(recent, opts.maxFieldLength)}`);
    }
    const openLoops = stringArray(chronology?.openLoops);
    if (openLoops.length > 0) {
      lines.push(`Open loops: ${joinLimited(openLoops, 3)}`);
    }
  }

  const recommendedNextActions = recordArray(pack.recommendedNextActions);
  if (recommendedNextActions.length > 0) {
    lines.push('Recommended next:');
    for (const action of recommendedNextActions.slice(0, Math.min(3, opts.maxItems))) {
      const text = str(action.action);
      const confidence = str(action.confidence);
      if (text) {
        lines.push(
          `- ${truncateText(text, opts.maxFieldLength)}${
            confidence ? ` (${confidence})` : ''
          }`
        );
      }
    }
  }

  const missingPermissions = stringArray(pack.missingPermissions);
  if (missingPermissions.length > 0) {
    lines.push(`Missing permissions: ${joinLimited(missingPermissions, 4)}`);
  }

  const tools = stringArray(pack.tools);
  if (tools.length > 0) {
    lines.push(`Available tools: ${tools.length} (${joinLimited(tools, 5)})`);
  }

  return lines.length > 1 ? lines.join('\n') : '';
}
