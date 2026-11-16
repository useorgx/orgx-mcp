# Read-only Cloudflare aggregate audit

The **Audit Cloudflare aggregate metrics** workflow can be manually dispatched
only from `main` in `useorgx/orgx-mcp`. It uses the existing production environment
and `CF_API_TOKEN` binding. It does not change secrets, Worker configuration,
deployments, cache, DNS, or triggers.

One fixed GraphQL query reads the last hour for account
`5e0f62b0acf89dd1493ff769187814c4`, Worker `orgx-mcp-production`. It requests only
numeric request/error/subrequest totals, CPU p50/p99, and counts by operational
invocation status. There are no query/account/script/window inputs. The request
rejects redirects, has a ten-second total deadline and a 64 KiB response cap,
and performs no retries. Production code imports only Node built-ins. The
GraphQL status allowlist uses `success`, `clientDisconnected`,
`scriptThrewException`, `exceededResources`, and `internalError`; Trace Event
outcome names are a different vocabulary. Historical sanitized “Other status”
counts cannot be assigned a cause after the fact.

## Retained log counts

The same secured step also makes at most eleven fixed Workers Observability
REST reads for that Worker and hour. The `/telemetry/keys` request verifies
only the exact string keys `$metadata.service`, `$metadata.level`, and
`$metadata.message`. Arbitrary key names are discarded. If either service or
level cannot be verified, no count query runs. If only the message key is absent,
the existing level and credential counts remain available but warning categories
stay Unknown, the result is partial, and no warning query runs.
The documented dataset is `cloudflare-workers`; every request retains the
fixed `$metadata.service = orgx-mcp-production` filter.

Two `/telemetry/query` requests use `view: calculations`, `dry: true`,
`chartType: aggregate`, and `ignoreSeries: true`. One counts by log level,
limited to 16 groups. The other counts matches for a fixed RE2 credential-shape
pattern without returning matching events. Neither request persists calculation
results or requests event contents. Unknown level values become a fixed `other` label;
query ownership metadata, messages, arbitrary fields and provider errors are
discarded. All REST reads, including the warning counts below, share one
thirty-second deadline and retain the 64 KiB per-response byte cap. The longer
retained-phase budget accommodates eight additional sequential fixed counts;
the separate ten-second metrics budget plus this phase stays below the existing
sixty-second secured step. There are no retries or configurable queries.

Eight more fixed aggregate queries count warning message patterns only after
the exact message key is verified. Each retains the same Worker and rolling-hour
filters plus `$metadata.level = warn`, has no group-by, and limits its result to
one row. The patterns use public fixed source prefixes and documented RE2 filters:

| Fixed category | Source message family |
| --- | --- |
| API fallback attempted | `[orgx-api] trying fallback` |
| API fallback recovered | `[orgx-api] fallback succeeded` |
| Distributed admission unavailable | `[rate-limit] Distributed admission unavailable` |
| Authentication or scope rejected | `[auth] Bearer token invalid or expired`; `Tool blocked due to missing_authentication` or `insufficient_scope` |
| Tool profile restricted | `[mcp:profiles] Unknown tool profile` or `External full profile request`, followed by the fixed failing-closed message |
| Session or client storage warning | `[mcp:session]`, `[mcp:client-info]` |
| Telemetry warning | `[mcp:session-summary]`, `[mcp:telemetry]`, `[mcp:activation]`, `[telemetry]` |
| Degraded reads, widgets or transport | `[mcp:orgx]`, `[mcp:workspace]`, `[mcp:bootstrap]`, `[panel]`, `[live-grant]`; fixed related-context/transport recovery messages; five fixed `live-feed-do` warning events |

The last category's structured events are `client_rejected_at_capacity`,
`backfill_failed`, `alarm_schedule_failed`, `poll_failed`, and `client_write_failed`.
The audit never groups by or exports raw message text, identifiers, or exception
details. Categories can overlap and do not cover every warning. Counts represent
events rather than failed requests; fallback attempts and successful recoveries
can both appear for one operation. Denied authentication/profile requests are
not evidence of a successful bypass. This rolling-hour cohort must not be
reconciled with older reports or used to assign their warnings a cause.

Only numeric counts, sampling metadata, fixed labels, key-verification booleans
and coverage status are added under `retainedLogs` in the existing artifact.
Counts represent sampling-weighted matching events, not HTTP request totals.
Credential-shape matches are indicators for investigation, not proof of a leak;
zero does not prove absence. Missing, denied, incomplete or capped results are
explicitly unknown or partial. `auditComplete` and the job succeed only when
both the metrics and retained-count audit return observed results.

Cloudflare documents **Workers Observability Write** as the permission required
by these read-query APIs. That label does not authorize configuration changes
in this job. It reuses the existing token only and reports permission denial
without widening credentials. Live endpoint compatibility and token scope are
verified only by an authorized main-branch dispatch after merge.

The job summary and one-day artifact contain sanitized aggregates and explicit
coverage limitations. Retained log contents, request paths, identifiers,
headers, tool arguments/results, arbitrary provider fields, and raw API errors
are never saved. Missing or denied metrics remain `null`/Unknown. Permission
denials fail the job and report that access was denied; a deploy-capable token
is not assumed to have analytics-read permission.

This is sampled Worker telemetry, not a complete request log or proof that
every MCP tool is correct or secure. CPU quantiles retain Cloudflare's provider
units and must not be represented as end-to-end tool latency or compared
directly with a 500 ms response target. Operational status groups are capped at
16 rows and are labeled potentially truncated when that cap is reached.

References checked while implementing the query:

- [Cloudflare Workers GraphQL metrics tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Retained telemetry keys API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/keys/)
- [Retained telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Official TypeScript response/request types](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/observability/telemetry.ts)
- [Documented Worker dataset and service scope](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/)
