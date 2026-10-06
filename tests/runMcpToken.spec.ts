import { describe, expect, it } from 'vitest';
import { brokerTokenSecret, verifyBrokerToken } from '../src/broker/brokerToken';
import {
  isRunMcpToken,
  runMcpTokenSecret,
  runMcpTokenVerificationSecrets,
  verifyRunMcpToken,
} from '../src/runMcpToken';

const SECRET = 'shared-run-mcp-secret-which-is-long-enough-32+';

// Mint a token the same way the main OrgX app does, using Web Crypto so the
// test exercises the worker's exact verification path.
async function mint(
  payload: Record<string, unknown>,
  prefix = 'oxrun1',
  secret = SECRET
): Promise<string> {
  const b64url = (bytes: Uint8Array) => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const body = `${prefix}.${b64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
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

  describe('v2 (oxrun2)', () => {
    const v2 = {
      ...base,
      v: 2,
      aud: 'orgx-mcp',
      scp: ['mcp.slack'],
      jti: 'j-1',
      iat: 1_000_000,
    };

    it('verifies a run-bound token and returns its scopes', async () => {
      const token = await mint(v2, 'oxrun2');
      expect(isRunMcpToken(token)).toBe(true);
      expect(await verifyRunMcpToken(token, SECRET, 1_000_000_000)).toMatchObject({
        rid: 'run-1',
        wid: 'ws-1',
        scp: ['mcp.slack'],
      });
    });

    it('rejects v2 without audience, run or workspace', async () => {
      for (const broken of [
        { ...v2, aud: 'other' },
        { ...v2, rid: null },
        { ...v2, wid: null },
        { ...v2, scp: 'mcp.slack' },
      ]) {
        const token = await mint(broken, 'oxrun2');
        expect(await verifyRunMcpToken(token, SECRET, 1_000_000_000)).toBeNull();
      }
    });

    it('rejects a v2 body under the v1 prefix', async () => {
      const token = await mint(v2, 'oxrun1');
      expect(await verifyRunMcpToken(token, SECRET, 1_000_000_000)).toBeNull();
    });
  });
});

describe('switching to the dedicated secret without downtime', () => {
  // Obvious fakes, never real values.
  const DEDICATED = 'fake-dedicated-run-token-secret-0000000000';
  const SERVICE_KEY = 'oxk-fake-service-key-for-tests-000000000000';
  const OTHER = 'fake-unrelated-secret-that-signs-nothing-00';
  const env = { ORGX_RUN_MCP_TOKEN_SECRET: DEDICATED, ORGX_SERVICE_KEY: SERVICE_KEY };
  const NOW_MS = 1_000_000_000;
  const v2 = {
    ...base,
    v: 2,
    aud: 'orgx-mcp',
    scp: ['mcp.slack'],
    jti: 'j-1',
    iat: 1_000_000,
  };

  it('tries the dedicated secret first, then the service key', () => {
    expect(runMcpTokenVerificationSecrets(env)).toEqual([DEDICATED, SERVICE_KEY]);
    expect(runMcpTokenVerificationSecrets({ ORGX_SERVICE_KEY: SERVICE_KEY })).toEqual([
      SERVICE_KEY,
    ]);
    expect(
      runMcpTokenVerificationSecrets({ ORGX_RUN_MCP_TOKEN_SECRET: 'short', ORGX_SERVICE_KEY: '' })
    ).toEqual([]);
    expect(
      runMcpTokenVerificationSecrets({
        ORGX_RUN_MCP_TOKEN_SECRET: SERVICE_KEY,
        ORGX_SERVICE_KEY: SERVICE_KEY,
      })
    ).toEqual([SERVICE_KEY]);
  });

  it('signs with the dedicated secret when it is set', () => {
    expect(runMcpTokenSecret(env)).toBe(DEDICATED);
    expect(runMcpTokenSecret({ ORGX_SERVICE_KEY: SERVICE_KEY })).toBe(SERVICE_KEY);
  });

  it('accepts a token signed with the dedicated secret', async () => {
    for (const token of [
      await mint(base, 'oxrun1', DEDICATED),
      await mint(v2, 'oxrun2', DEDICATED),
    ]) {
      expect(
        await verifyRunMcpToken(token, runMcpTokenVerificationSecrets(env), NOW_MS)
      ).toMatchObject({ uid: 'user-1' });
    }
  });

  it('still accepts a token an app on the old key signed with the service key', async () => {
    for (const token of [
      await mint(base, 'oxrun1', SERVICE_KEY),
      await mint(v2, 'oxrun2', SERVICE_KEY),
    ]) {
      expect(
        await verifyRunMcpToken(token, runMcpTokenVerificationSecrets(env), NOW_MS)
      ).toMatchObject({ uid: 'user-1' });
    }
  });

  it('rejects a token signed with any other secret, and garbage', async () => {
    const secrets = runMcpTokenVerificationSecrets(env);
    expect(await verifyRunMcpToken(await mint(base, 'oxrun1', OTHER), secrets, NOW_MS)).toBeNull();
    for (const garbage of ['oxrun1.', 'oxrun1.a.b', 'oxrun2.not-json.sig', 'oxrun1.a.b.c', '']) {
      expect(await verifyRunMcpToken(garbage, secrets, NOW_MS)).toBeNull();
    }
    expect(await verifyRunMcpToken(await mint(base, 'oxrun1', DEDICATED), [], NOW_MS)).toBeNull();
  });

  it('never accepts a broker token signed with the service key', async () => {
    const brokerClaims = {
      ...v2,
      aud: 'orgx-broker',
      conns: { 'bnd_44444444-4444-4444-8444-444444444444': {} },
    };
    const forged = await mint(brokerClaims, 'oxrun2', SERVICE_KEY);
    const brokerSecret = brokerTokenSecret(env);
    expect(brokerSecret).toBe(DEDICATED);
    expect(await verifyBrokerToken(forged, brokerSecret as string, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Without the dedicated secret there is no broker secret at all.
    expect(brokerTokenSecret({ ORGX_SERVICE_KEY: SERVICE_KEY } as never)).toBeNull();
    // And the OrgX MCP path refuses it too: wrong audience.
    expect(
      await verifyRunMcpToken(forged, runMcpTokenVerificationSecrets(env), NOW_MS)
    ).toBeNull();
    // The same claims signed with the dedicated secret do verify as a broker token.
    const genuine = await mint(brokerClaims, 'oxrun2', DEDICATED);
    expect((await verifyBrokerToken(genuine, DEDICATED, NOW_MS)).ok).toBe(true);
  });
});
