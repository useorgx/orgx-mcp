export const CONSENT_BROWSER_STAGES = ['consent_viewed', 'consent_reviewed', 'consent_failed'] as const;
export const CONSENT_FAILURE_REASONS = ['request_timeout', 'network_error', 'invalid_response', 'session_expired'] as const;
export type OAuthJourneyStage = typeof CONSENT_BROWSER_STAGES[number]
  | 'sign_in_redirect' | 'identity_verified' | 'consent_redirect' | 'failed'
  | 'consent_approved' | 'consent_denied' | 'consent_expired' | 'client_return_issued';
export type OAuthJourneyReason = typeof CONSENT_FAILURE_REASONS[number]
  | 'provider_error' | 'invalid_selection' | 'state_unavailable' | 'consent_prepare_failed' | 'access_denied' | 'identity_verification_failed';

export const OAUTH_REDIRECT_ROUTE_SEGMENTS = new Set(['oauth', 'oauth2', 'auth', 'callback', 'redirect', 'orgx', 'mcp',
  'connector_platform_oauth_redirect', 'oauth_redirect', 'oauth-callback', 'consent.html', 'sign-in']);

/** Never include query, fragment, credentials, or arbitrary registered callback path text. */
export function safeOAuthDestination(value?: string): { destination_host?: string; destination_path?: string } {
  if (!value) return {};
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const redirectHost = /^[a-z0-9.[\]:-]{1,253}$/.test(hostname) ? hostname : undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    const path = segments.length <= 8 && segments.every((segment) => OAUTH_REDIRECT_ROUTE_SEGMENTS.has(segment))
      ? url.pathname : '/other';
    return { ...(redirectHost ? { destination_host: redirectHost } : {}), destination_path: path };
  } catch { return {}; }
}


export const OAUTH_JOURNEY_STAGES: readonly OAuthJourneyStage[] = [...CONSENT_BROWSER_STAGES,
  'sign_in_redirect', 'identity_verified', 'consent_redirect', 'failed', 'consent_approved',
  'consent_denied', 'consent_expired', 'client_return_issued'];
export const OAUTH_JOURNEY_REASONS: readonly OAuthJourneyReason[] = [...CONSENT_FAILURE_REASONS,
  'provider_error', 'invalid_selection', 'state_unavailable', 'consent_prepare_failed', 'access_denied', 'identity_verification_failed'];
