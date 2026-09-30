# Edge admission and telemetry validation

The worker uses one Redis EVAL operation to trim, compare, and admit each
sliding-window request. Rejected requests do not enter the sorted set or extend
its expiry. A command error, malformed result, or timeout (including the body)
uses the existing per-isolate fallback and returns
`X-RateLimit-Degraded: upstash_unavailable`. A bounded log records degradation.

The fallback retains at most 2,048 active subject buckets. At capacity it
rejects new subjects instead of evicting an active caller and replenishing its
allowance. Expired subjects are swept. Token billing-identity cache entries are
also bounded. Bearer subjects/cache keys use SHA-256 rather than the former
short hash; this changes existing bearer quota keys once on rollout.

These controls do not establish a global fallback limit, user/workspace
admission independent of token rotation, enterprise concurrency protection, or
OAuth endpoint abuse limits. Verify those launch gates separately. Confirm the
deployed Upstash credential supports EVAL; a rejected script is visibly degraded,
not a successful distributed check.

## Local concurrency acceptance

Use an isolated local Redis server with TCP disabled and no persistence:

```bash
mkdir -p /tmp/orgx-rate-limit-test
redis-server --port 0 --unixsocket /tmp/orgx-rate-limit-test/redis.sock \
  --unixsocketperm 700 --save '' --appendonly no
```

In another terminal, provide the absolute CLI path and test socket:

```bash
ORGX_TEST_REDIS_CLI=/absolute/path/to/redis-cli \
ORGX_TEST_REDIS_SOCKET=/tmp/orgx-rate-limit-test/redis.sock \
  pnpm exec vitest run tests/edgeRateLimit.redis.spec.ts
```

The test sends 140 simultaneous worker checks through a local Redis bridge,
requires exactly 100 admissions, checks sorted-set cardinality, and verifies
rejections preserve the oldest score and a bounded TTL. No production Redis or
network service is used. Without the two explicit variables this integration
test is skipped. Stop the isolated server after the run.

## Analytics boundary

`workerTelemetryPrivacy.ts` is a central closed property allowlist. It retains
bounded diagnostic/activation labels, finite counts/timings, and approved opaque
UUID fields. It excludes raw errors, validation paths, prompts/results,
conversation and JSON-RPC IDs, argument keys/values, and arbitrary nested data.
Unrecognized labels become `other`; extend the policy deliberately when adding
a diagnostic category. Registered tool/alias IDs come from existing definitions.

Each invocation receives a server request UUID shared with its durable metadata.
Each PostHog event has its own UUID. Trusted environment bindings provide the
release; absent release information is labeled unknown. PostHog delivery has a
two-second deadline and redacted rejection/failure logs. This does not implement
durable analytics retry or a full OAuth/connection funnel.

Run the regression suite, type-check, and Wrangler production dry-run before
release. On a candidate release, verify safe metadata reaches PostHog, compare
with durable invocations, test notification delivery, and run fresh-account auth
and tenant-boundary acceptance. A local pass is not deployed proof.
