# Local MCP Inspector and widget release gate

Verified the real Worker entry point with Wrangler 4.59.1, official MCP Inspector 2.10.1 and system Chromium before merging the operation cutover. The final widget build is `000af943aa6a`.

## Results

| Check | Result |
| --- | --- |
| Strict Inspector ChatGPT discovery | 48 descriptors: 41 model-visible operations and seven app-only operations |
| Strict Inspector extended discovery | 68 descriptors, including the 20 additional explicit operations |
| Inspector tool invocations | Successful invocation of every default and extended operation: 68 distinct tools |
| Intended refusal cases | 42 passed: missing/invalid/stale review capabilities, stale plan revisions, invalid inputs and retired descriptor names |
| Proof completion outcomes | Completed, blocked and failed-after-attachment responses retain their declared evidence and state |
| Combined invocation corpus | 112 cases passed, including the two additional partial proof outcomes |
| Inspector resource discovery and reads | All 28 current resources passed, covering 14 widget families in MCP Apps and Skybridge formats |
| Native SSE | Actual GET connection, advertised message POST, discovery and workspace-context invocation passed |
| Browser rendering | 96 checks passed across all 16 HTML assets, desktop/mobile and standalone/ChatGPT/MCP Apps hosts |
| Actual Worker browser integration | 43 checks passed, including all 28 producer renders, receipt/artifact/decision callbacks, workspace selection and official SDK global/thread share/clear |
| Full source verification | 3,015 tests passed across 264 files, with two existing skips; TypeScript passed |
| ChatGPT 1.1.0 candidate | Eight-file manifest/package validation and all 12 Python regression checks passed |

Every upstream-refusal case requires the expected backend path and HTTP status. Input and retired-name cases require no backend call; the retired names are absent from discovery and Inspector refuses them. Rate-limit, configuration and transport failures are rejected as evidence. Strict discovery produced no error-level validation findings; legal nullable type unions still produce Inspector portability advisories.

Resource checks require the exact URI and MIME, executable HTML, source title, host CSP/presentation metadata and matching MCP Apps/OpenAI widget domains. Browser checks exercise private authority, wrong identity, stale host packets, lost responses without a second mutation, decision polling and missing advertised callbacks. Receipt displays retain producer confidence and source labels.

## Findings fixed

- Signed run authentication now covers the native `/sse/message` endpoint through the observed SSE handler, with the existing origin, actor and grant checks.
- Workspace selection advertises a bootstrap output schema that accepts the actual current workflow hints and retains legacy `mode`/`period` hints. Its compact nested projection matches bootstrap; server validation remains in place.
- Receipt lists distinguish numeric aggregate totals from actual receipt arrays.
- Ledger failures recognize `OrgXApiError.statusCode`, so permission failures receive the declared workspace sign-in explanation and private diagnostics stay private.
- The retained morning-brief resource reads the current operator chronicle instead of falsely reporting an empty decision queue.
- Studio validation accepts the template and structured content required by core's video validator. Its schema, title and read-only/idempotent annotations describe that operation.

An independent comparison of actual SDK descriptors reviewed all 162 changed descriptors across 13 profiles against `c261d900`: 154 change only optional `mode`/`period` fields in output guidance; six workspace selectors adopt the compact projection; two full/extended studio descriptors contain the studio correction. Security, inventories and unrelated inputs remain unchanged. The reviewed descriptor snapshots were regenerated.

## Local setup and reproduction

Inspector connected to the actual local Worker at `http://127.0.0.1:8787/mcp?profile=chatgpt`, with a separate `extended` connection and native `/sse?profile=chatgpt` connection. Durable Objects, KV and assets ran locally. All API origins pointed to an isolated HTTPS fixture on loopback; unknown routes failed closed. The fixture made zero production requests.

The fixture uses fabricated service credentials and locally signed run credentials. An ephemeral CA is supplied through `NODE_EXTRA_CA_CERTS`, which Miniflare adds to workerd's trust store; TLS verification remains enabled. Fresh valid local credential IDs isolate invocation cases from the unchanged production rate limiter. Credential configurations are private local files and excluded from source control.

With a private local Inspector configuration, the relevant official CLI commands are:

```sh
mcp-inspector --cli --config inspector.json --server orgx-local --method tools/list --advertise-apps --strict
mcp-inspector --cli --config inspector.json --server orgx-local --method resources/list
mcp-inspector --cli --config inspector.json --server orgx-local --method tools/call --tool-name TOOL --tool-args-json 'INPUT_JSON' --advertise-apps
mcp-inspector --cli --config inspector.json --server orgx-local --method resources/read --uri RESOURCE_URI
```

On this workspace the captured discovery, resource reads, invocation outcomes and fixture request log are under `/tmp/orgx-inspector-local/`; browser evidence is summarized in `/tmp/orgx-widget-local-verification.md`. Source regressions cover each repaired contract and UI behavior. Full-suite results and deployment evidence are recorded in the companion PR descriptions.

The fixture verifies MCP transport, serialization, advertised schemas and widget/host behavior. Core's separate route tests and real PostgreSQL transaction harnesses verify authorization, signed human authority and receipt/artifact database races. Local fixture acceptance does not establish a production human judgment, installed client versions or a successful publisher-portal scan. The ChatGPT candidate still requires the publisher's portal scan and publication.
