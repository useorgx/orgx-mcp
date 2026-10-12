# OrgX cross-product PostHog contract

Source schema: `2026-10-12`. Destination: existing PostHog project **97794**,
using the current capture token and host. This change does not create a project,
credential, person backfill, identity merge, or account setting.

## Canonical boundaries

| Runtime | Existing entry point | Delivery |
| --- | --- | --- |
| Browser | `lib/telemetry.client.ts`, `PosthogTracker` | Existing singleton SDK, queue/pagehide lifecycle and DNT/opt-out |
| App server | `lib/telemetry.ts` | Existing Node client; queue 100, batches 50, interval 1 second, request deadline 2 seconds, zero retries |
| MCP Worker | `captureWorkerPosthogEvent` | Existing fetch transport, finite capture, 2-second abort, `waitUntil`; no cross-request batch timer |
| Diagnostics | `telemetry/diagnostics.ts`, `posthogDiagnostics.ts` | Opt-in OTLP, fixed message codes, 4 concurrent sends, 50 records/minute/isolate, 2-second abort, zero retries |

The pure contract is mirrored as app `lib/telemetry/sharedContract.ts` and MCP
`src/telemetryContract.ts`. Its SHA-256 is `74b01755ec87e9ab202245149de26893e4d224c853e83ad514489a528d0ea9cd`.
Update both copies together. Runtime-specific sanitizers and existing catalogs
remain their owners. No second analytics client or MCP SDK wrapper is installed.
The current [TypeScript MCP adapter](https://posthog.com/docs/mcp-analytics/installation/typescript)
is beta and has broader capture defaults; the existing dispatcher and privacy
allowlist are retained.

## Identity and audience

1. A verified internal OrgX account UUID is the only identified `distinct_id`.
   Clerk `user_*` IDs are secondary `clerk_user_id` person properties.
2. Pairing reuses its already verified UUID. It adds no identity lookup or
   provisioning. An unresolved mapping produces a personless service event.
3. `/api/profile` returns the request-authenticated `clerk_user_id` alongside
   its verified profile UUID. The browser waits for that mapping to match the
   current session, refreshes late name/email, and resets before known-account
   changes. The initial anonymous-to-known transition preserves the anonymous ID.
   Already-loaded Clerk pairing data can enrich username without another lookup.
   Omitted/null loading properties and unknown audience never erase prior values;
   intentional clears require the profile helper clearProperties option.
4. Profile caches are partitioned by authenticated account, so account switches
   refetch their own mapping. Browser identify links the current anonymous SDK session to its known account.
   It never aliases two known historical people. Unknown MCP calls get opaque
   anonymous IDs and `$process_person_profile=false`, with no shared anonymous
   person. Existing credential/session identity and durable ledger semantics are
   unchanged.
5. Names/emails are allowed only through the dedicated PostHog identify boundary.
   Generic event sanitization applies before both PostHog and Meta. Events,
   diagnostics and Meta carry no names/emails, prompts, tool values/results,
   customer artifact text, credentials, or unrestricted error prose.
6. `telemetry_audience` is `external`, `internal`, `test`, or `unknown`, from an
   explicit trusted deployment classification. No email, domain, name, admin role,
   or UUID heuristic classifies a person. Use `unknown` until a trustworthy source
   exists; never interpret unknown as external. The existing accepted-outcome
   cohort classifier now also requires explicit persisted cohort markers or
   an admitted internal UUID list; email domains no longer guess eligibility.
   The proposed read-only cohort query likewise requires audited external UUIDs
   and exclusions before interpretation; its synthetic fixture declares them.

The browser uses its existing authorized bootstrap workspace, only when the
requested route workspace agrees, and clears stale groups when it does not.
It adds no telemetry-only fetch. Event-specific workspace dimensions remain
caller-owned and must come from an admitted resource. MCP `$groups.workspace`
comes only from trusted session/credential scope, not tool arguments. An
argument `workspace_id` remains a diagnostic dimension, not membership proof.
Workspace display names and private content are not exported.

## Facts and completion

| Event | Authority and meaning |
| --- | --- |
| `signup_completed` | Existing durable account creation owner |
| `mcp_pairing_identity_token` | Handoff mint success/failure, not connected-client proof |
| `mcp_tool_invocation` | One canonical observed `tools/call` response; use `event_outcome` |
| `onboarding_completed` | First persisted navigation graduation, emitted only by the server |
| `onboarding_completion_viewed` | Browser complete-phase view; never a second completion fact |
| `human_outcome_accepted` | Existing human-accepted work activation authority |
| `continuity_activation_completed` | Existing cross-client recovery milestone |

HTTP 200 is insufficient. JSON-RPC errors, `isError`, and structured logical
failures retain `status=error`, `event_outcome=failure`. A response without an
observed logical result has `event_outcome=unknown`, even when transport status
is successful. Tool-call success is not an accepted-work outcome. First use is
**derived** from the earliest canonical invocation with observed semantic
success per account, not an additional event on every retry.

Pairing and onboarding persistence schedule delivery with Next.js `after()`.
Existing `AndFlush` compatibility callers still await delivery, bounded by the
SDK deadline. Do not infer that every legacy route has migrated to `after()`.
Profile mutations reuse the current-user SWR tuple, including Linear disconnect.
The Node batch helper uses `capture()` plus the installed SDK's pending-preparation
flush barrier; it caps an input batch at 50. A tested 20-event batch sends one
HTTP request, instead of 20 immediate requests.

## Privacy and correlation

Event envelopes carry schema, source, surface, origin, environment, release,
identity namespace and explicit audience. MCP adds stable event UUIDs and safe
request/trace/span correlation when supplied. Arbitrary JSON-RPC conversation
and request strings remain excluded; only UUID requests and nonzero hex trace
(32) and span (16) IDs pass. No raw validation paths, custom error messages,
argument keys or values pass. Validation diagnostics support bounded issue
counts and declared Zod issue codes, never dynamic field names. The canonical
invocation observer emits those summaries from declared structured error issue
arrays. Text-only errors stay coarse; it does not infer issue details from prose.
Inspection is capped at 20 issues and 10 unique codes, with a truncation flag.

Worker events are capped at 128 inspected properties and 16 KiB serialized
payloads, with 100 in-flight captures per lifecycle owner. Oversize/overflow
is dropped. OTLP acknowledgements inspect at most 1 KiB, and rejected records
remain failures. Worker capture detects HTTP-200 quota rejection.
Exporter counters (`workerTelemetryHealth`, `diagnosticHealth`) and coarse
local warnings remain outside the failing destination. These are process-local
observations, not durable delivery guarantees. There is no durable queue.

The optional logs use genuine `/i/v1/logs`, not an analytics event called `log`.
They link `posthogDistinctId` to the canonical UUID and attach a valid session,
request, trace and span only when available. OTLP session correlation uses the
PostHog default attribute `sessionId`, alongside `posthogDistinctId`. Bodies are fixed diagnostic codes.
They never intercept global console output or copy arbitrary Error messages.
Browser diagnostics reuse `posthog.logger` and the existing SDK consent path.
Pairing and persisted onboarding respect request DNT. MCP request DNT propagates
to optional PostHog capture only; the operational receipt/audit ledger retains
its existing authority and semantics.
The dedicated profile PII path does not feed any other destination.

## Dashboard and funnel definitions

For external production product decisions filter `environment=production`,
`telemetry_audience=external`, `identity_namespace=orgx_account`. Report unknown
classification and unresolved identity separately. A deployment-level audience
setting is suitable only when that deployment's audience is actually known;
mixed production traffic must remain unknown until a trusted per-account
classification is available. Do not hide internal users by guessing emails.

| Board | Definition |
| --- | --- |
| Account identity quality | Count canonical account events, unresolved/personless events, and audience unknown, by surface/release |
| Onboarding | Unique accounts: signup to persisted `onboarding_completed` within 7 days; show immature cohorts separately |
| MCP first use | Unique accounts: signup to first `mcp_tool_invocation` with `event_outcome=success`, `mcp_response_observed=true`, `journey_phase=complete` within 7 days |
| Pairing failures | Mint attempts and failure categories by release; do not call minted a completed connection |
| Invocation reliability | Canonical complete invocations; success/failure/unknown counts, logical failures, latency p50/p95 and release/client/tool breakdown |
| Work activation | Existing `CORE_PRODUCT_KPIS` and `human_outcome_accepted`; never replace human acceptance with navigation or HTTP success |
| Recovery | Existing `continuity_record_written` to `continuity_activation_completed` funnel with canonical workspace/account grain |
| Export health | Existing host logs for bounded rejected/unavailable warnings and process-local counters; do not infer success from silence |

Historical event versions stay available but cannot populate new success or
completion denominators without a validated migration query. MCP handler-local
events are diagnostics; only canonical invocations define call volume. Dashboard
provisioning and production ingestion verification have not been performed.

## Identity reconciliation dry run

With separately approved existing-log/project access, export a narrow snapshot
of authenticated identity mappings and PostHog person distinct IDs. Offline:
validate UUID and Clerk formats; compare verified mappings; flag one-to-many,
many-to-one, known-person collisions, mismatched emails, and stale mappings.
Produce counts plus per-pair evidence and a proposed disposition. Never use
email alone as merge proof. A dry run must contain **zero write calls**, and
any ambiguous pair stays blocked. Review explicit merge approvals separately.
This change does not backfill personal data or alias historical identified IDs.

## Verification and remaining gates

Offline focused suites, SDK batching tests, privacy sentinels and scoped checks
are the source evidence. The MCP fixture benchmark (Node 22.23.2, 1,000 captures)
measured 0.033 ms p50 / 0.465 ms p95 synchronous preparation and a 918-byte payload;
10,000 sanitizer calls took 209.55 ms. Delivery was mocked; logs were disabled.
Four concurrent diagnostic timeouts, overflow dropping, and HTTP-200 quota
rejection were verified with fake timers and offline responses.

Before rollout, require exact-head CI and independent review. Deployment and
existing-log access must then establish runtime release, canonical person
properties, groups, observed semantic failures, consent behavior and ingestion
warnings in project 97794. Code alone does not establish deployed visibility.
Local evidence: app 130 focused tests, MCP 56 focused tests, MCP typecheck,
app scoped typecheck/lint, and any/file-size/env-manifest guards. The full local
40-check invariant runner found six unrelated cache/macOS-path failures after
telemetry-specific any/env-manifest repairs; full pinned-dependency CI remains
a merge gate. No production database operations, replay/probes, integrity3447 retries,
callback/security/SSH changes, or new authorization were performed.

Logs remain disabled until the separately scoped log/privacy/paid-usage review
approves `ORGX_POSTHOG_LOGS_ENABLED=1` (server/Worker) and, if desired,
`NEXT_PUBLIC_ORGX_POSTHOG_LOGS_ENABLED=1` (browser). Existing project capture
configuration is reused; no new credential is required by this source path.
Do not enable replay, surveys, experiments, local flag-evaluation credentials,
source-map uploads, persistent observer access, or paid features as part of
this rollout. Existing automatic replay/error/autocapture configuration is
unchanged and needs its own private-surface audit before claiming full SDK-wide
content exclusion. New explicit telemetry and diagnostics are covered here.

Official references: [identification](https://posthog.com/docs/product-analytics/identify),
[Node lifecycle](https://posthog.com/docs/libraries/node),
[Workers lifecycle](https://posthog.com/docs/libraries/cloudflare-workers),
[MCP privacy](https://posthog.com/docs/mcp-analytics/privacy),
[OTLP logs](https://posthog.com/docs/logs/installation/other),
[person/log linking](https://posthog.com/docs/logs/link-person).
