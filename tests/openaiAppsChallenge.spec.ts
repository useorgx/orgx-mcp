import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OPENAI_APPS_CHALLENGE_PATH,
  handleOpenAiAppsChallenge,
} from '../src/openaiAppsChallenge';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('OpenAI Apps domain challenge', () => {
  it('returns the configured token as exact plaintext without a trailing newline', async () => {
    const token = 'openai-domain-challenge-value';
    const response = handleOpenAiAppsChallenge(
      new Request(`https://mcp.useorgx.com${OPENAI_APPS_CHALLENGE_PATH}`),
      { OPENAI_APPS_CHALLENGE_TOKEN: token }
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8'
    );
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.text()).toBe(token);
  });

  it('fails closed with 404 when the binding is unset or empty', async () => {
    for (const env of [{}, { OPENAI_APPS_CHALLENGE_TOKEN: '' }]) {
      const response = handleOpenAiAppsChallenge(
        new Request(`https://mcp.useorgx.com${OPENAI_APPS_CHALLENGE_PATH}`),
        env
      );

      expect(response?.status).toBe(404);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      expect(await response?.text()).toBe('Not Found');
    }
  });

  it('does not intercept other paths or non-GET requests', () => {
    expect(
      handleOpenAiAppsChallenge(
        new Request('https://mcp.useorgx.com/.well-known/other'),
        { OPENAI_APPS_CHALLENGE_TOKEN: 'token' }
      )
    ).toBeNull();
    expect(
      handleOpenAiAppsChallenge(
        new Request(
          `https://mcp.useorgx.com${OPENAI_APPS_CHALLENGE_PATH}`,
          { method: 'HEAD' }
        ),
        { OPENAI_APPS_CHALLENGE_TOKEN: 'token' }
      )
    ).toBeNull();
  });

  it('runs before OAuthProvider in the deployed worker entry point', () => {
    const indexSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
    const challengeCall = indexSource.indexOf(
      'handleOpenAiAppsChallenge(request, env)'
    );
    const oauthCall = indexSource.indexOf(
      'oauthProvider.fetch(request, env, ctx)'
    );

    expect(challengeCall).toBeGreaterThan(-1);
    expect(oauthCall).toBeGreaterThan(challengeCall);
  });
});
