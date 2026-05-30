import { describe, expect, it } from 'vitest';
import { isRunMcpToken, verifyRunMcpToken } from '../src/runMcpToken';

const SECRET = 'shared-run-mcp-secret-which-is-long-enough-32+';

// Mint a token the same way the main OrgX app does, using Web Crypto so the
// test exercises the worker's exact verification path.
async function mint(payload: Record<string, unknown>): Promise<string> {
  const b64url = (bytes: Uint8Array) => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const body = `oxrun1.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  );
  return `${body}.${b64url(sig)}`;
}

const base = {
  iss: 'orgx-run-mcp',
  uid: 'user-1',
  wid: 'ws-1',
  rid: 'run-1',
  exp: 2_000_000,
};

describe('verifyRunMcpToken (worker)', () => {
  it('verifies a valid token and returns claims', async () => {
    const token = await mint(base);
    expect(isRunMcpToken(token)).toBe(true);
    const payload = await verifyRunMcpToken(token, SECRET, 1_000_000_000);
    // exp is in seconds; nowMs/1000 = 1_000_000 < 2_000_000 → valid
    expect(payload).toMatchObject({ uid: 'user-1', wid: 'ws-1', rid: 'run-1' });
  });

  it('rejects an expired token', async () => {
    const token = await mint({ ...base, exp: 100 });
    expect(await verifyRunMcpToken(token, SECRET, 200_000)).toBeNull();
  });

  it('rejects a wrong-issuer token', async () => {
    const token = await mint({ ...base, iss: 'someone-else' });
    expect(await verifyRunMcpToken(token, SECRET, 1_000_000_000)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mint(base);
    expect(
      await verifyRunMcpToken(token, 'different-secret-also-long-enough-32+xx', 1_000_000_000)
    ).toBeNull();
  });

  it('ignores non-run-token bearers', async () => {
    expect(isRunMcpToken('oauth-token')).toBe(false);
    expect(await verifyRunMcpToken('oauth-token', SECRET, 0)).toBeNull();
    expect(await verifyRunMcpToken(null, SECRET, 0)).toBeNull();
  });
});
