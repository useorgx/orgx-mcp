import { describe, expect, it } from 'vitest';

import { detectProviderPinning } from '../src/providerPinning';

describe('detectProviderPinning', () => {
  it('returns null when nothing is pinned (auto / absent)', () => {
    expect(detectProviderPinning({ provider: 'auto' }, { provider: 'openai' })).toBeNull();
    expect(detectProviderPinning({}, { provider: 'openai' })).toBeNull();
  });

  it('reports no mismatch when the pinned provider was honored', () => {
    const r = detectProviderPinning({ provider: 'anthropic' }, { provider: 'anthropic' });
    expect(r?.provider_mismatch).toBe(false);
    expect(r?.used_provider).toBe('anthropic');
  });

  it('flags a provider mismatch (case-insensitive)', () => {
    const r = detectProviderPinning({ provider: 'anthropic' }, { provider: 'OpenAI' });
    expect(r?.provider_mismatch).toBe(true);
    expect(r?.requested_provider).toBe('anthropic');
    expect(r?.used_provider).toBe('OpenAI');
  });

  it('flags a model mismatch', () => {
    const r = detectProviderPinning(
      { model: 'claude-opus-4-8' },
      { model: 'claude-haiku-4-5' }
    );
    expect(r?.model_mismatch).toBe(true);
  });

  it('reads the used provider from a runtime nest and common aliases', () => {
    expect(detectProviderPinning({ provider: 'x' }, { model_provider: 'x' })?.provider_mismatch).toBe(false);
    expect(detectProviderPinning({ provider: 'x' }, { runtime: { provider: 'y' } })?.provider_mismatch).toBe(true);
  });

  it('does not flag a mismatch when the response omits the used provider', () => {
    const r = detectProviderPinning({ provider: 'anthropic' }, {});
    expect(r?.provider_mismatch).toBe(false);
    expect(r?.used_provider).toBeUndefined();
  });
});
