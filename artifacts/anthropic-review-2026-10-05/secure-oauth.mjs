import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

export const SERVER_URL = 'https://mcp.useorgx.com/mcp?profile=claude-directory';
export const REVIEW_WORKSPACE_ID = '127758d2-0509-4a76-9e43-850f845754fd';
export const REVIEW_SCOPES = 'decisions:read decisions:write agents:read agents:write initiatives:read initiatives:write memory:read offline_access';

function sameState(actual, expected) {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function browserResponse(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(message);
}

async function ownedServerFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://mcp.useorgx.com') throw new Error('Unexpected OAuth destination');
  return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(25_000) });
}

/** Supported SDK auth() orchestration; no password or OAuth token is logged. */
export async function prepareOAuth({ fetchFn = ownedServerFetch, onHandoff = console.log, timeoutMs = 15 * 60_000 } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'orgx-anthropic-oauth-'));
  await chmod(outputDir, 0o700);
  const tokenFile = join(outputDir, 'oauth.json');
  const stateValue = randomBytes(32).toString('base64url');
  let redirectUrl;
  let clientInformation;
  let tokenData;
  let verifier;
  let callbackInProgress = false;
  let finished = false;
  let timeout;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const provider = {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() {
      return {
        client_name: 'OrgX Anthropic Directory Verification',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: REVIEW_SCOPES,
      };
    },
    state() { return stateValue; },
    clientInformation() { return clientInformation; },
    saveClientInformation(value) { clientInformation = value; },
    tokens() { return tokenData; },
    async saveTokens(value) {
      tokenData = value;
      const record = {
        serverUrl: SERVER_URL,
        workspaceId: REVIEW_WORKSPACE_ID,
        createdAt: new Date().toISOString(),
        requestedScope: REVIEW_SCOPES,
        clientInformation,
        tokens: value,
      };
      await writeFile(tokenFile, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    },
    redirectToAuthorization(url) {
      if (url.origin !== 'https://mcp.useorgx.com') throw new Error('Unexpected authorization destination');
      onHandoff(JSON.stringify({ event: 'oauth_handoff', authorizationUrl: url.href, callbackUrl: redirectUrl, tokenFile, workspaceId: REVIEW_WORKSPACE_ID, requestedScope: REVIEW_SCOPES }));
    },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier() {
      if (!verifier) throw new Error('PKCE verifier unavailable');
      return verifier;
    },
  };
  function finish(ok, code) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    verifier = undefined;
    server.close();
    resolveDone({ ok, code, tokenFile, outputDir });
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', redirectUrl ?? 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
      browserResponse(res, 404, 'Not found.');
      return;
    }
    if (!sameState(url.searchParams.get('state'), stateValue)) {
      browserResponse(res, 400, 'Invalid authorization state.');
      return;
    }
    if (url.searchParams.has('error')) {
      browserResponse(res, 400, 'Authorization was declined or failed.');
      finish(false, 'authorization_declined');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || callbackInProgress) {
      browserResponse(res, 400, 'Invalid or repeated authorization callback.');
      return;
    }
    callbackInProgress = true;
    try {
      const result = await auth(provider, { serverUrl: SERVER_URL, scope: REVIEW_SCOPES, authorizationCode: code, fetchFn });
      if (result !== 'AUTHORIZED') throw new Error('Authorization did not complete');
      browserResponse(res, 200, 'OrgX test authorization completed. You can close this tab.');
      finish(true, 'authorized');
    } catch {
      browserResponse(res, 400, 'Token exchange failed. No credentials were logged.');
      finish(false, 'token_exchange_failed');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  redirectUrl = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  timeout = setTimeout(() => finish(false, 'authorization_timeout'), timeoutMs);
  try {
    const result = await auth(provider, { serverUrl: SERVER_URL, scope: REVIEW_SCOPES, fetchFn });
    if (result !== 'REDIRECT') throw new Error('Unexpected preauthorization result');
  } catch {
    finish(false, 'oauth_preparation_failed');
  }
  return { done, outputDir, tokenFile, close: () => finish(false, 'cancelled') };
}

async function selfTest() {
  let handoff;
  let exchangeCount = 0;
  const fakeFetch = async (input) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.useorgx.com/mcp', authorization_servers: ['https://mcp.useorgx.com'] });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({ issuer: 'https://mcp.useorgx.com', authorization_endpoint: 'https://mcp.useorgx.com/authorize', token_endpoint: 'https://mcp.useorgx.com/token', registration_endpoint: 'https://mcp.useorgx.com/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/register') return Response.json({ client_id: 'local-self-test', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' });
    if (url.pathname === '/token') {
      exchangeCount += 1;
      return Response.json({ access_token: 'local-test-access-value', refresh_token: 'local-test-refresh-value', token_type: 'Bearer', expires_in: 3600, scope: REVIEW_SCOPES });
    }
    throw new Error('Unexpected mock request');
  };
  const run = await prepareOAuth({ fetchFn: fakeFetch, onHandoff: value => { handoff = JSON.parse(value); }, timeoutMs: 5_000 });
  try {
    if (!handoff || exchangeCount !== 0) throw new Error('Preparation unexpectedly exchanged tokens');
    const authUrl = new URL(handoff.authorizationUrl);
    if (authUrl.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 missing');
    const callback = new URL(handoff.callbackUrl);
    callback.searchParams.set('state', 'incorrect');
    callback.searchParams.set('code', 'mock-code');
    if ((await fetch(callback)).status !== 400 || exchangeCount !== 0) throw new Error('State check did not fail closed');
    callback.searchParams.set('state', authUrl.searchParams.get('state'));
    if ((await fetch(callback)).status !== 200) throw new Error('Valid callback failed');
    const result = await run.done;
    const record = JSON.parse(await readFile(result.tokenFile, 'utf8'));
    if (!result.ok || exchangeCount !== 1 || record.workspaceId !== REVIEW_WORKSPACE_ID) throw new Error('Auth callback/storage mismatch');
    if (((await stat(result.tokenFile)).mode & 0o777) !== 0o600) throw new Error('Token file is not owner-only');
    console.log(JSON.stringify({ event: 'self_test_passed', mockedNetworkOnly: true, pkceS256: true, stateRejected: true, tokenFileMode: '0600', externalGrant: false }));
  } finally {
    run.close();
    await rm(run.outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--self-test')) await selfTest();
    else {
      const run = await prepareOAuth();
      process.once('SIGTERM', run.close);
      process.once('SIGINT', run.close);
      const result = await run.done;
      console.log(JSON.stringify({ event: result.ok ? 'oauth_authorized' : 'oauth_stopped', code: result.code, tokenFile: result.ok ? result.tokenFile : undefined }));
      if (!result.ok) {
        await rm(result.outputDir, { recursive: true, force: true });
        process.exitCode = 1;
      }
    }
  } catch {
    console.error(JSON.stringify({ event: 'oauth_runner_failed' }));
    process.exitCode = 1;
  }
}
