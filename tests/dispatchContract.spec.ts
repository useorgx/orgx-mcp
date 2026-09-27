import { describe, expect, it } from 'vitest';

import {
  buildAcceptanceBinding,
  canonicalJson,
  evaluateAcceptance,
  hashAcceptanceContract,
  normalizeAcceptance,
  normalizeDeadline,
  normalizeDispatchContract,
  normalizeVerify,
  type AcceptanceBinding,
} from '../src/dispatchContract';

const NOW = new Date('2026-09-27T12:00:00Z');

function commandCheck(id: string, command = 'pnpm test', expectExit = 0) {
  return {
    id,
    statement: `${id} holds`,
    verify: { kind: 'command', command, expect_exit: expectExit },
  };
}

describe('normalizeDeadline', () => {
  it('accepts a future ISO-8601 instant and normalizes it to UTC', () => {
    const result = normalizeDeadline('2026-09-28T17:00:00+02:00', NOW);
    expect(result).toEqual({ ok: true, value: '2026-09-28T15:00:00.000Z' });
  });

  it('rejects free text, which is what both legacy verbs accepted', () => {
    const result = normalizeDeadline('end of next week', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/ISO-8601/);
  });

  it('rejects a bare date with no timezone rather than guessing an instant', () => {
    expect(normalizeDeadline('2026-09-28', NOW).ok).toBe(false);
    expect(normalizeDeadline('2026', NOW).ok).toBe(false);
  });

  it('rejects a deadline already in the past', () => {
    const result = normalizeDeadline('2026-09-26T12:00:00Z', NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/in the past/);
  });

  it('treats an absent deadline as unconstrained, not invalid', () => {
    expect(normalizeDeadline(undefined, NOW)).toEqual({ ok: true, value: null });
    expect(normalizeDeadline('   ', NOW)).toEqual({ ok: true, value: null });
  });
});

describe('normalizeVerify', () => {
  it('defaults a command check to expect_exit 0 and keeps an explicit code', () => {
    expect(normalizeVerify('c', { kind: 'command', command: 'pnpm test' })).toEqual(
      { ok: true, value: { kind: 'command', command: 'pnpm test', expect_exit: 0 } }
    );
    expect(
      normalizeVerify('c', { kind: 'command', command: 'grep x f', expect_exit: 1 })
    ).toEqual({
      ok: true,
      value: { kind: 'command', command: 'grep x f', expect_exit: 1 },
    });
  });

  it('rejects an unknown verify kind at dispatch, not at completion', () => {
    const result = normalizeVerify('c', { kind: 'vibes' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/expected one of/);
  });

  it('rejects a manual check with no named reviewer', () => {
    const result = normalizeVerify('c', { kind: 'manual' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/named reviewer/);
  });

  it('rejects a relative http url', () => {
    expect(normalizeVerify('c', { kind: 'http', url: '/api/health' }).ok).toBe(
      false
    );
  });
});

describe('normalizeAcceptance', () => {
  it('requires a stable id on every check', () => {
    const result = normalizeAcceptance([
      { statement: 'it works', verify: { kind: 'command', command: 'x' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/stable id/);
  });

  it('rejects duplicate ids so the receipt stays unambiguous', () => {
    const result = normalizeAcceptance([commandCheck('a'), commandCheck('a')]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toMatch(/duplicate check id/);
  });

  it('defaults must_fail_before to true and honours an explicit false', () => {
    const result = normalizeAcceptance([
      commandCheck('a'),
      { ...commandCheck('b'), must_fail_before: false },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.map((c) => c.must_fail_before)).toEqual([true, false]);
  });

  it('treats no acceptance block as an empty contract', () => {
    expect(normalizeAcceptance(undefined)).toEqual({ ok: true, value: [] });
  });
});

describe('normalizeDispatchContract', () => {
  it('normalizes the union of fields the four verbs used to split', () => {
    const result = normalizeDispatchContract(
      {
        deadline: '2026-09-28T17:00:00Z',
        max_cost_usd: 20,
        budget_mode: 'cheapest_valid',
        max_parallel: 3,
        expected_artifacts: ['PRD', '  ', 'deploy proof'],
        effects: {
          allowed: ['branch.write'],
          approval_required: ['merge', 'deploy'],
        },
        acceptance: [commandCheck('regression-covered')],
        idempotency_key: 'attempt-1',
      },
      NOW
    );

    expect(result.ok).toBe(true);
    const contract = result.contract!;
    expect(contract.deadline).toBe('2026-09-28T17:00:00.000Z');
    expect(contract.max_cost_usd).toBe(20);
    expect(contract.budget_mode).toBe('cheapest_valid');
    expect(contract.max_parallel).toBe(3);
    expect(contract.expected_artifacts).toEqual(['PRD', 'deploy proof']);
    expect(contract.effects).toEqual({
      allowed: ['branch.write'],
      approval_required: ['merge', 'deploy'],
    });
    expect(contract.acceptance).toHaveLength(1);
    expect(contract.idempotency_key).toBe('attempt-1');
  });

  it('surfaces the offending field in the refusal', () => {
    expect(normalizeDispatchContract({ deadline: 'soon' }, NOW).code).toBe(
      'invalid_deadline'
    );
    expect(
      normalizeDispatchContract({ acceptance: [{ id: 'a' }] }, NOW).code
    ).toBe('invalid_acceptance_contract');
    expect(normalizeDispatchContract({ max_parallel: 0 }, NOW).code).toBe(
      'invalid_parallelism'
    );
    expect(normalizeDispatchContract({ max_parallel: 99 }, NOW).code).toBe(
      'invalid_parallelism'
    );
    expect(normalizeDispatchContract({ max_cost_usd: -1 }, NOW).code).toBe(
      'invalid_budget'
    );
  });

  it('accepts an empty payload — every contract field is optional', () => {
    const result = normalizeDispatchContract({}, NOW);
    expect(result.ok).toBe(true);
    expect(result.contract).toEqual({
      deadline: null,
      max_cost_usd: null,
      budget_mode: null,
      max_parallel: null,
      expected_artifacts: [],
      effects: null,
      acceptance: [],
      idempotency_key: null,
    });
  });
});

describe('canonicalJson', () => {
  it('is key-order independent so the same contract hashes the same', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    );
  });

  it('preserves array order, which is part of the contract', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('hashAcceptanceContract', () => {
  it('is stable across key order and changes when a check changes', async () => {
    const a = normalizeAcceptance([commandCheck('x', 'pnpm test')]);
    const b = normalizeAcceptance([commandCheck('x', 'pnpm test')]);
    const c = normalizeAcceptance([commandCheck('x', 'pnpm test -- --bail')]);
    if (!a.ok || !b.ok || !c.ok) throw new Error('fixture failed to normalize');

    expect(await hashAcceptanceContract(a.value)).toBe(
      await hashAcceptanceContract(b.value)
    );
    expect(await hashAcceptanceContract(a.value)).not.toBe(
      await hashAcceptanceContract(c.value)
    );
  });
});

describe('buildAcceptanceBinding', () => {
  it('returns null when nothing was declared', async () => {
    expect(await buildAcceptanceBinding([])).toBeNull();
  });

  it('records declared_at and starts every check unprobed', async () => {
    const normalized = normalizeAcceptance([commandCheck('a')]);
    if (!normalized.ok) throw new Error('fixture failed');
    const binding = await buildAcceptanceBinding(normalized.value, NOW);
    expect(binding).not.toBeNull();
    expect(binding!.declared_at).toBe('2026-09-27T12:00:00.000Z');
    expect(binding!.checks[0]!.pre_state).toBe('unprobed');
    expect(binding!.contract_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('evaluateAcceptance', () => {
  async function bindingFor(ids: string[]): Promise<AcceptanceBinding> {
    const normalized = normalizeAcceptance(ids.map((id) => commandCheck(id)));
    if (!normalized.ok) throw new Error('fixture failed');
    const binding = await buildAcceptanceBinding(normalized.value, NOW);
    if (!binding) throw new Error('fixture failed');
    return binding;
  }

  it('accepts only when every check was observed to go fail -> pass', async () => {
    const binding = await bindingFor(['a', 'b']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'a', pre: 'fail', post: 'pass' },
      { id: 'b', pre: 'fail', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(true);
    expect(verdict.checks.every((c) => c.counted)).toBe(true);
  });

  it('refuses to count a check that already passed — the `|| echo` case', async () => {
    const binding = await bindingFor(['already-green']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'already-green', pre: 'pass', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks[0]).toMatchObject({
      counted: false,
      reason: 'non_discriminating',
    });
  });

  it('refuses to count a check whose pre-state nobody established', async () => {
    const binding = await bindingFor(['unknown-pre']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'unknown-pre', pre: 'unprobed', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks[0]).toMatchObject({
      counted: false,
      reason: 'unprobed',
    });
  });

  it('counts a pre-passing check when the author waived discrimination', async () => {
    const normalized = normalizeAcceptance([
      { ...commandCheck('waived'), must_fail_before: false },
    ]);
    if (!normalized.ok) throw new Error('fixture failed');
    const binding = await buildAcceptanceBinding(normalized.value, NOW);
    const verdict = evaluateAcceptance(binding!, [
      { id: 'waived', pre: 'pass', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(true);
  });

  it('marks a check the completion never mentioned as not_observed', async () => {
    const binding = await bindingFor(['a', 'silent']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'a', pre: 'fail', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks[1]).toMatchObject({
      counted: false,
      reason: 'not_observed',
    });
  });

  it('does not accept a run with no discriminating check at all', async () => {
    const binding = await bindingFor(['a']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'a', pre: 'pass', post: 'pass' },
    ]);
    expect(verdict.accepted).toBe(false);
  });

  it('rejects a completion that substituted the contract after dispatch', async () => {
    const binding = await bindingFor(['a']);
    const verdict = evaluateAcceptance(
      binding,
      [{ id: 'a', pre: 'fail', post: 'pass' }],
      'f'.repeat(64)
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejection).toMatch(/cannot be substituted/);
  });

  it('reports a genuinely failing check as failed, not missing', async () => {
    const binding = await bindingFor(['a']);
    const verdict = evaluateAcceptance(binding, [
      { id: 'a', pre: 'fail', post: 'fail' },
    ]);
    expect(verdict.accepted).toBe(false);
    expect(verdict.checks[0]).toMatchObject({ counted: false, reason: 'failed' });
  });
});
