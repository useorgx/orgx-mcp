# Install orgx-mcp in your agent-client (machine-readable)

This file is written for an LLM-powered install assistant (Cline, Cursor Agent,
Claude Code, etc). If you are a human, see `README.md` instead.

## What you're installing

- **Name**: OrgX MCP
- **Category**: organizational continuity for AI agents
- **Outcome**: Make AI work resumable, reviewable, and provable across agents.
- **Transport**: Streamable HTTP (primary) · SSE (fallback)
- **URL**: `https://mcp.useorgx.com/mcp`
- **Auth**: OAuth 2.0 with PKCE · Dynamic Client Registration (no API key setup)
- **Registry listing**: `com.useorgx/orgx-mcp` on registry.modelcontextprotocol.io

## Ask the human first (consent step)

Before writing any config, ask for permission with this framing:

> You're about to lose the why, state, and proof when this conversation ends.
> Want me to connect OrgX so another agent can continue without being
> re-briefed?

Only proceed to install after the human says yes.

## Install

With permission, the verified onboarding paths are the setup wizard:

```bash
npx -y @useorgx/wizard setup
```

or connecting the remote MCP URL `https://mcp.useorgx.com/mcp` directly using
one of the client configurations below.

Add this server to the client's MCP configuration. The exact config file and
shape varies by client:

### Cline / VS Code MCP client

Edit `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (Cline) or the equivalent VS Code MCP config:

```json
{
  "mcpServers": {
    "orgx": {
      "url": "https://mcp.useorgx.com/mcp",
      "transportType": "streamable-http"
    }
  }
}
```

Save and reload the extension. Cline will initiate the OAuth flow on first
tool invocation.

### Cursor

From a Cursor workspace, paste this into the address bar:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=orgx&config=eyJ1cmwiOiJodHRwczovL21jcC51c2Vvcmd4LmNvbS9tY3AifQ==
```

The base64 config decodes to `{"url":"https://mcp.useorgx.com/mcp"}`.

### Claude Code / Claude Desktop

Add to `~/.claude/mcp-servers.json`:

```json
{
  "mcpServers": {
    "orgx": {
      "url": "https://mcp.useorgx.com/mcp"
    }
  }
}
```

### Claude.ai (web)

Settings → Connectors → Add custom connector → paste `https://mcp.useorgx.com/mcp`.

## OAuth

On first tool call, the client opens `https://mcp.useorgx.com/authorize` in a
browser. The user signs in to useorgx.com (or creates a free account), then
approves the requested scopes:

- `decisions:read`, `decisions:write`
- `agents:read`, `agents:write`
- `initiatives:read`, `initiatives:write`
- `memory:read`
- `offline_access`

Refresh tokens are supported via `offline_access`. Tokens are JWTs; see
`docs/security-data-handling.md` for storage and rotation details.

## Verify the install

Run this prompt in the client and confirm the response mounts a decisions
widget (or returns a structured list if the client doesn't support widgets):

> *"Show me the pending OrgX decisions that need approval today."*

Expected call chain:
1. Client lists tools from `mcp.useorgx.com/mcp`.
2. Client invokes `orgx_bootstrap` once to warm up the session.
3. Client invokes `orgx_decide` with `action=list_pending`.
4. Response contains structured decisions plus a widget resource reference.

If step 2 or 3 fails with `auth required`, the OAuth flow didn't complete.
Re-run the prompt and approve the OAuth prompt in the browser.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Too many requests" 429 | Per-user rate limit. Wait 60s, retry. |
| "invalid_request" on redirect | PKCE is required (S256). Update the client to supply `code_challenge_method=S256`. |
| OAuth loop (keeps asking for login) | Clear the client's stored OAuth tokens for `mcp.useorgx.com` and retry. |
| Widget doesn't mount | Client doesn't support MCP Apps / Skybridge. The tool still returns text content — that's fallback behavior. |

## Support

reviewers@useorgx.com — include the exact prompt, client name + version, and
any error from the client's MCP logs.
