import {
  createClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import type { Database } from '@/types/database';
import { logger } from '@/lib/logger';
import {
  getSupabaseErrorMessage,
  isSupabaseAuthDuplicateUserError,
} from '@/lib/supabaseErrors';

export { isSupabaseAuthDuplicateUserError };

/**
 * Resolve the Supabase config for the current runtime.
 *
 * Fixture-mode override: when `TEST_FIXTURES=1` (or the browser equivalent)
 * is set AND `LOCAL_SUPABASE_URL` / `LOCAL_SUPABASE_ANON_KEY` /
 * `LOCAL_SUPABASE_SERVICE_ROLE_KEY` are all present, prefer those over the
 * prod `NEXT_PUBLIC_SUPABASE_*` + `SUPABASE_SERVICE_ROLE_KEY` values. This
 * lets a developer run `pnpm exec supabase start` locally, load the local
 * keys via `.env.fixtures`, and have the Next.js dev server talk to the
 * LOCAL Supabase instance without ever touching `.env.local`.
 *
 * When any local var is missing, the override is a no-op (so real users,
 * prod, and CI continue to read the prod vars exactly as before).
 */
export function resolveSupabaseConfig(): {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  const prodUrl = firstConfiguredEnv(
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_URL'
  );
  const prodAnon = firstConfiguredEnv(
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY'
  );
  const prodService = firstConfiguredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const fixtureOn =
    process.env.TEST_FIXTURES === '1' ||
    process.env.NEXT_PUBLIC_TEST_FIXTURES === '1';
  if (!fixtureOn) {
    return { url: prodUrl, anonKey: prodAnon, serviceRoleKey: prodService };
  }

  const localUrl = process.env.LOCAL_SUPABASE_URL?.trim() ?? '';
  const localAnon = process.env.LOCAL_SUPABASE_ANON_KEY?.trim() ?? '';
  const localService =
    process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';

  // Only swap when ALL three locals are present — partial override would be
  // silently wrong (e.g. prod URL + local service role key points clients at
  // prod but gives them the wrong service-role JWT).
  if (localUrl && localAnon && localService) {
    return {
      url: localUrl,
      anonKey: localAnon,
      serviceRoleKey: localService,
    };
  }

  return { url: prodUrl, anonKey: prodAnon, serviceRoleKey: prodService };
}

function firstConfiguredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim() ?? '';
    if (!value) continue;
    if (/^your[_-]supabase/i.test(value)) continue;
    return value;
  }
  return '';
}

const resolvedConfig = resolveSupabaseConfig();
const supabaseUrl = resolvedConfig.url;
const supabaseAnonKey = resolvedConfig.anonKey;
const serviceRoleKey = resolvedConfig.serviceRoleKey;
const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET || '';
const hasSupabaseClientConfig = Boolean(supabaseUrl && supabaseAnonKey);
const hasSupabaseAuthConfig = Boolean(
  hasSupabaseClientConfig && supabaseJwtSecret
);
const hasSupabaseAdminConfig = Boolean(
  hasSupabaseClientConfig && serviceRoleKey
);
const supabaseJwtTtlSeconds = Math.max(
  parseInt(process.env.SUPABASE_JWT_TTL_SECONDS || '300', 10),
  60
);
const isProduction = process.env.NODE_ENV === 'production';
const isFixtureMode =
  process.env.TEST_FIXTURES === '1' ||
  process.env.NEXT_PUBLIC_TEST_FIXTURES === '1';

function decodeBase64Url(input: string): string | null {
  try {
    const normalized = input
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(input.length / 4) * 4, '=');
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(normalized, 'base64').toString('utf8');
    }
    if (typeof atob !== 'undefined') {
      return atob(normalized);
    }
  } catch {
    // ignore
  }
  return null;
}

function extractProjectRefFromKey(key: string): string | null {
  const parts = key.split('.');
  if (parts.length < 2) return null;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed?.ref === 'string' ? parsed.ref : null;
  } catch {
    return null;
  }
}

function extractProjectRefFromUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const [ref] = hostname.split('.');
    return ref || null;
  } catch {
    return null;
  }
}

let hasLoggedSupabaseMismatch = false;

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const RESOLVED_USER_CACHE_TTL_MS = isFixtureMode ? 0 : 5 * 60 * 1000;
const resolvedUserCache = new Map<
  string,
  { value: string; expiresAt: number }
>();

// How recent a `users` row must be for its first external_id claim to count as
// a signup. The claim itself is once-per-account, but 23 of the 69 prod rows
// are legacy fixture/test accounts predating the external_id column and have
// never been claimed (verified 2026-07-25); without this bound, one of them
// logging in would emit a signup dated today.
const SIGNUP_FUNNEL_MAX_PROFILE_AGE_MS = 24 * 60 * 60 * 1000;

// Hard ceiling on the PostHog round trip that hangs off signup. Provisioning a
// user must never wait on an analytics vendor: past this bound we stop waiting
// and let the in-flight send finish on its own.
const SIGNUP_FUNNEL_TELEMETRY_TIMEOUT_MS = 1_500;

// In-flight deduplication: prevent multiple concurrent resolution calls for the same user
const inFlightResolutions = new Map<string, Promise<string | null>>();

const FORGED_TOKEN_CACHE_TTL_MS = isFixtureMode ? 0 : 4 * 60 * 1000; // 4 minutes (slightly less than JWT TTL)
const forgedTokenCache = new Map<
  string,
  { token: string; user: ResolvedAuthUser; expiresAt: number }
>();

type ResolvedAuthUser = {
  id: string;
  email?: string | null;
  fullName?: string | null;
  externalId?: string | null;
};

type ResolvedAuthToken = {
  token: string | null;
  user: ResolvedAuthUser | null;
};

// Reduce noisy logs when a Clerk token template isn't configured in dev
let hasLoggedMissingClerkTemplate = false;

function getSupabaseJwtSecret(): string {
  return process.env.SUPABASE_JWT_SECRET || supabaseJwtSecret;
}

function logEnvWarning(message: string) {
  if (!isProduction) {
    logger.warn('[env] warning', { message });
  }
}

// Minimal no-op mock used only in development when env is missing
function createNoopClient() {
  const unsubscribe = () => {};
  const readResult = { data: [] as any[], error: null };
  const singleResult = { data: null, error: null };
  const builder = (): any => {
    const chain: any = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
      eq: () => chain,
      gte: () => chain,
      gt: () => chain,
      lt: () => chain,
      lte: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      or: () => chain,
      filter: () => chain,
      match: () => chain,
      single: () => Promise.resolve(singleResult),
      maybeSingle: () => Promise.resolve(singleResult),
      then: (resolve: any) => Promise.resolve(readResult).then(resolve),
      catch: (reject: any) => Promise.resolve(readResult).catch(reject),
    };
    return chain;
  };
  const stub = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }),
      signOut: async () => ({ error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => builder(),
    rpc: async () => ({ data: null, error: null }),
  } as any;
  return stub as unknown as SupabaseClient<any, 'public'>;
}

// For client-side usage
export const createSupabaseClient = (): SupabaseClient<any, 'public'> => {
  if (!supabaseUrl || !supabaseAnonKey) {
    if (isProduction) {
      throw new Error(
        'Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY)'
      );
    }
    logEnvWarning('Supabase env missing; using no-op client in development');
    return createNoopClient();
  }
  return createBrowserClient<Database>(
    supabaseUrl,
    supabaseAnonKey
  ) as unknown as SupabaseClient<any, 'public'>;
};

function base64UrlEncode(value: string | Uint8Array | ArrayBuffer | Buffer) {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.isBuffer(value)
      ? value
      : Buffer.from(
          value instanceof ArrayBuffer ? new Uint8Array(value) : value
        );
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;

  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function signJwtHS256(
  payload: Record<string, unknown>,
  secret: string
) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;

  const runtimeCrypto =
    typeof globalThis !== 'undefined'
      ? (globalThis as typeof globalThis & { crypto?: Crypto }).crypto
      : undefined;

  if (runtimeCrypto?.subtle) {
    try {
      const encoder = new TextEncoder();
      const key = await runtimeCrypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signature = await runtimeCrypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(data)
      );
      return `${header}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
    } catch (error) {
      if (!isProduction) {
        logger.warn('[supabase] web crypto jwt signing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const error = new Error(
    'Web Crypto API is not available in this environment'
  );
  if (!isProduction) {
    logger.warn('[supabase] crypto unavailable for JWT signing', {
      runtime:
        typeof globalThis !== 'undefined' &&
        typeof (globalThis as typeof globalThis & { EdgeRuntime?: unknown })
          .EdgeRuntime === 'string'
          ? 'edge'
          : 'server',
    });
  }
  throw error;
}

function extractEmailFromClaims(claims: unknown): string | null {
  if (!claims || typeof claims !== 'object') return null;
  const candidateKeys = ['email', 'email_address', 'primary_email_address'];
  const record = claims as Record<string, unknown>;
  for (const key of candidateKeys) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  const emailAddresses = record['email_addresses'];
  if (Array.isArray(emailAddresses)) {
    const first = emailAddresses.find((entry) => typeof entry === 'string') as
      | string
      | undefined;
    if (first) return first;
  }
  return null;
}

type ResolveUserOptions = {
  email?: string | null;
  /** Unverified emails never link to an existing row. See auth/clerkEmail.ts. */
  emailVerified?: boolean;
  fullName?: string | null;
  avatarUrl?: string | null;
  createIfMissing?: boolean;
};

export async function resolveSupabaseUserIdForExternal(
  externalId: string,
  {
    email,
    emailVerified = true,
    fullName,
    avatarUrl,
    createIfMissing = true,
  }: ResolveUserOptions = {}
): Promise<string | null> {
  if (!externalId) return null;

  const normalizedEmail = email?.toLowerCase() ?? null;
  const cacheKey = `${externalId}:${normalizedEmail ?? ''}:${
    emailVerified ? 'v' : 'u'
  }`;

  // Check cache first (fast path)
  if (RESOLVED_USER_CACHE_TTL_MS > 0) {
    const cached = resolvedUserCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  // Check if there's already an in-flight resolution for this user
  const inFlight = inFlightResolutions.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Start the resolution and track it
  const resolutionPromise = resolveSupabaseUserIdInternal(
    externalId,
    {
      email: normalizedEmail,
      emailVerified,
      fullName,
      avatarUrl,
      createIfMissing,
    },
    cacheKey
  );

  inFlightResolutions.set(cacheKey, resolutionPromise);

  try {
    return await resolutionPromise;
  } finally {
    inFlightResolutions.delete(cacheKey);
  }
}

async function resolveSupabaseUserIdInternal(
  externalId: string,
  {
    email,
    emailVerified,
    fullName,
    avatarUrl,
    createIfMissing,
  }: {
    email: string | null;
    emailVerified: boolean;
    fullName?: string | null;
    avatarUrl?: string | null;
    createIfMissing: boolean;
  },
  cacheKey: string
): Promise<string | null> {
  // Offline fixtures have no reachable `users` table, and the fixture owner id
  // (e.g. 00000000-…-0002) isn't a *versioned* UUID, so it fails the strict
  // UUID check below and would fall through to a Supabase query that blocks ~7s
  // on a TCP timeout. In offline mode the external id IS the user id — return it
  // directly. (This was the dominant cost in fixture page renders.)
  if (isOfflineFixtureDb()) return externalId || null;
  const admin = getSupabaseAdmin();
  if (!admin) {
    if (createIfMissing && !isProduction) {
      logger.warn(
        '[supabase] admin client unavailable; falling back to external id',
        {
          externalId,
        }
      );
    }
    if (!isProduction) {
      logger.debug('[supabase] resolve user (no admin client)', {
        externalIdIsUuid: UUID_REGEX.test(externalId),
      });
    }
    return UUID_REGEX.test(externalId) ? externalId : null;
  }

  if (!isProduction) {
    logger.debug('[supabase] resolve user with admin', {
      hasEmail: Boolean(email),
      createIfMissing,
    });
  }

  if (UUID_REGEX.test(externalId)) {
    // Rewriting users.email redirects later email links: verified only.
    if (email && emailVerified) {
      // Fire and forget - don't await this non-critical update
      admin
        .from('users')
        .update({ email })
        .eq('id', externalId)
        .neq('email', email)
        .then(() => {})
        .catch(() => {});
    }
    if (RESOLVED_USER_CACHE_TTL_MS > 0) {
      resolvedUserCache.set(cacheKey, {
        value: externalId,
        expiresAt: Date.now() + RESOLVED_USER_CACHE_TTL_MS,
      });
    }
    return externalId;
  }

  try {
    const { data: existingExternal } = await admin
      .from('users')
      .select('id')
      .eq('external_id', externalId)
      .maybeSingle();

    if (existingExternal?.id) {
      if (!isProduction) {
        logger.debug('[supabase] resolved user by external_id', { externalId });
      }
      if (RESOLVED_USER_CACHE_TTL_MS > 0) {
        resolvedUserCache.set(cacheKey, {
          value: existingExternal.id,
          expiresAt: Date.now() + RESOLVED_USER_CACHE_TTL_MS,
        });
      }
      return existingExternal.id;
    }

    // Fallback: additional external ids. users.external_id holds exactly one
    // provider id, but the same account is addressed by two Clerk instances
    // AND the MCP gateway. The no-steal guard below keeps the column stable
    // for whichever environment claimed it, so every other environment —
    // including email-less paths that can't use the email fallback — resolves
    // through this mapping. Incident: 2026-07-03, the workspace data-merge
    // repointed external_id to the live Clerk id and every MCP tool call
    // failed with "Unable to resolve user_id to a Supabase UUID".
    const { data: mappedExternal } = await admin
      .from('user_external_ids')
      .select('user_id')
      .eq('external_id', externalId)
      .maybeSingle();
    if (mappedExternal?.user_id) {
      if (!isProduction) {
        logger.debug('[supabase] resolved user by external-id mapping', {
          externalId,
        });
      }
      if (RESOLVED_USER_CACHE_TTL_MS > 0) {
        resolvedUserCache.set(cacheKey, {
          value: mappedExternal.user_id,
          expiresAt: Date.now() + RESOLVED_USER_CACHE_TTL_MS,
        });
      }
      return mappedExternal.user_id;
    }

    if (email && emailVerified) {
      const { data: existingByEmail } = await admin
        .from('users')
        // `created_at` is here for the signup-funnel age bound below: the 23
        // legacy rows with a null external_id are most likely to be claimed on
        // exactly this path, and claiming one is not a signup.
        .select('id, external_id, created_at')
        .eq('email', email)
        .maybeSingle();
      if (existingByEmail?.id) {
        if (!isProduction) {
          logger.debug('[supabase] resolved user by email', { email });
        }
        // Await this — API key auth resolves by external_id in a separate
        // request. A fire-and-forget here creates a race: the auth request
        // arrives before the update lands and resolves to null → 401.
        //
        // Only claim the column when it is empty. The same Supabase DB is
        // served by two Clerk instances (test locally, live on prod), so a
        // user has a different Clerk id per environment. Overwriting a
        // non-null external_id lets one environment steal the mapping from
        // the other; the losing environment then external_id-misses and, on
        // any email-less auth path (MCP gateway), gets pinned to a synthetic
        // @placeholder.local row that shadows the real account. Incident:
        // 2026-07-02, hopeatina's prod sessions saw only one workspace.
        // With the guard, the other environment still resolves correctly via
        // this email fallback on every request.
        if (!existingByEmail.external_id) {
          // This is the SECOND writer of users.external_id, and the reason the
          // signup emit cannot hang off the other one alone. Two parallel
          // requests for a brand-new account race like this: request A creates
          // the auth user (the handle_new_user trigger writes the profile row),
          // request B arrives a moment later, finds that row by email with a
          // null external_id, and claims it HERE. Request A then reads the
          // profile back, sees a non-null external_id, and skips its own claim
          // — so if only A could emit, the signup was lost for good. Route both
          // writers through the same atomic claim and let whoever wins report.
          const claimedFirstTouch = await claimUserExternalId({
            admin,
            supabaseUserId: existingByEmail.id,
            externalId,
          });
          if (claimedFirstTouch) {
            await recordSignupFunnelEventForFreshProfile({
              admin,
              supabaseUserId: existingByEmail.id,
              email,
              externalId,
              createdAt: existingByEmail.created_at,
            });
          }
        } else if (existingByEmail.external_id !== externalId) {
          // Self-heal: the column is claimed by another environment — record
          // this environment's id as an additional external id so email-less
          // paths (MCP gateway) resolve it via the mapping on every future
          // request. Best-effort: resolution already succeeded via email.
          try {
            await admin
              .from('user_external_ids')
              .upsert(
                { external_id: externalId, user_id: existingByEmail.id },
                { onConflict: 'external_id' }
              );
          } catch {
            // mapping table missing or transient failure — resolution still
            // succeeded; the next email-bearing request retries the heal.
          }
        }
        if (RESOLVED_USER_CACHE_TTL_MS > 0) {
          resolvedUserCache.set(cacheKey, {
            value: existingByEmail.id,
            expiresAt: Date.now() + RESOLVED_USER_CACHE_TTL_MS,
          });
        }
        return existingByEmail.id;
      }
    }

    if (!createIfMissing) {
      if (!isProduction) {
        logger.debug('[supabase] user not found and createIfMissing=false', {
          externalId,
          email,
        });
      }
      return null;
    }

    if (!email) {
      throw new Error(
        'Unable to resolve Supabase user id without email context'
      );
    }

    let supabaseUserId: string | null = null;

    // OPTIMIZATION: Skip slow listUsers() call (fetches 200 users).
    // Instead, try to create the auth user directly and recover from duplicate-email conflicts.
    try {
      const createResp = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          full_name: fullName ?? undefined,
          avatar_url: avatarUrl ?? undefined,
          external_id: externalId,
        },
      });
      if (createResp.data?.user) {
        supabaseUserId = createResp.data.user.id;
        if (!isProduction) {
          logger.debug('[supabase] created new auth user', {
            email,
            supabaseUserId,
          });
        }
      } else if (createResp.error) {
        // Unverified email + existing account: propagate (fail closed).
        if (
          isSupabaseAuthDuplicateUserError(createResp.error) &&
          emailVerified
        ) {
          try {
            const { data: existingUser } =
              await admin.auth.admin.getUserByEmail(email);
            if (existingUser?.user) {
              supabaseUserId = existingUser.user.id;
              if (!isProduction) {
                logger.debug(
                  '[supabase] resolved duplicate auth user conflict by email',
                  {
                    email,
                    supabaseUserId,
                  }
                );
              }
            }
          } catch (lookupError) {
            if (!isProduction) {
              logger.warn(
                '[supabase] getUserByEmail failed after duplicate auth conflict',
                {
                  email,
                  error: getSupabaseErrorMessage(lookupError),
                }
              );
            }
          }
        } else {
          if (!isProduction) {
            logger.error('[supabase] failed to create Supabase auth user', {
              email,
              error: getSupabaseErrorMessage(createResp.error),
            });
          }
          throw createResp.error;
        }
      }
    } catch (error) {
      const errorMessage = getSupabaseErrorMessage(error);

      // If user already exists, look them up via getUserByEmail (single user, fast)
      if (isSupabaseAuthDuplicateUserError(error) && emailVerified) {
        try {
          // Use getUserByEmail - much faster than listUsers
          const { data: existingUser } = await admin.auth.admin.getUserByEmail(
            email
          );
          if (existingUser?.user) {
            supabaseUserId = existingUser.user.id;
            if (!isProduction) {
              logger.debug('[supabase] found existing auth user by email', {
                email,
                supabaseUserId,
              });
            }
          }
        } catch (lookupError) {
          if (!isProduction) {
            logger.warn(
              '[supabase] getUserByEmail failed after create conflict',
              {
                email,
                error:
                  lookupError instanceof Error
                    ? lookupError.message
                    : String(lookupError),
              }
            );
          }
        }
      } else {
        if (!isProduction) {
          logger.error('[supabase] failed to create Supabase auth user', {
            email,
            error: errorMessage,
          });
        }
        throw error;
      }
    }

    if (!supabaseUserId) {
      return null;
    }

    const profileResponse = await admin
      .from('users')
      .select('id, email, external_id, full_name, avatar_url, created_at')
      .eq('id', supabaseUserId)
      .maybeSingle();

    // First-touch detection must NOT key off this row being absent. Prod has a
    // trigger `on_auth_user_created` on `auth.users` (`handle_new_user`) that
    // inserts the `public.users` row inside the same transaction as the auth
    // user, so by the time this SELECT runs the row already exists. Verified
    // 2026-07-25: for every account created since 07-19, `public.users.
    // created_at` *precedes* `auth.users.created_at` by 0.3–1.9ms. The insert
    // branch below therefore never runs against prod — it only covers a
    // database without that trigger (local/CI). Anything that must fire once
    // per signup has to hang off the claim in the `else` branch instead.
    if (!profileResponse.data) {
      const insertPayload: Database['public']['Tables']['users']['Insert'] = {
        id: supabaseUserId,
        email,
        full_name: fullName ?? null,
        avatar_url: avatarUrl ?? null,
        plan: 'free',
        external_id: externalId,
      };
      const { error: insertError } = await admin
        .from('users')
        .insert(insertPayload);
      if (insertError && insertError.code !== '23505') {
        throw insertError;
      }
      if (!insertError) {
        // We inserted the row ourselves, so this is unambiguously a new user.
        // Only reachable on a database without the `handle_new_user` trigger.
        await recordSignupFunnelEvent({
          admin,
          supabaseUserId,
          email,
          externalId,
        }).catch(() => {});
      }
    } else {
      // Only update external_id if missing. Other profile updates are handled by background sync (Inngest).
      if (!profileResponse.data.external_id) {
        // Await this — API key auth resolves by external_id in a separate
        // request. A fire-and-forget here creates a race: the auth request
        // arrives before the update lands and resolves to null → 401.
        const claimedFirstTouch = await claimUserExternalId({
          admin,
          supabaseUserId,
          externalId,
        });

        if (claimedFirstTouch) {
          await recordSignupFunnelEventForFreshProfile({
            admin,
            supabaseUserId,
            email,
            externalId,
            createdAt: profileResponse.data.created_at,
          });
        }
      }
    }

    if (RESOLVED_USER_CACHE_TTL_MS > 0) {
      resolvedUserCache.set(cacheKey, {
        value: supabaseUserId,
        expiresAt: Date.now() + RESOLVED_USER_CACHE_TTL_MS,
      });
    }
    return supabaseUserId;
  } catch (error) {
    if (!isProduction) {
      logger.error('[supabase] failed to resolve user via admin client', {
        externalId,
        email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return UUID_REGEX.test(externalId) ? externalId : null;
  }
}

/**
 * Atomically claim `users.external_id` for this provider id.
 *
 * `.is('external_id', null)` pushes the check into the UPDATE's WHERE clause,
 * so Postgres — not this process — decides the winner. Exactly one concurrent
 * request gets a row back; every other request gets zero rows and knows it
 * lost. That single winner is the once-per-account first-touch signal the
 * signup funnel hangs off.
 *
 * SELECT-then-INSERT cannot do this job: two requests can both read null and
 * both believe they are first. Neither can `.update()` without `.select()`,
 * which reports success whether or not it matched a row.
 *
 * Every writer of this column must come through here. There are two, on either
 * side of a real race (see the email-fallback branch), and a third that would
 * silently re-open the double-count hole.
 *
 * @returns true when THIS request performed the claim.
 */
async function claimUserExternalId(params: {
  admin: SupabaseClient<any, 'public'>;
  supabaseUserId: string;
  externalId: string;
}): Promise<boolean> {
  const { data: claimedRows, error } = await params.admin
    .from('users')
    .update({ external_id: params.externalId })
    .eq('id', params.supabaseUserId)
    .is('external_id', null)
    .select('id');

  if (error) {
    // Not silent: a failed claim means auth-by-external_id will miss on the
    // next request, which reads as a 401 to the user.
    logger.warn('[supabase] external_id claim failed', {
      supabaseUserId: params.supabaseUserId,
      error: getSupabaseErrorMessage(error),
    });
    return false;
  }

  return (claimedRows?.length ?? 0) > 0;
}

/**
 * Record the signup funnel event for an account that was just claimed, unless
 * the profile row is too old to plausibly be a signup.
 *
 * The age bound is what separates "a new account just appeared" from "a legacy
 * row that never had an external_id finally logged in". 23 of 69 prod rows are
 * in the latter class (verified 2026-07-25), so without the bound the first
 * such login would post a signup dated today into a funnel that feeds real
 * decisions.
 *
 * Both call sites pass `createdAt`. It stays optional only so that a future
 * caller without a profile timestamp is forced to think about which side of
 * that line it is on; winning the claim on a row of unknown age still counts,
 * because dropping real signups to guard against stale ones is the worse
 * failure.
 */
async function recordSignupFunnelEventForFreshProfile(params: {
  admin: SupabaseClient<any, 'public'>;
  supabaseUserId: string;
  email: string;
  externalId: string;
  createdAt?: string | null;
}): Promise<void> {
  const { createdAt, ...rest } = params;

  if (createdAt) {
    const createdAtMs = Date.parse(createdAt);
    const isFresh =
      Number.isFinite(createdAtMs) &&
      Date.now() - createdAtMs <= SIGNUP_FUNNEL_MAX_PROFILE_AGE_MS;
    if (!isFresh) {
      logger.info('[supabase] skipped signup funnel event for legacy profile', {
        supabaseUserId: params.supabaseUserId,
        profileCreatedAt: createdAt,
      });
      return;
    }
  }

  // Best-effort — telemetry must never break user provisioning. Best-effort is
  // not silent, though: the external_id claim fires once per account, so there
  // is no later request to retry from and a swallowed throw here is a signup
  // that is gone for good. Say so.
  await recordSignupFunnelEvent(rest).catch((error: unknown) => {
    logger.warn('[supabase] signup funnel event failed after claim', {
      supabaseUserId: params.supabaseUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Record the `signup` conversion event and emit the `signup_completed` PostHog
 * funnel event exactly once per user. Mirrors the Clerk-webhook Trigger task
 * (`inngest/functions/userSync.ts`) so the funnel is instrumented regardless of
 * which path first provisions the user. All failures are swallowed so
 * provisioning is never blocked by telemetry.
 *
 * Idempotency is two-layer, and the layers do different jobs. The race-safe
 * layer is the caller's: every caller must already hold a once-per-account gate
 * that Postgres arbitrated — `claimUserExternalId`, or having inserted the
 * profile row itself and seen no 23505. The check below is the second layer and
 * is deliberately NOT the load-bearing one: `conversion_events` carries no
 * unique index on (user_id, event_type), so a bare SELECT-then-INSERT here
 * could not be made atomic even if it wanted to be. It catches the cross-path
 * case the claim cannot see — the Clerk webhook having already recorded the
 * signup — and nothing more. Add a partial unique index if this function ever
 * grows a caller that does not hold a gate.
 *
 * NOTE for whoever reads this next: PostHog is NOT dark. Server capture is
 * configured (`lib/telemetry.ts` falls back to the public project key) and
 * custom events land minute-by-minute. `signup_completed` specifically never
 * fired because, until 2026-07-25, its only call site sat in the
 * `!profileResponse.data` branch above, which the `handle_new_user` trigger
 * makes unreachable. This is a reachability bug, not a telemetry outage — do
 * not rebuild PostHog inside Postgres on the strength of it.
 */
async function recordSignupFunnelEvent(params: {
  admin: SupabaseClient<any, 'public'>;
  supabaseUserId: string;
  email: string;
  externalId: string;
}): Promise<void> {
  const { admin, supabaseUserId, email, externalId } = params;

  // Dedupe: if a signup conversion already exists for this user, another path
  // (webhook or a prior provisioning) already recorded + emitted it.
  const { data: existing } = await admin
    .from('conversion_events')
    .select('id')
    .eq('user_id', supabaseUserId)
    .eq('event_type', 'signup')
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Best-effort first-touch attribution from the prospect record (populated by
  // the marketing site / outbound ingestion). Absent for purely organic users.
  const { data: prospect } = await admin
    .from('prospects')
    .select(
      'id, source, company_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_url'
    )
    .eq('email', normalizedEmail)
    .maybeSingle();

  const source = prospect?.source ?? 'unknown';

  const { error: conversionInsertError } = await admin
    .from('conversion_events')
    .insert({
      prospect_id: prospect?.id ?? null,
      user_id: supabaseUserId,
      session_id: null,
      event_type: 'signup',
      event_data: {
        clerk_id: externalId,
        email: normalizedEmail,
        companyUrl: prospect?.company_url ?? null,
        utm_content: prospect?.utm_content ?? null,
        utm_term: prospect?.utm_term ?? null,
        provisioned_via: 'lazy_resolve', // vs. the webhook Trigger path
      },
      source,
      utm_source: prospect?.utm_source ?? null,
      utm_medium: prospect?.utm_medium ?? null,
      utm_campaign: prospect?.utm_campaign ?? null,
      referrer_url: prospect?.referrer_url ?? null,
      user_agent: null,
    });

  // Warn unconditionally, prod included. PostgREST returns errors rather than
  // throwing, so without this a failed insert is indistinguishable from the
  // call site never running — the exact failure mode this fix exists to end.
  // Still emit the PostHog event: the external_id claim is once-per-account, so
  // there is no later request to retry from.
  if (conversionInsertError) {
    logger.warn('[supabase] failed to record signup conversion event', {
      supabaseUserId,
      error: getSupabaseErrorMessage(conversionInsertError),
    });
  }

  // Funnel step 1: a real new user activated. Lazy-import telemetry so
  // posthog-node never enters the client bundle.
  //
  // This sits on the live user-provisioning path — the request that decides
  // whether someone can use the product at all — so it gets a hard ceiling
  // rather than an open-ended await. A flush is still started and still
  // completes on its own past the bound (the process outlives the request on
  // the VPS); we simply stop making the user wait for PostHog. The durable
  // record is the `conversion_events` row above, which was awaited: if the
  // vendor is down, attribution survives in Postgres.
  const { trackServerEventAndFlush } = await import('@/lib/telemetry');
  const flush = trackServerEventAndFlush('signup_completed', {
    distinct_id: supabaseUserId,
    userId: supabaseUserId,
    source,
    clerk_id: externalId,
    utm_source: prospect?.utm_source ?? null,
    utm_medium: prospect?.utm_medium ?? null,
    utm_campaign: prospect?.utm_campaign ?? null,
    provisioned_via: 'lazy_resolve',
  }).catch((error: unknown) => {
    logger.warn('[supabase] signup_completed telemetry failed', {
      supabaseUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flush.finally(() => {
      if (budgetTimer) clearTimeout(budgetTimer);
    }),
    new Promise<void>((resolve) => {
      budgetTimer = setTimeout(() => {
        logger.warn('[supabase] signup_completed telemetry exceeded budget', {
          supabaseUserId,
          budgetMs: SIGNUP_FUNNEL_TELEMETRY_TIMEOUT_MS,
        });
        resolve();
      }, SIGNUP_FUNNEL_TELEMETRY_TIMEOUT_MS);
      // Never hold a Node process open for analytics.
      budgetTimer.unref?.();
    }),
  ]);

  if (!isProduction) {
    logger.debug('[supabase] recorded signup_completed funnel event', {
      supabaseUserId,
      source,
    });
  }
}

async function forgeSupabaseToken(
  clerkAuth: any,
  _clerkModule: any
): Promise<ResolvedAuthToken | null> {
  if (!clerkAuth?.userId) {
    return null;
  }

  // Check cache first
  const cached = forgedTokenCache.get(clerkAuth.userId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      token: cached.token,
      user: cached.user,
    };
  }

  const jwtSecret = getSupabaseJwtSecret();
  if (!jwtSecret) {
    if (!isProduction) {
      logger.warn('[supabase] SUPABASE_JWT_SECRET missing; cannot forge token');
    }
    return null;
  }

  let email = extractEmailFromClaims(clerkAuth.sessionClaims);
  let fullName: string | null = null;
  let avatarUrl: string | null = null;

  // Use the cached Clerk user helper to avoid redundant API calls
  try {
    const { getCachedClerkUser } = await import('@/lib/server/cached-identity');
    const userRecord = await getCachedClerkUser(clerkAuth.userId);
    if (userRecord) {
      email =
        email ??
        userRecord?.primaryEmailAddress?.emailAddress ??
        userRecord?.emailAddresses?.[0]?.emailAddress ??
        null;
      fullName = userRecord?.fullName ?? null;
      avatarUrl = userRecord?.imageUrl ?? null;
    }
  } catch (err) {
    if (!isProduction) {
      logger.warn('[supabase] failed to fetch Clerk user record', {
        clerkUserId: clerkAuth.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let resolvedSupabaseUserId: string | null = null;
  try {
    resolvedSupabaseUserId = await resolveSupabaseUserIdForExternal(
      clerkAuth.userId,
      {
        email,
        fullName,
        avatarUrl,
        createIfMissing: true,
      }
    );
    if (!isProduction) {
      logger.debug('[supabase] resolved Supabase user for Clerk id', {
        clerkUserId: clerkAuth.userId,
        resolvedSupabaseUserId,
        hasEmail: Boolean(email),
      });
    }
  } catch (err) {
    if (!isProduction) {
      logger.warn('[supabase] could not resolve supabase user id', {
        clerkUserId: clerkAuth.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  // In non-production (tests/dev), allow forging even if Clerk userId is not a UUID.
  // In production, still bail out to avoid RLS issues with non-UUID subjects.
  if (!resolvedSupabaseUserId && !UUID_REGEX.test(clerkAuth.userId)) {
    if (isProduction) {
      logger.warn(
        '[supabase] cannot forge Supabase token: resolved user id missing and Clerk id is not a UUID',
        {
          clerkUserId: clerkAuth.userId,
          hasEmail: Boolean(email),
        }
      );
      return null;
    }
    // Dev/test fallback: use the Clerk id directly
    resolvedSupabaseUserId = clerkAuth.userId;
  }

  const payload: Record<string, unknown> = {
    aud: 'authenticated',
    exp: issuedAt + supabaseJwtTtlSeconds,
    iat: issuedAt,
    role: 'authenticated',
    sub: resolvedSupabaseUserId ?? clerkAuth.userId,
  };

  if (email) {
    payload.email = email;
  }
  payload.external_id = clerkAuth.userId;

  try {
    const token = await signJwtHS256(payload, jwtSecret);
    const user = {
      id: (payload.sub as string) ?? clerkAuth.userId,
      email: email ?? null,
      fullName,
      externalId: clerkAuth.userId,
    };

    // Cache the result
    forgedTokenCache.set(clerkAuth.userId, {
      token,
      user,
      expiresAt: Date.now() + FORGED_TOKEN_CACHE_TTL_MS,
    });

    // Prune cache if too large
    if (forgedTokenCache.size > 1000) {
      const oldestKey = forgedTokenCache.keys().next().value;
      if (oldestKey) forgedTokenCache.delete(oldestKey);
    }

    return {
      token,
      user,
    };
  } catch (err) {
    if (!isProduction) {
      logger.warn('[supabase] failed to forge Supabase JWT', {
        clerkUserId: clerkAuth.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      '='
    );
    const json = Buffer.from(
      normalized.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function resolveClerkToken(): Promise<ResolvedAuthToken | null> {
  try {
    const clerkModule: any = await import('@clerk/nextjs/server');
    const authFn = clerkModule?.auth;
    if (typeof authFn !== 'function') {
      return null;
    }

    const clerkAuth = await authFn();

    if (!clerkAuth) {
      return null;
    }

    // Only use a Clerk-minted Supabase token when an explicit template is configured.
    if (typeof clerkAuth.getToken === 'function') {
      const configuredTemplate =
        process.env.CLERK_SUPABASE_TOKEN_TEMPLATE?.trim();
      if (configuredTemplate) {
        try {
          const token = await clerkAuth.getToken({
            template: configuredTemplate,
          });
          if (token) {
            if (!isProduction) {
              logger.debug('[supabase] using Clerk-minted Supabase token', {
                template: configuredTemplate,
              });
            }
            const claims = decodeJwtClaims(token);
            const subject = typeof claims?.sub === 'string' ? claims.sub : null;
            // Guard against Clerk token templates that set `sub` to a non-UUID (e.g., `user_abc`),
            // which will break Postgres auth.uid() casts in RLS policies.
            // Fall through to forgeSupabaseToken which will resolve the Clerk user to a Supabase UUID.
            if (subject && !UUID_REGEX.test(subject)) {
              logger.warn(
                '[supabase] Clerk token subject is not a UUID; falling back to forged token',
                {
                  template: configuredTemplate,
                  subject,
                }
              );
              // Don't return null - fall through to forgeSupabaseToken below
            } else {
              const claimEmail =
                typeof claims?.email === 'string' ? claims.email : null;
              const externalId =
                (claims?.external_id as string) ?? clerkAuth.userId ?? null;
              return {
                token,
                user: subject
                  ? {
                      id: subject,
                      email: claimEmail,
                      externalId,
                      fullName:
                        typeof claims?.full_name === 'string'
                          ? (claims?.full_name as string)
                          : null,
                    }
                  : null,
              };
            }
          }
        } catch (tokenErr) {
          const message =
            tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
          if (!isProduction && message !== 'Not Found') {
            logger.warn('[supabase] failed to fetch Clerk token by template', {
              template: configuredTemplate,
              error: message,
            });
          }
        }
      } else if (!isProduction && !hasLoggedMissingClerkTemplate) {
        logger.debug(
          '[supabase] no CLERK_SUPABASE_TOKEN_TEMPLATE set; will forge token locally'
        );
        hasLoggedMissingClerkTemplate = true;
      }
    }

    return await forgeSupabaseToken(clerkAuth, clerkModule);
  } catch (err) {
    if (!isProduction) {
      logger.warn(
        '[supabase] Clerk auth unavailable; proceeding without Clerk token',
        {
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }
  return null;
}

// Per-request reuse only: the client carries one user's token and cookie
// writer, so it is keyed on that request's cookie store (never shared).
const requestServerClients = new WeakMap<
  object,
  SupabaseClient<any, 'public'>
>();
let supabaseAdminClient: SupabaseClient<Database> | null = null;

// For server components with auth (only call this from server components)
export const createSupabaseServerClient = async (): Promise<
  SupabaseClient<any, 'public'>
> => {
  if (!supabaseUrl || !supabaseAnonKey) {
    if (isProduction) {
      throw new Error(
        'Supabase is not configured (missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY)'
      );
    }
    logEnvWarning(
      'Supabase env missing; using no-op server client in development'
    );
    return createNoopClient();
  }

  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const requestClient = requestServerClients.get(cookieStore);
  if (requestClient) {
    return requestClient;
  }

  const authContext = await resolveClerkToken();
  const authToken = authContext?.token ?? null;
  const fallbackAuthUser = authContext?.user ?? null;
  if (!isProduction) {
    // logger.debug('[supabase] createServerClient resolved token', {
    //   providedAuthHeader: Boolean(authToken),
    //   hasSupabaseUrl: Boolean(supabaseUrl),
    //   hasAnonKey: Boolean(supabaseAnonKey),
    // })
  }

  const client = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: any) {
        cookieStore.set({ name, value, ...options });
      },
      remove(name: string, options: any) {
        cookieStore.set({ name, value: '', ...options, maxAge: 0 });
      },
    },
    global: authToken
      ? {
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        }
      : undefined,
  });
  if (authToken && fallbackAuthUser?.id) {
    const originalGetUser = client.auth.getUser.bind(client.auth);
    let cachedFallbackUser: User | null = null;
    let attemptedLoad = false;

    client.auth.getUser = async (...args: any[]) => {
      const result = await originalGetUser(...args);
      if (result?.data?.user) {
        return result;
      }

      if (!attemptedLoad) {
        attemptedLoad = true;
        cachedFallbackUser = await fetchSupabaseAuthUser(fallbackAuthUser.id);
      }

      const user =
        cachedFallbackUser ??
        createUserFallback({
          id: fallbackAuthUser.id,
          email: fallbackAuthUser.email ?? null,
          fullName: fallbackAuthUser.fullName ?? null,
          externalId: fallbackAuthUser.externalId ?? null,
        });

      return { data: { user }, error: null };
    };
  }

  const serverClient = client as unknown as SupabaseClient<any, 'public'>;
  requestServerClients.set(cookieStore, serverClient);
  return serverClient;
};

const authUserCache = new Map<string, { value: User; expiresAt: number }>();
const AUTH_USER_CACHE_TTL_MS = 60 * 1000; // 1 minute

async function fetchSupabaseAuthUser(userId: string): Promise<User | null> {
  const cached = authUserCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return null;
  }
  if (!UUID_REGEX.test(userId)) {
    if (!isProduction) {
      logger.warn('[supabase] skip auth user lookup; id is not UUID', {
        userId,
      });
    }
    return null;
  }
  try {
    const response = await admin.auth.admin.getUserById(userId);
    if (response.error || !response.data?.user) {
      return null;
    }
    const user = response.data.user as unknown as User;
    authUserCache.set(userId, {
      value: user,
      expiresAt: Date.now() + AUTH_USER_CACHE_TTL_MS,
    });

    // Prune cache if too large
    if (authUserCache.size > 1000) {
      const oldestKey = authUserCache.keys().next().value;
      if (oldestKey) authUserCache.delete(oldestKey);
    }

    return user;
  } catch (error) {
    if (!isProduction) {
      logger.warn('[supabase] failed to fetch auth user by id', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function createUserFallback(context: ResolvedAuthUser): User {
  const timestamp = new Date().toISOString();
  return {
    id: context.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: context.email ?? undefined,
    email_confirmed_at: timestamp,
    phone: '',
    confirmed_at: timestamp,
    last_sign_in_at: timestamp,
    app_metadata: { provider: 'clerk' },
    user_metadata: {
      full_name: context.fullName ?? undefined,
      external_id: context.externalId ?? undefined,
    },
    identities: [],
    created_at: timestamp,
    updated_at: timestamp,
    factors: [],
    banned_until: undefined,
    raw_app_meta_data: {},
    raw_user_meta_data: {},
    is_anonymous: false,
  } as User;
}

// For admin operations (server-side only). Lazily create to avoid import-time crashes
function isOfflineFixtureDb(): boolean {
  return (
    (process.env.TEST_FIXTURES === '1' ||
      process.env.NEXT_PUBLIC_TEST_FIXTURES === '1') &&
    process.env.ORGX_FIXTURE_DB !== 'local'
  );
}

// Typed admin accessor — real `null` narrows, so `.from()` is checked against
// `Database`. Phase 1 keystone; see docs/principal-paydown-plan.md.
export const getSupabaseAdminClient = (): SupabaseClient<Database> | null => {
  // Offline fixture mode (`--db=offline`) has no reachable database, only a
  // placeholder URL. Returning null here makes every `if (!admin)` guard across
  // the app fast-fail to its fixture fallback instead of blocking on a TCP
  // timeout per query — the single biggest cost in fixture page renders. The
  // `--db=local` path (ORGX_FIXTURE_DB==='local') keeps the real client.
  if (isOfflineFixtureDb()) return null;
  // In test environments we sometimes load `.env` after module evaluation.
  // Prefer live `process.env` values (if present) over import-time constants.
  // Honors fixture-mode override so `LOCAL_SUPABASE_*` wins over prod when
  // `TEST_FIXTURES=1` and all three locals are set.
  const live = resolveSupabaseConfig();
  const url = live.url || supabaseUrl;
  const key = live.serviceRoleKey || serviceRoleKey;

  if (!url || !key) {
    if (isProduction) {
      throw new Error(
        'Supabase admin is not configured (missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)'
      );
    }
    logEnvWarning('Supabase admin env missing; returning null in development');
    return null;
  }

  const urlRef = extractProjectRefFromUrl(url);
  const keyRef = extractProjectRefFromKey(key);

  // Newer Supabase admin keys can be opaque (non-JWT), so key format
  // validation must be best-effort only.
  if (!keyRef) {
    const message =
      '[supabase] Could not derive project ref from SUPABASE_SERVICE_ROLE_KEY; skipping ref-match validation';
    if (!hasLoggedSupabaseMismatch) {
      logger.warn(message);
      hasLoggedSupabaseMismatch = true;
    }
  }

  // Validate project-ref alignment only for legacy JWT-style keys.
  // Opaque secret keys do not embed a ref, so this check cannot run.
  if (urlRef && keyRef && urlRef !== keyRef) {
    const context = { urlRef, keyRef };
    if (!hasLoggedSupabaseMismatch) {
      logger.error(
        '[supabase] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY refer to different projects',
        context
      );
      hasLoggedSupabaseMismatch = true;
    }
    if (isProduction) {
      throw new Error(
        'Supabase configuration mismatch: service role key does not match NEXT_PUBLIC_SUPABASE_URL'
      );
    }
    logEnvWarning('Supabase project mismatch; returning null admin client');
    return null;
  }
  if (
    !supabaseAdminClient ||
    (supabaseAdminClient as any).__orgxAdminUrl !== url ||
    (supabaseAdminClient as any).__orgxAdminKey !== key
  ) {
    supabaseAdminClient = createClient<Database>(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    // Attach config for safe re-init when env changes during test boot.
    (supabaseAdminClient as any).__orgxAdminUrl = url;
    (supabaseAdminClient as any).__orgxAdminKey = key;
  }
  return supabaseAdminClient;
};

/** @deprecated Use {@link getSupabaseAdminClient}; ratcheted to zero by
 * scripts/check-supabase-migration.mjs, then deleted with it. */
export const getSupabaseAdmin = (): any => getSupabaseAdminClient();

export const SUPABASE_URL = supabaseUrl;
export const SUPABASE_ANON_KEY = supabaseAnonKey;
export const isSupabaseClientConfigured = hasSupabaseClientConfig;
export const isSupabaseAuthConfigured = hasSupabaseAuthConfig;
export const isSupabaseAdminConfigured = hasSupabaseAdminConfig;

type SupabaseTokenOptions = {
  email?: string | null;
  fullName?: string | null;
  avatarUrl?: string | null;
};

export async function issueSupabaseJwtForExternalUser(
  externalId: string,
  { email = null, fullName = null, avatarUrl = null }: SupabaseTokenOptions = {}
): Promise<{ token: string; userId: string } | null> {
  if (!externalId) return null;
  const jwtSecret = getSupabaseJwtSecret();
  if (!jwtSecret) {
    logEnvWarning(
      'SUPABASE_JWT_SECRET missing; cannot mint Supabase JWT for desktop session'
    );
    return null;
  }

  const resolvedUserId = await resolveSupabaseUserIdForExternal(externalId, {
    email,
    fullName,
    avatarUrl,
    createIfMissing: true,
  });

  const subject = resolvedUserId ?? externalId;
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    aud: 'authenticated',
    exp: issuedAt + supabaseJwtTtlSeconds,
    iat: issuedAt,
    role: 'authenticated',
    sub: subject,
    external_id: externalId,
  };

  if (email) payload.email = email;

  const token = await signJwtHS256(payload, jwtSecret);
  return { token, userId: subject };
}
