export const OPENAI_APPS_CHALLENGE_PATH =
  '/.well-known/openai-apps-challenge' as const;

export interface OpenAiAppsChallengeEnv {
  /**
   * Domain-verification token issued by the OpenAI plugin submission portal.
   * Configure this as a Worker binding; never commit an issued token.
   */
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
}

/**
 * Serve OpenAI's domain-verification token before OAuth routing.
 *
 * The portal requires the response body to be the exact token with no JSON
 * envelope or trailing newline. An unconfigured worker fails closed with 404.
 */
export function handleOpenAiAppsChallenge(
  request: Request,
  env: OpenAiAppsChallengeEnv
): Response | null {
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.pathname !== OPENAI_APPS_CHALLENGE_PATH
  ) {
    return null;
  }

  const token = env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  return new Response(token, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
