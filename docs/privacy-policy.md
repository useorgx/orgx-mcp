# OrgX MCP Worker Privacy Policy

This policy covers the public `orgx-mcp` worker hosted at `https://mcp.useorgx.com` and the repository at `https://github.com/useorgx/orgx-mcp`.

## What this worker processes

- OAuth client registration metadata required for MCP clients to connect.
- OAuth authorization state, access tokens, refresh tokens, and session identifiers required to complete authenticated MCP requests.
- Tool inputs supplied by the connected user or client.
- OrgX API responses required to fulfill the user-requested action.
- Basic operational telemetry needed to debug reliability, enforce rate limits, and protect the service from abuse.

## What this worker does not do

- It does not ask for or store end-user passwords in the repository.
- It does not sell connector data.
- It does not access third-party systems beyond the OrgX APIs and infrastructure required to operate the connector.

## How data is used

Data is used only to:

- authenticate the user and client,
- enforce OAuth scopes and access controls,
- execute the requested tool call,
- render MCP app resources and widgets,
- diagnose service failures and protect the connector from abuse.

## Data sharing

Data may be processed by:

- OrgX-operated application APIs,
- Cloudflare infrastructure used to run the worker,
- MCP clients selected by the user, such as Claude.

No repository-level MCP data is sold or shared for advertising.

## Security baseline

- OAuth 2.0 authorization code flow with PKCE is used for authenticated access.
- Tool access is gated by OAuth scopes.
- Session state is isolated in Durable Objects.
- Repository-level guidance forbids logging raw secrets or access tokens.

See [Security & Data Handling](./security-data-handling.md) for the operational security summary that accompanies this policy.

## Support

For connector support, use [GitHub Issues](https://github.com/useorgx/orgx-mcp/issues) and include enough detail to reproduce the problem without sharing secrets.

## Changes

This policy is versioned with the repository. Material changes should be reviewed alongside the connector release that introduces them.
