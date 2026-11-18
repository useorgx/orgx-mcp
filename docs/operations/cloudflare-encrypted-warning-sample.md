# Short-lived encrypted warning sample

The separate **Collect encrypted Cloudflare warning sample** workflow supports
this private inspection task. It has no inputs or schedule and admits only a
manual run from `main` in `useorgx/orgx-mcp`, checking out the exact dispatch SHA.
Pinned checkout, Node and artifact actions run without dependency installation.
The existing production Cloudflare token is bound only to the fixed script step.
The numeric audit workflow remains unchanged.

## Fixed scope and recipient

Each dispatch makes at most one POST to the fixed account's Workers Observability
`/telemetry/query` endpoint. Its one-hour window, `orgx-mcp-production` service,
`warn` level, `cloudflare-workers` dataset, `dry: true`, `events` view and eight-event
limit are fixed in reviewed source. Redirects and retries are disabled. Actual
response bytes are capped at 64 KiB, with a ten-second total deadline including
setup, body reads and encryption checks. The deadline shortens near recipient expiry.

The reviewed public RSA recipient is embedded in the script:

- SPKI SHA-256: `e92e497679fae469d9113a93f844957652547c163b81dbd2ce52dc37f937c837`
- Admission expiry: **2026-11-16T18:42:45.914943Z**

An expired recipient is rejected before any Cloudflare request. Updating the
recipient or expiry requires another source review. Recovery from setup failure
remains possible; the operator must reconcile an ambiguous fetch before deciding
whether another manual run is appropriate. There is no automatic retry.

## Ciphertext-only output

The response must be successful, completed and dry. The actual event array must
contain at most eight entries. Every entry must carry the exact service and
warning level, the expected dataset, a timestamp inside the fixed window, and
the documented event shape. Missing or mismatching scope fails closed.

Raw response bytes and selected events remain in memory. The script serializes
only the selected event array into a temporary memory buffer and encrypts it
using a fresh random AES-256-GCM key and 96-bit IV. RSA-OAEP with SHA-256 wraps
that AES key. The fixed schema, account, Worker, level, window, limit, count,
recipient fingerprint and expiry are authenticated as GCM additional data.
Temporary plaintext/key buffers are cleared after use. No plaintext log message,
header, event identifier or provider error is written to a file, artifact,
console or job summary by this script.

The only artifact file contains ciphertext, wrapped key, IV, tag and safe context
metadata, or a fixed sanitized failure status. It is retained for one day. The
private key is never committed, read by this job, or supplied to CI. Its holder
decrypts locally, treats decrypted log contents as untrusted data, records only
redacted findings, and deletes the local plaintext and private key after review.

For decryption, use RSA-OAEP/SHA-256 on `wrappedKey`, then AES-256-GCM with the
returned key, decoded `iv` and `tag`, and UTF-8 `JSON.stringify(context)` as AAD.
The decrypted JSON contains `{ events: [...] }`. Context changes must fail GCM
authentication. Tests use a separate ephemeral recipient, never the real private
key. Expiry limits future collection; retiring the decryption key requires its
holder to delete it.

This is up to eight matching warnings, with no documented event-order guarantee.
It does not inspect every warning or prove absence of a fault. Query metadata
history may still be maintained by Cloudflare; `dry` guarantees execution without
persisting query results, not absence of provider-side history. API denial,
incomplete responses and malformed/oversized data produce sanitized failure
metadata without event contents. No saved-query, configuration, credential or
logging-setting endpoint is called.

Schema references verified for this implementation:

- [Official SDK 7.4.0, pinned telemetry source](https://github.com/cloudflare/cloudflare-typescript/blob/7ae189ce43d60adedf6512c940548a47c6e8d189/src/resources/workers/observability/telemetry.ts)
- [Workers telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
- [Worker dataset and service scope](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/)
