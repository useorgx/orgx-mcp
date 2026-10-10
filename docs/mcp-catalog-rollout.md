# Coordinated MCP catalog rollout

The owner is the primary user. Deploy the core services, deploy the explicit MCP catalog and matching widgets, update affected clients, and reconnect hosts. There is no mandatory quiet interval, session/cache census, dependency manifest, or historical catalog retention.

Operation catalog, Worker, plugin, widget, and portable receipt versions stay independent. Current default discovery is `orgx-mcp-operations/1`; legitimate role/runtime profiles keep their own domain capabilities. A later breaking catalog changes its contract version and requires reconnecting affected sessions.

1. Verify the before/after inventory and meaningful changed client contracts. Keep API/Gateway receipts and independent local MCP servers separate.
2. Apply receipt/work-artifact SQL migrations, deploy core routes, then deploy MCP and its resources. Missing new core capabilities refuse writes safely.
3. Update plugin instructions/configuration/parsers and Wizard immutable source pins. Validate the current operation-aligned source before atomically replacing a managed install.
4. Reconnect ChatGPT/Claude/editor hosts to import current tools and widgets. Initialized pre-operation sessions without the current binding return a reconnect error before dispatch.
5. Smoke-test authenticated discovery, workspace changes, enabled transports, and actual signed human review. Upload/scan the provider candidate when the publishing environment is available.

Keep owner/profile/version binding and OAuth/run scopes. An authenticated session cannot transfer identity or grant external `full` access. Changed OAuth grants or signed-run identity/workspace/tool grants require reconnect before dispatch; refreshed tokens with equivalent permissions remain valid. Finite aliases may bridge schema-compatible reads; unknown old writes do not guess another operation. A timeout or partial write requires authoritative reconciliation and supported idempotency keys before retry. Producer claims and host metadata never supply human authority.

Use the existing invocation ledger to diagnose stale client calls, with bounded tool/version/action labels and no argument, prompt, credential, or arbitrary error text. HTTP batch, SSE, WebSocket, OAuth and run transport checks establish local observation behavior. Telemetry is diagnostic; silence is not a release condition.

Rollback uses a compatible core/Worker/client set and reconnects affected hosts. Preserve append-only receipts/judgments, deployed migrations, and original mutation identities. No deployment, installed-host verification, or provider scan is claimed by local tests.
