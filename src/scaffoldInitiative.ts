import type { BatchCreateSummary } from './batchCreate';
import { normalizeSuggestedChecks } from './expectations';
import { buildLegacyScaffoldInitiativeBatch } from './generated/legacyScaffoldPlan';
import { toFiniteNumber, humanEquivalentRateUsd, ECONOMICS_VALUE_BASIS, HUMAN_EQUIVALENT_RATE_BY_TASK_TYPE_USD } from './generated/legacyScaffoldPlanPreparation';
export type { ScaffoldBatchBuildResult } from './generated/legacyScaffoldPlanPreparation';

export function buildScaffoldInitiativeBatch(args: Record<string, unknown>) {
  return buildLegacyScaffoldInitiativeBatch(args, normalizeSuggestedChecks);
}

export function buildScaffoldHierarchy(params: {
  result: BatchCreateSummary;
  batch?: Array<Record<string, unknown>>;
  initiativeRef: string;
  wsRefs: string[];
  msRefs: string[][];
  taskRefs: string[][][];
}) {
  const { result, batch, initiativeRef, wsRefs, msRefs, taskRefs } = params;

  const byRef = new Map<
    string,
    { success: boolean; data?: Record<string, unknown> | null; error?: string }
  >();
  for (const item of result.results) {
    if (item.ref) {
      byRef.set(item.ref, {
        success: item.success,
        data: { ...(item.data ?? {}), ...(item.id ? { id: item.id } : {}) },
        error: item.error,
      });
    }
  }
  const inputByRef = new Map<string, Record<string, unknown>>();
  for (const item of batch ?? []) {
    const ref = typeof item.ref === 'string' ? item.ref : null;
    if (ref) {
      inputByRef.set(ref, item);
    }
  }

  const normalizeHierarchyNode = (node: Record<string, unknown>) => {
    const next = { ...node };
    const title =
      typeof next.title === 'string' && next.title.trim().length > 0
        ? next.title.trim()
        : null;
    const name =
      typeof next.name === 'string' && next.name.trim().length > 0
        ? next.name.trim()
        : null;

    if (!title && name) {
      next.title = name;
    }
    if (!name && title) {
      next.name = title;
    }

    return next;
  };

  const nodeForRef = (ref: string) => {
    const info = byRef.get(ref);
    return normalizeHierarchyNode({
      ...(inputByRef.get(ref) ?? {}),
      ref,
      success: info?.success ?? false,
      ...(info?.data ?? {}),
      ...(info?.success === false ? { error: info?.error } : {}),
    });
  };

  const firstNumber = (
    node: Record<string, unknown>,
    keys: string[]
  ): number | null => {
    for (const key of keys) {
      const value = toFiniteNumber(node[key]);
      if (value !== null && value >= 0) return value;
    }
    return null;
  };

  const sumNumbers = (values: Array<number | null | undefined>) => {
    let total = 0;
    let found = false;
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
    return found ? total : null;
  };

  const round = (value: number, precision = 2) =>
    Number(value.toFixed(precision));

  const estimateEconomics = (
    node: Record<string, unknown>,
    children: Array<Record<string, unknown>>
  ) => {
    const childHours = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_hours))
    );
    const childSpend = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_spend_usd))
    );
    const childRoi = sumNumbers(
      children.map((child) => toFiniteNumber(child.estimated_roi_usd))
    );
    const childHumanEquivalentValue = sumNumbers(
      children.map((child) => toFiniteNumber(child.human_equivalent_value_usd))
    );

    const hours =
      firstNumber(node, [
        'estimated_hours',
        'estimatedHours',
        'expected_duration_hours',
        'expectedDurationHours',
        'duration_hours',
        'durationHours',
      ]) ??
      childHours ??
      0;
    const spend =
      firstNumber(node, [
        'estimated_spend_usd',
        'estimatedSpendUsd',
        'expected_budget_usd',
        'expectedBudgetUsd',
        'budget_usd',
        'budgetUsd',
      ]) ??
      childSpend ??
      0;
    const explicitRoi = firstNumber(node, [
      'estimated_roi_usd',
      'estimatedRoiUsd',
      'expected_roi_usd',
      'expectedRoiUsd',
      'projected_value_usd',
      'projectedValueUsd',
      'expected_value_usd',
      'expectedValueUsd',
      'value_usd',
      'valueUsd',
    ]);
    const fallbackHumanEquivalentValue =
      childHumanEquivalentValue ?? hours * humanEquivalentRateUsd(node);
    const humanEquivalentHourlyRate =
      hours > 0
        ? fallbackHumanEquivalentValue / hours
        : humanEquivalentRateUsd(node);
    const roi =
      explicitRoi ??
      childRoi ??
      Math.max(0, fallbackHumanEquivalentValue - spend);

    return {
      estimated_hours: round(hours, 1),
      estimated_spend_usd: round(spend, 2),
      estimated_roi_usd: round(roi, 0),
      human_equivalent_hourly_rate_usd: round(humanEquivalentHourlyRate, 0),
      human_equivalent_value_usd: round(fallbackHumanEquivalentValue, 0),
      value_basis: ECONOMICS_VALUE_BASIS,
    };
  };

  const workstreams = wsRefs.map((wsRef, wsIdx) => {
    const milestones = (msRefs[wsIdx] ?? []).map((msRef, msIdx) => {
      const tasks = (taskRefs[wsIdx]?.[msIdx] ?? []).map((tRef) => {
        const task = nodeForRef(tRef);
        return { ...task, ...estimateEconomics(task, []) };
      });
      const milestone = nodeForRef(msRef);
      return { ...milestone, tasks, ...estimateEconomics(milestone, tasks) };
    });
    const workstream = nodeForRef(wsRef);
    return {
      ...workstream,
      milestones,
      ...estimateEconomics(workstream, milestones),
    };
  });

  const initiativeBase = nodeForRef(initiativeRef);
  const initiativeEconomics = estimateEconomics(initiativeBase, workstreams);

  return {
    initiative: { ...initiativeBase, ...initiativeEconomics },
    workstreams,
    economics: {
      ...initiativeEconomics,
      currency: 'USD',
      source: 'derived',
      editable: true,
      value_basis: ECONOMICS_VALUE_BASIS,
      rate_card_usd: HUMAN_EQUIVALENT_RATE_BY_TASK_TYPE_USD,
    },
  };
}
