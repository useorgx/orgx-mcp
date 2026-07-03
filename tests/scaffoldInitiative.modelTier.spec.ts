import { describe, expect, it } from 'vitest';

import { buildScaffoldInitiativeBatch } from '../src/scaffoldInitiative';

describe('buildScaffoldInitiativeBatch model tier hygiene', () => {
  it('defaults scaffolded initiatives to the standard model tier', () => {
    const { batch } = buildScaffoldInitiativeBatch({
      title: 'Cheap test execution',
      workstreams: [],
    });

    const initiative = batch.find((e) => e.type === 'initiative');
    const metadata = initiative?.metadata as Record<string, unknown>;

    expect(metadata?.model_tier).toBe('standard');
  });

  it('preserves explicit scaffold model tier metadata', () => {
    const { batch } = buildScaffoldInitiativeBatch({
      title: 'Publish quality execution',
      metadata: { model_tier: 'precision' },
      workstreams: [],
    });

    const initiative = batch.find((e) => e.type === 'initiative');
    const metadata = initiative?.metadata as Record<string, unknown>;

    expect(metadata?.model_tier).toBe('precision');
  });
});
