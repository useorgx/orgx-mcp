import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';

import { edgeLogger } from '@/lib/edgeLogger';

import {
  DOCS_CANONICAL_HOSTNAME,
  DOCS_CANONICAL_ORIGIN,
  LEGACY_DOCS_HOSTNAMES,
  isDocsPathname,
  resolveLegacyDocsPathname,
} from '@/lib/docs/routes';
import { isInfraRequestPathname } from '@/lib/server/middleware/infraRoutes';
import { isSensitiveDotfileProbePathname } from '@/lib/server/middleware/sensitiveProbeRoutes';
import { isAuthSurfacePath } from '@/lib/auth/authSurface';
import {
  hasOnboardingAccess,
  isAppShellRoute,
  isOnboardingExempt,
  ONBOARDING_NEXT_PARAM,
  safeOnboardingReturnPath,
} from '@/lib/shared/onboardingRoutes';
import { isApiKeyIngestionPath } from '@/lib/server/middleware/apiKeyRoutes';
import { classifyServiceKeyBearer } from '@/lib/server/middleware/serviceKeyRoutes';
import { isFixtureProfile } from '@/lib/server/fixtureProfile';
import { fixtureModeAllowed } from '@/lib/server/authPosture';

/**
 * Quick shape check for per-user API keys used by versioned REST routes.
 *
 * IMPORTANT: This does not authenticate the key. Route handlers perform secure
 * verification via ensureApiKeyAuthorized()/authenticateApiKey().
 */
function hasLikelyApiKey(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // Full key format: oxk_ + 40 chars (44 total). Keep this intentionally lenient
  // so malformed keys still reach route-level auth and get JSON errors.
  return token.startsWith('oxk_') && token.length >= 20;
}

/**
 * Versioned REST routes that authenticate with
 * per-user API keys (oxk_...) instead of Clerk sessions. Same contract as
 * /api/v1/*: middleware lets the request through on key *shape* only,
 * and the route handler performs full timing-safe verification via
 * ensureApiKeyAuthorized().
 */
// Check if Clerk is properly configured (has secret key) - need this early for isPublicRoute
const hasClerkSecretKey = Boolean(process.env.CLERK_SECRET_KEY);
const hasClerkPublishableKey = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
);
const isDev = process.env.NODE_ENV === 'development';
// Fixture mode makes most of the app public; never on a production deployment.
const isFixtureMode = fixtureModeAllowed();
const shouldUseClerk = hasClerkSecretKey && hasClerkPublishableKey;

// In dev mode without Clerk, make studio routes public
const devOnlyPublicPatterns =
  isDev && !hasClerkSecretKey ? ['/studio(.*)', '/api/studio(.*)'] : [];

// App-shell fixture routes are public only in local/dev fixture mode. In
// production, chat fixture URLs still go through Clerk before the page can
// render a fixture profile.
const fixtureAppShellPatterns = [
  '/admin(.*)',
  '/businesses(.*)',
  '/chat(.*)',
  '/command(.*)',
  '/dashboard(.*)',
  '/decisions(.*)',
  '/flight(.*)',
  '/goals(.*)',
  '/initiatives(.*)',
  '/learn(.*)',
  '/milestones(.*)',
  '/people(.*)',
  '/plans(.*)',
  '/projects(.*)',
  '/runs(.*)',
  '/settings(.*)',
  '/surfaces(.*)',
  '/tasks(.*)',
  '/timeline(.*)',
  '/today(.*)',
  '/workstreams(.*)',
  '/workspace-hub(.*)',
];

const fixturePublicPatterns =
  isFixtureMode || isDev
    ? [
        '/api/benchmark(.*)',
        '/api/artifacts(.*)',
        // Fixture preview pages (static fixtures only). Public in local dev
        // and fixture QA; in production they require auth like any app page.
        '/dev(.*)',
        ...(isFixtureMode
          ? [
              // Fixture mode is the product-UX lane: let every app-shell
              // surface and same-origin API reach the route handler so the
              // server-side fixture request context can provide the user.
              // Production is unaffected because this branch only exists
              // behind TEST_FIXTURES/NEXT_PUBLIC_TEST_FIXTURES.
              ...fixtureAppShellPatterns,
              '/api(.*)',
              '/orgx/api(.*)',
              '/artifacts(.*)',
              '/onboarding(.*)',
              '/dev(.*)',
            ]
          : []),
      ]
    : [];

const FIXTURE_COOKIE_NAME = 'orgx_fixture_profile';
const FIXTURE_QUERY_PARAM = 'fixture';

function normalizeFixtureProfileString(
  raw: string | null | undefined
): string | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (isFixtureProfile(lower)) return lower;
  return null;
}

/**
 * When running in fixture mode and the URL carries `?fixture=new|veteran`,
 * stamp a cookie so subsequent navigations pick the same profile.
 * Safe no-op when fixtures are off or the param is absent/invalid.
 */
function writeFixtureProfileCookie(req: any, res: any): void {
  if (!isFixtureMode) return;
  const raw = req.nextUrl?.searchParams?.get(FIXTURE_QUERY_PARAM);
  const profile = normalizeFixtureProfileString(raw);
  if (!profile) return;
  res.cookies.set(FIXTURE_COOKIE_NAME, profile, {
    httpOnly: false,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

const isPublicRoute = createRouteMatcher([
  '/',
  '/try', // Prepared continuity example; no workspace data or mutations.
  '/benchmark(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/pricing(.*)',
  '/product(.*)',
  '/ai-agent-operating-system(.*)',
  '/founder-operating-system(.*)',
  '/agents(.*)',
  '/use-cases(.*)',
  // Forward Deployed "Deployment Debrief" — public, no-auth free tool + its API.
  '/fde(.*)',
  '/api/fde(.*)',
  // Post-checkout emergence page — verifies the Stripe session server-side.
  // Kept public so a user whose Clerk session lapsed mid-checkout still sees
  // the activation moment instead of bouncing through sign-in.
  '/checkout/success(.*)',
  '/ecosystem(.*)',
  '/install(.*)',
  '/auth/cli(.*)',
  '/auth/mcp/callback(.*)',
  // The callback page calls this route after Clerk has loaded in-browser.
  // Keep middleware out so stale/mismatched Clerk cookies return stable JSON
  // from the handler instead of a redirect/failure-card loop.
  '/api/auth/mcp/identity-token(.*)',
  // Council checkpoints are background/keepalive writes. Let the route's
  // requireAuth() return stable JSON instead of allowing auth.protect() to
  // turn a valid in-room retry into a NEXT_REDIRECT response.
  '/api/voice/session-log(.*)',
  '/connect/openclaw(.*)',
  '/changelog(.*)',
  '/blog(.*)',
  '/benchmarks(.*)',
  '/audit(.*)',
  '/hq(.*)',
  '/calculator(.*)',
  '/contact(.*)',
  // Public proof-review booking form; submits to the allowlisted capture API.
  '/book(.*)',
  // Exact public delivery endpoint for the contact page. The route is bounded,
  // fixed-recipient, rate-limited, and performs no workspace mutation.
  '/api/contact',
  '/careers(.*)',
  '/features(.*)',
  '/founding(.*)',
  '/status(.*)',
  // NOTE: /design-system removed from public routes - developer access required
  '/docs(.*)',
  // Public SEO guides - separate from /learn which requires auth for playbooks
  '/glossary(.*)',
  '/guides(.*)',
  '/for(.*)',
  '/for-agents(.*)',
  '/agent-work-receipts(.*)',
  // Public fix pages from @useorgx/trail: rule text plus effect aggregated across adopters, shown only above a
  // minimum adopter count (lib/trail/fixes.ts). Counts only; no adopter identity. The GET API is public too.
  '/trail/fixes(.*)',
  '/api/v1/trail/fixes(.*)',
  // Static credits page for @useorgx/trail: the prior work it is built on. No data.
  '/trail/credits',
  // Static explainers: the Friday Wall Clinic and measuring a context layer (HQ). No data.
  '/trail/clinic',
  '/trail/measure-hq',
  // Public machine-discovery surfaces. These extensions are intentionally
  // included in the middleware matcher, so they must be allowlisted here or
  // Clerk turns standards-based discovery into an authentication response.
  '/agent',
  '/llms.txt',
  '/llms-full.txt',
  '/openapi.yaml',
  '/schemas/agent-work-receipt/v0.1/schema.json',
  '/schemas/agent-work-receipt/v0.2/schema.json',
  '/api/v1/openapi.yaml',
  // Account-free receipt validation and workload diagnosis. Keep these exact:
  // receipt ingestion and every other /api/v1 route retain their own auth gate.
  '/api/v1/agent-work-receipts/validate',
  '/api/v1/doctor/workload',
  // Account-free v1 discovery documents: the error-code registry, the request
  // schemas, and the closed vocabularies. Compiled constants with no tenant
  // content — a developer needs them before they hold a working credential,
  // and the error registry has to answer while a dependency is failing. Exact
  // paths, no wildcard.
  '/api/v1/errors',
  '/api/v1/meta/schemas',
  '/api/v1/meta/enums',
  // Measured service levels (plan v3 Stage 4): aggregate latency and error
  // rates only, so any agent can check them against its own experience.
  '/api/v1/service-levels',
  // Codex-compatible remote agent message boards. Codex agents present a
  // board session credential (oxb_…), not a Clerk session or an oxk_ key, so
  // Clerk must not answer for them. Every handler under this prefix
  // authenticates the request itself — owner API key for board admin, HMAC
  // session token for board calls — and returns tenant data only after that
  // (lib/server/agentBoards/http.ts).
  '/api/v1/agent-message-board/v1/boards/(.*)',
  '/llm-discovery(.*)',
  '/mcp(.*)',
  '/support(.*)',
  '/privacy(.*)',
  '/terms(.*)',
  '/security(.*)',
  '/sub-processors(.*)',
  '/roadmap(.*)',
  '/appsumo(.*)',
  // SEO/Marketing pages - must be public for search engines and LLMs
  '/compare(.*)',
  '/vs',
  '/about(.*)',
  '/landing(.*)',
  '/amplify(.*)',
  '/amplify-100x(.*)',
  '/aq(.*)',
  // Four-lens verification story — every claim links to a live receipt.
  '/verification(.*)',
  // Surface 100x verification surface — public so design QA can render
  // every primitive against fixture data without auth. See
  // docs/initiatives/surface-100x/ for context.
  '/surface-100x(.*)',
  '/red-dot(.*)',
  '/integrations(.*)',
  '/skip-the-hire(.*)',
  '/tools(.*)',
  // /launch — public canonical artifact for "Decisions on Rails" (the film
  // is one export of this page). No auth gate; CTAs link out.
  '/launch(.*)',
  '/live(.*)',
  // Branded artifact print/export page. Public so viewers on a public live
  // link can export to PDF; the page itself fails CLOSED — anonymous access
  // requires a valid ?live_initiative_id that resolves through
  // canReadArtifactFromPublicLiveLink (same gate as the artifact document
  // proxy), otherwise it 404s.
  '/artifacts/(.*)/print',
  // Media proxy for artifact previews on public live/proof rooms. Safe to be
  // public: the handler fails CLOSED on a host allowlist (+ protocol/port/IP
  // checks, manual redirects) so it can only serve known media hosts — without
  // this, every image on a logged-out live room 401s.
  '/api/media/proxy(.*)',
  // Co-branded proof rooms are shareable client-facing surfaces (same posture
  // as /live). Access is gated inside the route handler: public initiative OR a
  // valid signed share token OR owner. The owner-only share-link issuer at
  // /api/v1/proof/.../share-link stays protected (it starts with /api).
  '/proof(.*)',
  // Synthetic demo run drill-downs use stable `run-*` ids and contain
  // fixture data only. Real UUID-backed run pages remain behind auth.
  '/runs/run-(.*)',
  // Public Work Graph readouts are consented, redacted audit artifacts.
  // Claiming them during signup happens through the authenticated
  // /api/work-graph/claim route; the readout itself must stay public.
  '/work-graph(.*)',
  '/api/work-graph/readout(.*)',
  // Public readiness scoreboard — declared @authz-public in the route
  // header. Strict path match (no wildcard) since this is the only
  // launch-readiness endpoint.
  '/api/launch-readiness',
  '/icon(.*)',
  '/favicon.ico',
  // Social unfurl cards. X, LinkedIn, Slack and Discord fetch these with no
  // cookies; without an explicit allowlist entry Clerk 307s the crawler to
  // /sign-in and the link renders with no image at all. Both routes are pure
  // renderers over static copy — they read no request or workspace state.
  '/opengraph-image(.*)',
  '/twitter-image(.*)',
  '/robots.txt',
  '/sitemap.xml',
  '/.well-known(.*)',
  '/performance',
  // Studio - public for conversion (try before buy)
  '/studio(.*)',
  '/api/studio(.*)',
  '/api/status(.*)',
  // Amplify public conversion endpoints
  '/api/amplify/readiness-audit(.*)',
  '/api/amplify/live-demo/plan(.*)',
  '/api/amplify/proposal/quote(.*)',
  '/api/amplify/lead(.*)',
  '/api/amplify/checkout(.*)',
  '/api/amplify/download(.*)',
  '/api/pilot/checkout(.*)',
  '/api/v1/prospects/capture(.*)',
  // Launch-week public surfaces — gated by their own server-side checks
  // (Stripe signature for /webhooks/stripe, HMAC for /webhooks/calcom,
  // owner-only RLS via service-role client for waitlist + support).
  '/api/waitlist(.*)',
  '/api/support/report(.*)',
  '/api/founding/checkout(.*)',
  '/api/webhooks/stripe(.*)',
  '/api/webhooks/calcom(.*)',
  '/api/webhooks/resend(.*)',
  '/api/webhooks/recall(.*)',
  // Recall Output Media runs this page in the bot's isolated browser. The
  // runtime API authenticates every request with a short-lived meeting token.
  '/council-bot(.*)',
  '/api/coworker/council/meeting-bot/bootstrap(.*)',
  '/api/coworker/council/meeting-bot/runtime(.*)',
  // Red Dot public initiative surfaces
  '/api/red-dot/public(.*)',
  '/api/red-dot/outreach-kit(.*)',
  '/api/red-dot/replace-first-hire(.*)',
  '/api/red-dot/sensing(.*)',
  '/api/orgxgithubapp/auth(.*)',
  '/api/orgxgithubapp/webhook(.*)',
  '/api/github/app/webhook(.*)',
  // Public webhook ingress — gated by its own `x-report-fix-secret`
  // header check inside the route handler, not by Clerk auth.
  '/api/webhooks/fix-detected(.*)',
  // Reviewer landing pages + API — auth is the reviewer-session cookie,
  // not Clerk. Anthropic/OpenAI directory reviewers have no Clerk account.
  '/review/(.*)',
  '/api/review/sessions/(.*)',
  // Admin mint/rotate/revoke API — gated by ORGX_REVIEW_ADMIN_KEY header,
  // not Clerk. Used by scripts/review-session.ts from operator laptops.
  '/api/admin/review/sessions(.*)',
  // Dev-only public routes when Clerk is not configured
  ...devOnlyPublicPatterns,
  // Fixture-only routes for browser QA and benchmark lab previews
  ...fixturePublicPatterns,
]);

/**
 * Generate a request ID for tracing
 * Edge-safe and independent of Node-only crypto shims.
 */
function generateRequestId(): string {
  const cryptoObj =
    typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

  if (typeof cryptoObj?.randomUUID === 'function') {
    return `req_${cryptoObj.randomUUID()}`;
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return `req_${hex.join('')}`;
  }

  return `req_${Date.now().toString(16)}_${Math.random()
    .toString(16)
    .slice(2, 10)}`;
}

const PUBLIC_API_DOCS_ORIGINS = new Set([
  DOCS_CANONICAL_ORIGIN,
  ...(isDev ? ['http://localhost:3000', 'http://localhost:3001'] : []),
]);

function apiDocsOrigin(request: NextRequest): string | null {
  if (!request.nextUrl.pathname.startsWith('/api/v1/')) return null;
  const origin = request.headers.get('origin');
  return origin && PUBLIC_API_DOCS_ORIGINS.has(origin) ? origin : null;
}

function applyApiDocsCors(
  request: NextRequest,
  response: NextResponse
): NextResponse {
  const origin = apiDocsOrigin(request);
  if (!origin) return response;
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.append('Vary', 'Origin');
  response.headers.set(
    'Access-Control-Expose-Headers',
    'Retry-After, X-Request-ID, X-Correlation-ID'
  );
  return response;
}

function apiDocsPreflightResponse(
  request: NextRequest,
  requestId: string
): NextResponse | null {
  const origin = apiDocsOrigin(request);
  if (!origin || request.method !== 'OPTIONS') return null;
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('x-request-id', requestId);
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Idempotency-Key'
  );
  response.headers.set('Access-Control-Max-Age', '600');
  response.headers.append('Vary', 'Origin');
  return response;
}

function getRequestHostname(request: Request): string | null {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host =
    forwardedHost?.split(',')[0]?.trim() || request.headers.get('host') || null;

  return host?.split(':')[0]?.toLowerCase() ?? null;
}

function maybeRedirectLegacyDocsHost(request: any) {
  const hostname = getRequestHostname(request);
  if (!hostname || !LEGACY_DOCS_HOSTNAMES.has(hostname)) return null;

  const target = new URL(
    resolveLegacyDocsPathname(request.nextUrl.pathname),
    DOCS_CANONICAL_ORIGIN
  );
  target.search = request.nextUrl.search;

  return NextResponse.redirect(target, 308);
}

function maybeRedirectMainDocsPath(request: any) {
  const hostname = getRequestHostname(request);
  if (hostname === DOCS_CANONICAL_HOSTNAME) return null;
  if (!isDocsPathname(request.nextUrl.pathname)) return null;

  const target = new URL(
    resolveLegacyDocsPathname(request.nextUrl.pathname),
    DOCS_CANONICAL_ORIGIN
  );
  target.search = request.nextUrl.search;

  return NextResponse.redirect(target, 308);
}

function maybeRedirectDocs(request: any) {
  return (
    maybeRedirectLegacyDocsHost(request) ?? maybeRedirectMainDocsPath(request)
  );
}

function isolatedCouncilSurfaceResponse(req: any, requestId: string) {
  if (req.nextUrl.pathname !== '/council-bot') return null;
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-orgx-isolated-surface', 'council-bot');
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-auth-type', 'council-runtime-cookie');
  response.headers.set('cache-control', 'no-store, private');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set(
    'content-security-policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.openai.com wss://api.openai.com https://*.openai.com wss://*.openai.com; media-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'"
  );
  return response;
}

/**
 * Proof Room bearer grants must never enter the normal app analytics shell.
 * The opaque path segment and the legacy `?t=` value are credentials, not
 * navigation dimensions. Isolate both before React, Sentry replay, PostHog,
 * Meta Pixel, or referrer propagation can observe the request URL.
 */
function isProofRoomPacketGrantPathname(pathname: string): boolean {
  return (
    pathname.startsWith('/proof/shared/') ||
    pathname.startsWith('/api/proof-room/shared/')
  );
}

function isolatedProofRoomSurfaceResponse(req: any, requestId: string) {
  const pathname = req.nextUrl.pathname;
  const packetGrant = isProofRoomPacketGrantPathname(pathname);
  const legacyGrant =
    pathname.startsWith('/proof/') && req.nextUrl.searchParams.has('t');
  if (!packetGrant && !legacyGrant) return null;

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-orgx-isolated-surface', 'proof-room-share');
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-auth-type', 'proof-room-grant');
  response.headers.set('cache-control', 'no-store, private');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  response.headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline'${
      isDev ? " 'unsafe-eval'" : ''
    }; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`
  );
  return response;
}

function publicRouteResponse(
  req: NextRequest,
  requestId: string,
  authType?: string
) {
  const authSurface = isAuthSurfacePath(req.nextUrl.pathname);
  const requestHeaders = authSurface ? new Headers(req.headers) : null;
  requestHeaders?.set('x-orgx-auth-surface', '1');

  const response = requestHeaders
    ? NextResponse.next({ request: { headers: requestHeaders } })
    : NextResponse.next();
  response.headers.set('x-request-id', requestId);
  if (authType) response.headers.set('x-auth-type', authType);

  writeFixtureProfileCookie(req, response);
  return response;
}

/**
 * Service-key admission. The key is compared in full here — a bearer that only
 * looks like the service key must never skip Clerk. See serviceKeyRoutes.ts.
 */
function serviceKeyApiResponse(
  req: NextRequest,
  requestId: string
): NextResponse | null {
  if (!req.nextUrl.pathname.startsWith('/api/')) return null;
  const bearer = classifyServiceKeyBearer(req, req.nextUrl.pathname);
  if (bearer === 'absent') return null;
  if (bearer === 'invalid') {
    const response = NextResponse.json(
      { error: { code: 'unauthorized', message: 'Invalid service key' } },
      { status: 401 }
    );
    response.headers.set('x-request-id', requestId);
    return response;
  }
  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-auth-type', 'service-key');
  return response;
}

async function fallbackMiddleware(req: any) {
  const pathname = req.nextUrl.pathname;

  const docsRedirect = maybeRedirectDocs(req);
  if (docsRedirect) return docsRedirect;

  const requestId = req.headers.get('x-request-id') || generateRequestId();

  const apiDocsPreflight = apiDocsPreflightResponse(req, requestId);
  if (apiDocsPreflight) return apiDocsPreflight;

  const councilSurface = isolatedCouncilSurfaceResponse(req, requestId);
  if (councilSurface) return councilSurface;

  const proofRoomSurface = isolatedProofRoomSurfaceResponse(req, requestId);
  if (proofRoomSurface) return proofRoomSurface;

  if (
    isInfraRequestPathname(pathname, { isDev, hasClerkSecretKey }) ||
    isPublicRoute(req)
  ) {
    return publicRouteResponse(req, requestId, 'anonymous');
  }

  const serviceKeyResponse = serviceKeyApiResponse(req, requestId);
  if (serviceKeyResponse) return serviceKeyResponse;

  if (
    (pathname.startsWith('/api/v1/') ||
      pathname.startsWith('/api/client/') ||
      isApiKeyIngestionPath(pathname)) &&
    hasLikelyApiKey(req)
  ) {
    const response = NextResponse.next();
    response.headers.set('x-request-id', requestId);
    response.headers.set('x-auth-type', 'api-key');
    return applyApiDocsCors(req, response);
  }

  // If Clerk isn't configured, allow the request through (dev + fixture envs).
  // Route handlers still enforce service key / api key auth where required.
  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);
  response.headers.set('x-auth-type', 'passthrough');
  writeFixtureProfileCookie(req, response);
  return response;
}

const PUBLIC_LIVE_DEMO_ARTIFACT_IDS = new Set([
  'art-strategy-brief-001',
  'art-brand-guidelines-002',
  'art-technical-spec-003',
  'art-campaign-brief-004',
  'art-competitive-analysis-005',
  'art-product-roadmap-006',
  'art-sales-playbook-007',
  'art-design-mockup-008',
  'art-launch-key-art-009',
  'art-social-proof-010',
  'art-mobile-story-011',
]);

function isPublicLiveDemoArtifactPath(pathname: string): boolean {
  const pageMatch = pathname.match(/^\/artifacts\/([^/]+)$/);
  if (pageMatch?.[1]) {
    const artifactId = decodeURIComponent(pageMatch[1]);
    return (
      PUBLIC_LIVE_DEMO_ARTIFACT_IDS.has(artifactId) ||
      ((isDev || isFixtureMode) && artifactId.startsWith('fixture-'))
    );
  }

  const artifactMatch = pathname.match(
    /^\/(?:orgx\/)?api\/artifacts\/([^/]+)$/
  );
  if (artifactMatch?.[1]) {
    const artifactId = decodeURIComponent(artifactMatch[1]);
    return (
      PUBLIC_LIVE_DEMO_ARTIFACT_IDS.has(artifactId) ||
      ((isDev || isFixtureMode) && artifactId.startsWith('fixture-'))
    );
  }

  return pathname === '/api/telemetry/artifacts';
}

function shouldBypassClerkMiddleware(pathname: string): boolean {
  return (
    // Live rooms are shareable public surfaces. Keep Clerk out of the initial
    // document request so stale or mismatched session cookies cannot block
    // public viewers; route/API handlers still enforce write permissions.
    pathname === '/live' ||
    pathname.startsWith('/live/') ||
    pathname.startsWith('/live/demo') ||
    // Packet-bound read/export/response APIs authenticate the opaque bearer
    // grant in their route handlers and need no Clerk identity. Ordinary owner
    // rooms and legacy email-gated links MUST run through clerkMiddleware so
    // getUserContext() can read the decorated request; isPublicRoute still
    // prevents an auth redirect for anonymous recipients.
    isProofRoomPacketGrantPathname(pathname) ||
    isPublicLiveReadApiPath(pathname) ||
    pathname.startsWith('/dev') ||
    pathname.startsWith('/blog') ||
    // Rich Work Graph audit publishes can carry large JSON evidence summaries.
    // Keep Clerk out of this stream; route-level API key auth is authoritative.
    pathname.startsWith('/api/v1/work-graph/reports') ||
    pathname.startsWith('/api/client/work-graph/reports') ||
    isPublicLiveDemoArtifactPath(pathname)
  );
}

function isPublicLiveReadApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/live/')) return false;
  return pathname.endsWith('/timeline') || pathname.endsWith('/processing');
}

const clerkProtectedMiddleware = shouldUseClerk
  ? clerkMiddleware(
      async (auth, req) => {
        const pathname = req.nextUrl.pathname;

        const docsRedirect = maybeRedirectDocs(req);
        if (docsRedirect) return docsRedirect;

        // Generate or extract request ID
        const requestId =
          req.headers.get('x-request-id') || generateRequestId();

        const apiDocsPreflight = apiDocsPreflightResponse(req, requestId);
        if (apiDocsPreflight) return apiDocsPreflight;

        const councilSurface = isolatedCouncilSurfaceResponse(req, requestId);
        if (councilSurface) return councilSurface;

        const proofRoomSurface = isolatedProofRoomSurfaceResponse(
          req,
          requestId
        );
        if (proofRoomSurface) return proofRoomSurface;

        // For infra/public routes, just add headers and continue
        if (
          isInfraRequestPathname(pathname, { isDev, hasClerkSecretKey }) ||
          isPublicRoute(req)
        ) {
          return publicRouteResponse(req, requestId);
        }

        // Service-key requests (MCP worker, internal services) skip Clerk only
        // after an exact match here; a look-alike bearer gets a JSON 401.
        const serviceKeyResponse = serviceKeyApiResponse(req, requestId);
        if (serviceKeyResponse) return serviceKeyResponse;

        // Allow per-user API key requests for the versioned REST API and its
        // temporary compatibility alias. Route handlers still enforce full
        // API-key authentication.
        if (
          (pathname.startsWith('/api/v1/') ||
            pathname.startsWith('/api/client/') ||
            isApiKeyIngestionPath(pathname)) &&
          hasLikelyApiKey(req)
        ) {
          const response = NextResponse.next();
          response.headers.set('x-request-id', requestId);
          response.headers.set('x-auth-type', 'api-key');
          return applyApiDocsCors(req, response);
        }

        try {
          await auth.protect();

          // Onboarding gate — once the user is authenticated, make sure they
          // have either completed or explicitly deferred the first-run journey
          // before landing on app-shell pages.
          // We deliberately do NOT hit the database from middleware: we rely on
          // completion/session-deferred cookies written by onboarding route
          // handlers. If both cookies are missing on an app-shell route,
          // bounce the user to `/onboarding`, which performs the authoritative
          // DB check server-side and either renders the journey or forwards to
          // /command with the cookie freshly set.
          if (
            isAppShellRoute(pathname) &&
            !isOnboardingExempt(pathname) &&
            !hasOnboardingAccess(req)
          ) {
            const target = req.nextUrl.clone();
            target.pathname = '/onboarding';
            target.search = '';
            // Keep where the user was going. Without this, an established
            // user on a fresh browser asking for /settings/quality was
            // graduated straight to /command and lost the deep link.
            const returnPath = safeOnboardingReturnPath(
              `${pathname}${req.nextUrl.search}`
            );
            if (returnPath) {
              target.searchParams.set(ONBOARDING_NEXT_PARAM, returnPath);
            }
            const response = NextResponse.redirect(target);
            response.headers.set('x-request-id', requestId);
            response.headers.set('x-onboarding-gate', 'redirect');
            return response;
          }

          // Add request ID to successful auth responses
          const response = NextResponse.next();
          response.headers.set('x-request-id', requestId);
          return response;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const logFn = reason.includes('NEXT_HTTP_ERROR_FALLBACK')
            ? edgeLogger.debug
            : edgeLogger.warn;

          logFn('[middleware] request blocked', {
            path: req.nextUrl.pathname,
            method: req.method,
            requestId,
            reason,
          });
          // For API routes, return a clear JSON 401 instead of Clerk's HTML/404 fallback.
          if (pathname.startsWith('/api/')) {
            const response = NextResponse.json(
              {
                error: {
                  code: 'unauthorized',
                  message: 'Authentication required',
                },
              },
              { status: 401 }
            );
            response.headers.set('x-request-id', requestId);
            return response;
          }

          throw error;
        }
      },
      {
        // Route unauthenticated users to the app's own sign-in UI instead of
        // Clerk's hosted accounts.dev page. Without this, auth.protect() falls
        // back to the Clerk instance default, which on dev was breaking out of
        // the app shell into accounts.dev.
        signInUrl: '/sign-in',
        signUpUrl: '/sign-up',
      }
    )
  : fallbackMiddleware;

export default function middleware(req: any, event: any) {
  const pathname = req.nextUrl?.pathname ?? '';
  if (isSensitiveDotfileProbePathname(pathname)) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (shouldBypassClerkMiddleware(pathname)) {
    return fallbackMiddleware(req);
  }

  return clerkProtectedMiddleware(req, event);
}

export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!monitoring|_next/static|_next/image|x-observe|favicon.ico|site.webmanifest|manifest.json|live/demo|runs/run-|blog|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};
