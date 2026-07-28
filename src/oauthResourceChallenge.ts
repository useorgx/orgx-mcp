const PATH_SCOPED_RESOURCES = new Set(['/mcp', '/sse']);

type RequestUrl = Pick<Request, 'url'>;

function getPathScopedMetadataUrl(request: RequestUrl): string | null {
  const requestUrl = new URL(request.url);
  if (!PATH_SCOPED_RESOURCES.has(requestUrl.pathname)) return null;

  return `${requestUrl.origin}/.well-known/oauth-protected-resource${requestUrl.pathname}`;
}

/**
 * The OAuth provider currently emits an origin-level RFC 9728 challenge for
 * every protected API route. MCP clients exchange tokens for the configured
 * path resource, so advertise the matching path-specific metadata document.
 */
export function withPathScopedResourceChallenge(
  request: RequestUrl,
  response: Response
): Response {
  if (response.status !== 401) return response;

  const metadataUrl = getPathScopedMetadataUrl(request);
  if (!metadataUrl) return response;

  const challenge = response.headers.get('WWW-Authenticate');
  if (!challenge || !/^Bearer\b/i.test(challenge)) return response;

  const resourceMetadata = `resource_metadata="${metadataUrl}"`;
  const nextChallenge = /\bresource_metadata="[^"]*"/i.test(challenge)
    ? challenge.replace(/\bresource_metadata="[^"]*"/i, resourceMetadata)
    : `${challenge}, ${resourceMetadata}`;

  if (nextChallenge === challenge) return response;

  const headers = new Headers(response.headers);
  headers.set('WWW-Authenticate', nextChallenge);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
