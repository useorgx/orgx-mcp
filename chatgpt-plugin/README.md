# OrgX ChatGPT plugin 1.1.0 candidate

This is a reconstructed, reviewable next minor package. It has not been uploaded, scanned, or published. The latest published ChatGPT package is recorded locally as 1.0.0, but its exact portal manifest and ZIP were not recovered. Publisher identity, listing metadata, and the original plugin identifier still need to be checked against the existing listing when uploading this candidate.

This package uses the portable Agent Plugins format in the [official plugin submission documentation](https://developers.openai.com/plugins/deploy/submission): root `plugin.json` declares the portable schema and puts listing fields in `extensions.com.openai.interface`; root `mcp.json` declares its schema and a `streamable-http` server. The portable format discovers `skills/` and `mcp.json` automatically. It contains no Codex compatibility manifest or component declarations. The three skills use explicit OrgX operations and distinguish receipt claims, verification, human judgment, and observed outcomes. The hosted MCP profile provides the tool schemas and widgets; this ZIP does not deploy that server.

The MCP URL preserves `https://mcp.useorgx.com/mcp`, recorded by the October 5 portal audit. Confirm that exact URL and the original plugin identity against the existing listing before uploading. The provider does not support changing an existing MCP URL through a package update; contact provider support if the portal record differs. The current default and ChatGPT profiles expose the same operations, with host negotiation supplying ChatGPT metadata. Authentication, domain verification, publisher verification, reviewer access, and provider scans remain portal setup; this ZIP contains no credentials or app identity.

The 1.1.0 upgrade uses the current operations directly. Deploy the OrgX core routes and MCP server first, then update the installed plugin and reconnect to refresh the tools imported by ChatGPT. Widgets use the new names and show a refresh message when a tool is missing. A failed write is never automatically replayed through another tool.

Source lineage:

- Published package evidence: [`docs/openai-mcp-update-audit-2026-10-05.md`](https://github.com/useorgx/orgx-mcp/blob/main/docs/openai-mcp-update-audit-2026-10-05.md), recording ChatGPT version 1.0.0 and the three installed skills. This is evidence of the version, not an export of its manifest.
- Related earlier source: [`hopeatina/openai-plugins`, `codex/add-orgx-plugin`, commit `c868b33ff252f016a048fcacd12bc9e9eeb73aa9`](https://github.com/hopeatina/openai-plugins/tree/c868b33ff252f016a048fcacd12bc9e9eeb73aa9/plugins/orgx). Its manifest is Codex version 0.1.2, a separate package.
- Listing fields and assets: local OrgX Codex package 0.1.22 supplied existing first-party metadata and artwork. Both image files match the earlier source Git blob `ed6d538f471158b4aadb76754a3a75c59caa34a0`. The candidate skills are rewritten for the new operations rather than copied from the older routing instructions.
- Current operation contracts: `src/workflowTools.ts` and `src/receiptOperationTools.ts` in this repository. The [architecture plan](https://github.com/useorgx/orgx-mcp/blob/main/docs/architecture/orgx-mcp-operation-boundary-2026-10-08.md) records implemented paths and remaining parity and durability work. These repository links describe source lineage; newly added paths remain local until committed and published.

From this directory:

```sh
python3 scripts/verify_package.py
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/build_package.py --verify-reproducible
```

The build writes `artifacts/orgx-chatgpt-plugin-1.1.0.zip` beneath the repository root, with sorted entries, fixed timestamps, and a SHA-256 checksum. Only the manifest, MCP configuration, this README, the three skills, and verified artwork enter the ZIP. The local build scripts remain source tooling. No hooks, app identifiers, local executor files, OAuth credentials, or secret headers are bundled.

Local validation checks portable manifest and MCP field paths, submission text limits and all four listing URLs, component paths, skill names and tool references, PNG dimensions and provenance, color contrast, potential credentials, and deterministic packaging. Regression checks reject the previous hybrid layout, shadow Codex files, an overlong subtitle, missing support metadata, and endpoint changes. These are local known-contract checks, not the provider's Scan Tools result. The server implementation must be tested and deployed, the connector refreshed, and the authenticated hosted tool profile checked before a publisher creates version 1.1.0 and requests a new scan. Existing review materials must be checked in the portal: dedicated reviewer access, five positive cases, three negative cases, and an accessible demo are required for MCP review and are not supplied by this reconstruction. Tool review holds and provider findings can only be resolved through that actual review workflow.
