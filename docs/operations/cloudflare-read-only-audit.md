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

The same secured step also makes at most three fixed Workers Observability
REST reads for that Worker and hour. The `/telemetry/keys` request verifies
only the exact string keys `$metadata.service` and `$metadata.level`. Arbitrary
key names are discarded. If either key cannot be verified, no count query runs.
The documented dataset is `cloudflare-workers`; every request retains the
fixed `$metadata.service = orgx-mcp-production` filter.

Two `/telemetry/query` requests use `view: calculations`, `dry: true`,
`chartType: aggregate`, and `ignoreSeries: true`. One counts by log level,
limited to 16 groups. The other counts matches for a fixed RE2 credential-shape
pattern without returning matching events. Neither request saves a query or
requests event contents. Unknown level values become a fixed `other` label;
query ownership metadata, messages, arbitrary fields and provider errors are
discarded. All three REST reads share one ten-second deadline and retain the
64 KiB per-response byte cap. There are no retries or configurable queries.

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
