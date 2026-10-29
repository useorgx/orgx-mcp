# Production reviewer authentication runner

Prepared only. No production OAuth grant or tool call has been made by these
runners. Both scripts are untracked artifacts.

- SDK: installed `@modelcontextprotocol/sdk@1.26.0`.
- Inspector: npm cache contains official `@modelcontextprotocol/inspector@2.9.0`.
- Server: `https://mcp.useorgx.com/mcp?profile=claude-directory`.
- Required test target: workspace `127758d2-0509-4a76-9e43-850f845754fd`.

Start from the managed MCP worktree:

```bash
node artifacts/anthropic-review-2026-10-05/secure-oauth.mjs
```

The SDK performs discovery and dynamic client registration, generates a PKCE
S256 verifier and a random state value, and opens a callback listener on an
OS-assigned loopback port. It prints a normal authorization URL for the UI
operator. It does not open a browser, sign in, choose an account, approve
permissions, or transmit the reviewer password. Only the UI operator proceeds
with the approved existing reviewer account and requested Operate scopes.

After the browser returns a matching callback, the SDK exchanges the code and
writes `oauth.json` to the printed temporary path. The directory is mode `0700`
and the file is `0600`. Verifier, code, client secret and tokens are never
logged. This file contains OAuth credentials; do not cat, attach, commit or
upload it.

The requested scopes are the repository's Operate preset plus `offline_access`:

```text
decisions:read decisions:write agents:read agents:write
initiatives:read initiatives:write memory:read offline_access
```

Invoke the official Inspector through the private-config wrapper:

```bash
node artifacts/anthropic-review-2026-10-05/secure-inspector.mjs \
  --auth-file /absolute/temporary/oauth.json \
  --method tools/list --strict true \
  --evidence-file artifacts/anthropic-review-2026-10-05/live-tools-list.json
```

For a prepared, explicitly authorized test case:

```bash
node artifacts/anthropic-review-2026-10-05/secure-inspector.mjs \
  --auth-file /absolute/temporary/oauth.json \
  --method tools/call --tool-name orgx_search \
  --args-file /absolute/prepared/test-case.json \
  --evidence-file artifacts/anthropic-review-2026-10-05/live-search.json
```

The case JSON must contain `workspace_id` equal to the test target. Calls with
any other workspace or credential-bearing fields are refused before connection.
Do not use this wrapper for spending agent dispatches or destructive cases until
their bounded test inputs and authorization are resolved.

The wrapper writes the bearer only to an ephemeral owner-only configuration,
never argv. It executes the Inspector with `--stored-auth-only`, interactive
login disabled, an isolated storage directory, and memory-only credential
storage. It captures and redacts output before writing an evidence file, prints
only the method, tool name, exit code, tool-error flag and evidence path, then
removes the temporary configuration. It does not refresh an expired grant.

`initialize`, `resources/list`, `resources/read` (with `--uri`),
`resources/templates/list` and `prompts/list` are also supported.

The authentication runner's `--self-test` uses mocked network responses only.
It passed PKCE S256 generation, invalid-state rejection, one valid callback
exchange and owner-only token storage. Script syntax checks passed. The existing reviewer password was accepted by the normal OrgX sign-in UI.
Authenticated Inspector calls remain unrun, and no Operate bearer has been issued.

The reviewer account owns another populated workspace whose full fixture
provenance remains unresolved. Keep all tests explicitly scoped, and do not
send the account password to Anthropic until that access boundary is resolved.

Remove the OAuth temporary directory and the separate staged reviewer-login
file after testing; sanitized evidence can remain. Do not remove any unrelated
Inspector or browser state.

Primary contracts:

- https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md
- https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md
- https://github.com/modelcontextprotocol/inspector/blob/main/docs/environment-variables.md
- Installed SDK `dist/esm/client/auth.d.ts`, `auth.js`, and `streamableHttp.d.ts`.

The initial loopback authorization attempt timed out without a grant. The consent UI was set to Operate with refresh access disabled; a new attempt must use the same no-refresh duration after the pending action-time access confirmation.
