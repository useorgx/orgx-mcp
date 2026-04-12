type JsonRecord = Record<string, unknown>;

export type OrgxFreeAuditPeriod = '7d' | '30d' | '90d';

export type OrgxFreeAuditScoreKey =
  | 'proof_score'
  | 'context_debt_score'
  | 'autonomy_maturity_score'
  | 'roi_visibility_score';

export type OrgxFreeAuditScore = {
  score: number;
  band: 'excellent' | 'strong' | 'developing' | 'weak';
  interpretation: string;
  inputs: string[];
};

export type OrgxFreeAuditResult = {
  tool: 'orgx_free_audit';
  workspace_id: string;
  agent_type: string;
  period: OrgxFreeAuditPeriod;
  generated_at: string;
  overall_score: number;
  overall_band: OrgxFreeAuditScore['band'];
  scores: Record<OrgxFreeAuditScoreKey, OrgxFreeAuditScore>;
  signal_status: {
    trust_context: {
      available: boolean;
      capability_count: number;
    };
    outcome_attribution: {
      available: boolean;
      entries_count: number | null;
      total_value: number | null;
      total_cost: number | null;
    };
    workspace_pulse: {
      available: boolean;
      total_workstreams: number | null;
      blocked_count: number | null;
    };
  };
  findings: string[];
  recommendations: string[];
  share_summary: string;
  raw_signals?: {
    trust_context: JsonRecord | null;
    outcome_attribution: JsonRecord | null;
    workspace_pulse: JsonRecord | null;
  };
};

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function asRecordOrNull(value: unknown): JsonRecord | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readFirstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeScore(value: number | null): number | null {
  if (value === null) return null;
  if (value <= 1) return clampScore(value * 100);
  if (value <= 5) return clampScore(value * 20);
  return clampScore(value);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function bandFor(score: number): OrgxFreeAuditScore['band'] {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'strong';
  if (score >= 45) return 'developing';
  return 'weak';
}

function findFirstArrayByKey(
  value: unknown,
  key: string,
  depth = 0
): JsonRecord[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstArrayByKey(item, key, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }

  const record = asRecord(value);
  const candidate = record[key];
  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => asRecordOrNull(item))
      .filter((item): item is JsonRecord => item !== null);
  }

  for (const child of Object.values(record)) {
    const found = findFirstArrayByKey(child, key, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function findFirstRecordByKey(
  value: unknown,
  key: string,
  depth = 0
): JsonRecord {
  if (depth > 5) return {};
  const record = asRecord(value);
  const candidate = asRecordOrNull(record[key]);
  if (candidate) return candidate;

  for (const child of Object.values(record)) {
    const found = findFirstRecordByKey(child, key, depth + 1);
    if (Object.keys(found).length > 0) return found;
  }
  return {};
}

function extractCapabilities(trustContext: JsonRecord | null): JsonRecord[] {
  if (!trustContext) return [];
  return findFirstArrayByKey(trustContext, 'capabilities');
}

function trustLevelScore(level: unknown): number | null {
  if (typeof level !== 'string') return null;
  const normalized = level.toLowerCase();
  if (normalized === 'autonomous') return 95;
  if (normalized === 'act_with_approval') return 70;
  if (normalized === 'draft') return 45;
  if (normalized === 'read_only') return 25;
  return null;
}

function scoreProof(capabilities: JsonRecord[]): OrgxFreeAuditScore {
  const scores = capabilities.map((capability) =>
    normalizeScore(readFirstNumber(capability, ['trust_score', 'proof_score', 'score']))
  );
  const receiptCoverage = capabilities.map((capability) => {
    const receipts = readFirstNumber(capability, [
      'total_receipts',
      'receipt_count',
      'receipts_count',
    ]);
    const needed = readFirstNumber(capability, [
      'receipts_needed_for_promotion',
      'receipts_needed',
      'needed_receipts',
    ]);
    if (receipts === null) return null;
    if (needed === null || needed <= 0) return clampScore((receipts / 3) * 100);
    return clampScore((receipts / (receipts + needed)) * 100);
  });
  const qualityScores = capabilities.map((capability) =>
    normalizeScore(
      readFirstNumber(capability, [
        'avg_quality_score',
        'average_quality_score',
        'quality_score',
      ])
    )
  );

  const score = clampScore(
    average([average(scores), average(receiptCoverage), average(qualityScores)]) ??
      (capabilities.length > 0 ? 40 : 20)
  );

  return {
    score,
    band: bandFor(score),
    interpretation:
      'Higher means stronger proof receipts, trust scores, and quality evidence.',
    inputs: [
      `${capabilities.length} capability record${capabilities.length === 1 ? '' : 's'}`,
      'trust scores',
      'receipt coverage',
      'quality scores',
    ],
  };
}

function scoreAutonomy(
  trustContext: JsonRecord | null,
  capabilities: JsonRecord[]
): OrgxFreeAuditScore {
  const levelScores = capabilities.map((capability) =>
    trustLevelScore(capability.trust_level)
  );
  const topLevel = asRecord(trustContext);
  const autonomousCount = readFirstNumber(topLevel, ['autonomous_count']);
  const totalCapabilities =
    readFirstNumber(topLevel, ['total_capabilities']) ?? capabilities.length;
  const autonomousRatio =
    autonomousCount !== null && totalCapabilities > 0
      ? clampScore((autonomousCount / totalCapabilities) * 100)
      : null;
  const trustScores = capabilities.map((capability) =>
    normalizeScore(readFirstNumber(capability, ['trust_score', 'score']))
  );

  const score = clampScore(
    average([average(levelScores), autonomousRatio, average(trustScores)]) ??
      (capabilities.length > 0 ? 35 : 20)
  );

  return {
    score,
    band: bandFor(score),
    interpretation:
      'Higher means more capabilities can safely act with approval or autonomously.',
    inputs: [
      `${capabilities.length} capability record${capabilities.length === 1 ? '' : 's'}`,
      autonomousCount !== null
        ? `${autonomousCount} autonomous capabilit${autonomousCount === 1 ? 'y' : 'ies'}`
        : 'autonomous capability count unavailable',
      'trust levels',
    ],
  };
}

function scoreContextDebt(workspacePulse: JsonRecord | null): OrgxFreeAuditScore {
  const stats = findFirstRecordByKey(workspacePulse, 'stats');
  const totalWorkstreams = readFirstNumber(stats, [
    'totalWorkstreams',
    'total_workstreams',
    'workstream_count',
  ]);
  const blockedCount = readFirstNumber(stats, [
    'blockedWorkstreams',
    'blocked_workstreams',
    'blocked_count',
    'blocked',
  ]);
  const activeCount = readFirstNumber(stats, [
    'activeWorkstreams',
    'active_workstreams',
    'active_count',
  ]);
  const completedThisWeek = readFirstNumber(stats, [
    'completedThisWeek',
    'completed_this_week',
  ]);

  const hasPulse = workspacePulse !== null;
  let score = hasPulse ? 80 : 45;
  if (totalWorkstreams !== null && totalWorkstreams > 0 && blockedCount !== null) {
    score -= Math.min(45, (blockedCount / totalWorkstreams) * 100);
  }
  if (activeCount !== null && totalWorkstreams !== null && totalWorkstreams > 0) {
    score += Math.min(10, (activeCount / totalWorkstreams) * 10);
  }
  if (completedThisWeek !== null && completedThisWeek > 0) {
    score += Math.min(10, completedThisWeek * 2);
  }

  const clampedScore = clampScore(score);
  return {
    score: clampedScore,
    band: bandFor(clampedScore),
    interpretation:
      'Higher means lower context debt and fewer blocked execution surfaces.',
    inputs: [
      hasPulse ? 'workspace pulse available' : 'workspace pulse unavailable',
      blockedCount !== null
        ? `${blockedCount} blocked item${blockedCount === 1 ? '' : 's'}`
        : 'blocked count unavailable',
      totalWorkstreams !== null
        ? `${totalWorkstreams} total workstream${totalWorkstreams === 1 ? '' : 's'}`
        : 'total workstreams unavailable',
    ],
  };
}

function scoreRoiVisibility(
  outcomeAttribution: JsonRecord | null
): OrgxFreeAuditScore {
  const summary = findFirstRecordByKey(outcomeAttribution, 'summary');
  const byAgent = findFirstArrayByKey(outcomeAttribution, 'by_agent');
  const topReceipts = findFirstArrayByKey(outcomeAttribution, 'top_receipts');
  const entriesCount =
    readFirstNumber(summary, ['entries_count', 'entry_count']) ??
    readFirstNumber(asRecord(outcomeAttribution), ['entries_count']);
  const totalValue = readFirstNumber(summary, ['total_value', 'total_value_usd']);
  const totalCost = readFirstNumber(summary, ['total_cost', 'total_cost_usd']);
  const roi = readFirstNumber(summary, ['roi']);

  let score = outcomeAttribution ? 35 : 10;
  if (entriesCount !== null && entriesCount > 0) score += 20;
  if (totalValue !== null && totalValue > 0) score += 15;
  if (totalCost !== null) score += 10;
  if (roi !== null) score += 10;
  if (byAgent.length > 0) score += 5;
  if (topReceipts.length > 0) score += 5;

  const clampedScore = clampScore(score);
  return {
    score: clampedScore,
    band: bandFor(clampedScore),
    interpretation:
      'Higher means outcomes, costs, ROI, and receipt attribution are visible.',
    inputs: [
      outcomeAttribution ? 'outcome attribution available' : 'outcome attribution unavailable',
      entriesCount !== null
        ? `${entriesCount} attribution entr${entriesCount === 1 ? 'y' : 'ies'}`
        : 'entry count unavailable',
      totalValue !== null ? `$${totalValue.toFixed(2)} total value` : 'total value unavailable',
    ],
  };
}

function buildFindings(
  scores: Record<OrgxFreeAuditScoreKey, OrgxFreeAuditScore>
): string[] {
  return [
    `Proof evidence is ${scores.proof_score.band} at ${scores.proof_score.score}/100.`,
    `Context debt health is ${scores.context_debt_score.band} at ${scores.context_debt_score.score}/100.`,
    `Autonomy maturity is ${scores.autonomy_maturity_score.band} at ${scores.autonomy_maturity_score.score}/100.`,
    `ROI visibility is ${scores.roi_visibility_score.band} at ${scores.roi_visibility_score.score}/100.`,
  ];
}

function buildRecommendations(
  scores: Record<OrgxFreeAuditScoreKey, OrgxFreeAuditScore>
): string[] {
  const recommendations: string[] = [];
  if (scores.proof_score.score < 70) {
    recommendations.push(
      'Attach receipt evidence and quality scores to the next completed agent tasks before promoting trust.'
    );
  }
  if (scores.context_debt_score.score < 70) {
    recommendations.push(
      'Reduce context debt by resolving blocked workstreams and preserving the current plan, decisions, and artifacts in OrgX.'
    );
  }
  if (scores.autonomy_maturity_score.score < 70) {
    recommendations.push(
      'Promote one bounded capability from read-only or draft into act-with-approval before expanding autonomous scope.'
    );
  }
  if (scores.roi_visibility_score.score < 70) {
    recommendations.push(
      'Record outcomes and attribution receipts so ROI can be shown without manual reconstruction.'
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Use this benchmark as a shareable audit artifact and route the next bottleneck into an autonomous session with a capped budget.'
    );
  }
  return recommendations;
}

export function buildOrgxFreeAudit(params: {
  workspaceId: string;
  agentType: string;
  period: OrgxFreeAuditPeriod;
  generatedAt: string;
  trustContext?: JsonRecord | null;
  outcomeAttribution?: JsonRecord | null;
  workspacePulse?: JsonRecord | null;
  includeRawSignals?: boolean;
}): OrgxFreeAuditResult {
  const trustContext = params.trustContext ?? null;
  const outcomeAttribution = params.outcomeAttribution ?? null;
  const workspacePulse = params.workspacePulse ?? null;
  const capabilities = extractCapabilities(trustContext);
  const scores: Record<OrgxFreeAuditScoreKey, OrgxFreeAuditScore> = {
    proof_score: scoreProof(capabilities),
    context_debt_score: scoreContextDebt(workspacePulse),
    autonomy_maturity_score: scoreAutonomy(trustContext, capabilities),
    roi_visibility_score: scoreRoiVisibility(outcomeAttribution),
  };
  const overallScore = clampScore(
    average(Object.values(scores).map((score) => score.score)) ?? 0
  );
  const attributionSummary = findFirstRecordByKey(outcomeAttribution, 'summary');
  const pulseStats = findFirstRecordByKey(workspacePulse, 'stats');
  const totalWorkstreams = readFirstNumber(pulseStats, [
    'totalWorkstreams',
    'total_workstreams',
    'workstream_count',
  ]);
  const blockedCount = readFirstNumber(pulseStats, [
    'blockedWorkstreams',
    'blocked_workstreams',
    'blocked_count',
    'blocked',
  ]);

  const result: OrgxFreeAuditResult = {
    tool: 'orgx_free_audit',
    workspace_id: params.workspaceId,
    agent_type: params.agentType,
    period: params.period,
    generated_at: params.generatedAt,
    overall_score: overallScore,
    overall_band: bandFor(overallScore),
    scores,
    signal_status: {
      trust_context: {
        available: trustContext !== null,
        capability_count: capabilities.length,
      },
      outcome_attribution: {
        available: outcomeAttribution !== null,
        entries_count:
          readFirstNumber(attributionSummary, ['entries_count', 'entry_count']) ??
          readFirstNumber(asRecord(outcomeAttribution), ['entries_count']),
        total_value: readFirstNumber(attributionSummary, [
          'total_value',
          'total_value_usd',
        ]),
        total_cost: readFirstNumber(attributionSummary, [
          'total_cost',
          'total_cost_usd',
        ]),
      },
      workspace_pulse: {
        available: workspacePulse !== null,
        total_workstreams: totalWorkstreams,
        blocked_count: blockedCount,
      },
    },
    findings: buildFindings(scores),
    recommendations: buildRecommendations(scores),
    share_summary:
      `OrgX Free Audit: ${overallScore}/100 overall for ${params.agentType}. ` +
      `Proof ${scores.proof_score.score}, Context Debt ${scores.context_debt_score.score}, ` +
      `Autonomy ${scores.autonomy_maturity_score.score}, ROI Visibility ${scores.roi_visibility_score.score}.`,
  };

  if (params.includeRawSignals) {
    result.raw_signals = {
      trust_context: trustContext,
      outcome_attribution: outcomeAttribution,
      workspace_pulse: workspacePulse,
    };
  }

  return result;
}

export function formatOrgxFreeAuditSummary(result: OrgxFreeAuditResult): string {
  return [
    `OrgX free audit for ${result.agent_type} (${result.period}):`,
    `- Overall: ${result.overall_score}/100 (${result.overall_band})`,
    `- Proof Score: ${result.scores.proof_score.score}/100`,
    `- Context Debt Score: ${result.scores.context_debt_score.score}/100 (higher means lower debt)`,
    `- Autonomy Maturity Score: ${result.scores.autonomy_maturity_score.score}/100`,
    `- ROI Visibility Score: ${result.scores.roi_visibility_score.score}/100`,
    '',
    'Recommendations:',
    ...result.recommendations.map((recommendation) => `- ${recommendation}`),
  ].join('\n');
}
