import { describe, expect, it } from 'vitest';

import { applyRunTokenScopes } from '../src/runTokenScopes';

describe('applyRunTokenScopes', () => {
  it('caps the profile at the granted scopes', () => {
    const profile = new Set(['orgx_search', 'orgx_inspect', 'orgx_write', 'orgx_spawn']);
    expect([...applyRunTokenScopes(profile, ['orgx_search', 'orgx_inspect'])!].sort()).toEqual(['orgx_inspect', 'orgx_search']);
  });

  it('never widens a profile with scopes it does not contain', () => {
    expect([...applyRunTokenScopes(new Set(['orgx_search']), ['orgx_search', 'orgx_write'])!]).toEqual(['orgx_search']);
  });

  it('grants exactly the scopes when the profile is the full surface', () => {
    expect([...applyRunTokenScopes(null, ['orgx_inspect'])!]).toEqual(['orgx_inspect']);
  });

  it('fails closed: empty scopes mean no tools', () => {
    expect(applyRunTokenScopes(null, [])!.size).toBe(0);
    expect(applyRunTokenScopes(new Set(['orgx_search']), [])!.size).toBe(0);
  });

  it('leaves unscoped (v1) sessions on their profile', () => {
    expect(applyRunTokenScopes(null, undefined)).toBeNull();
    expect([...applyRunTokenScopes(new Set(['orgx_search']), undefined)!]).toEqual(['orgx_search']);
  });
});
