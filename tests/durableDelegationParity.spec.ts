import { describe, expect, it } from 'vitest';
import { validateDurableDelegationResponse } from '../src/durableDelegationContract';
import cases from './fixtures/durable-delegation-v2.json';

describe('durable delegation v2 shared characterization', () => {
  it.each(cases)('$name', ({ payload, valid }) => {
    expect(validateDurableDelegationResponse(payload).ok).toBe(valid);
    expect(validateDurableDelegationResponse({ data: payload }).ok).toBe(valid);
  });
});
