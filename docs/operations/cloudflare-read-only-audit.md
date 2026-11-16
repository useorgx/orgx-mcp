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
and performs no retries. Production code imports only Node built-ins.

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
