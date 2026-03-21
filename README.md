# OrgX MCP Worker

A Cloudflare Workers deployment that exposes OrgX initiatives, milestones, tasks, org snapshots, and Stripe upgrades over the Model Context Protocol (MCP). The worker reuses the Next.js API routes inside this repo, so shipped business logic stays in one place.

## Prerequisites

- `pnpm` (matches the repo's package manager)
- Cloudflare account with Workers enabled
- The following environment variables must be configured for both the worker and the Next.js app:
  - `MCP_SERVICE_KEY` (Vercel) / `ORGX_SERVICE_KEY` (Worker secret)
  - `ORGX_API_URL`
  - `MCP_JWT_SECRET` (Worker secret)
  - Existing Stripe/Supabase secrets (`STRIPE_*`, `SUPABASE_*`)

> **Note:** `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` are NOT needed. OAuth clients (like ChatGPT) register dynamically via `POST /register` and get their credentials stored in the OAuthState Durable Object.

## Install & Develop

```bash
# From the repo root
pnpm install
cp .dev.vars.example .dev.vars   # customize once, ignored by git
pnpm dev                         # runs wrangler dev on http://127.0.0.1:8787
```

`wrangler.toml` stays out of git; all local secrets live in `.dev.vars` (same format as `wrangler secret put`). Example contents:

```bash
ORGX_API_URL="http://localhost:3000"
ORGX_SERVICE_KEY="oxk-..."
MCP_JWT_SECRET="your-32-byte-secret"
```

When running `pnpm dev`, Wrangler automatically loads `.dev.vars`, so the worker can mint JWTs and proxy to the local Next.js API.

## Deploy

```bash
# From the repo root
pnpm install --frozen-lockfile
pnpm wrangler deploy                    # prod
pnpm wrangler deploy --env preview      # staging (uses [env.preview])
```

Before deploying, seed Cloudflare secrets once per environment:

```bash
pnpm wrangler secret put ORGX_SERVICE_KEY --env production
pnpm wrangler secret put MCP_JWT_SECRET --env production
```

These secrets are NOT overwritten by `wrangler deploy` (unlike vars in wrangler.toml).

CI expects matching GitHub Secrets:

- `ORGX_SERVICE_KEY`
- `MCP_JWT_SECRET`

The worker publishes two transports:

- `POST /mcp` – streamable HTTP (Cloudflare Agents recommendation)
- `GET /sse` – legacy SSE transport for clients that still expect it

## Cursor / Claude Configuration

For local MCP clients like Cursor, you can connect directly using the SSE transport.

Add the worker to Cursor's MCP config (macOS/Linux `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "orgx": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.useorgx.com/sse",
        "--header",
        "Authorization: Bearer <access-token>"
      ]
    }
  }
}
```

Quick CLI test:

```bash
npx mcp-remote https://mcp.useorgx.com/sse \
  --header "Authorization: Bearer <access-token>" \
  --health-check
```

## OAuth Notes

The worker implements the full MCP OAuth 2.1 spec with PKCE:

- **Dynamic Client Registration**: `POST /register` - clients like ChatGPT register and receive unique credentials
- **Authorization**: `GET /authorize` - redirects to Clerk (OrgX web) for user authentication
- **Token Exchange**: `POST /token` - exchanges authorization codes for JWT access tokens
- **Refresh Tokens**: Supported when `offline_access` scope is requested

OAuth client credentials are stored in the **OAuthState Durable Object** (not environment variables).

Durable Objects (`OrgXMcp` class) keep each MCP session isolated so both transports can run simultaneously.

## Local workflow checklist

1. Start the worker: `pnpm dev` (uses `.dev.vars`)
2. Run `npx mcp-remote ... --health-check` to verify the session can list tools
3. Connect Cursor/Claude by pointing to the worker (`~/.cursor/mcp.json`)

## Thursday E2E (Agent Loop + MCP Apps + Context Survival)

This worker ships a deterministic E2E flow you can run live from any MCP client (real OrgX APIs, no mocks):

- Prompt: `thursday-e2e` (primary). Scaffolds an initiative, creates a pending decision, approves it, spawns an agent task, and renders the widgets.
- Prompt alias: `thursday-e2e-demo` (backwards-compat). Same flow as `thursday-e2e`.

Context survival notes:

- Session auth is persisted in the Durable Object SQLite store so OAuth sign-in survives DO resets/deployments.
- Session context (last selected workspace + last active initiative) is also persisted so follow-up calls can keep working even if the client drops IDs.

Widget protocol notes:

- ChatGPT Apps SDK templates use `openai/outputTemplate` + `text/html+skybridge`.
- MCP Apps hosts use `ui.resourceUri` + `text/html;profile=mcp-app`.
- This worker registers both URI variants for each widget and serves the same HTML payload.

## Hierarchy Scaffolding (Speed Fix) + Context Attachments

### `batch_create_entities`: IDs + `ref` dependency resolution

`batch_create_entities` now returns created IDs in a machine-usable form (and includes them in the plain text response for LLM clients that drop structured payloads).

It also supports caller-provided `ref` keys and `*_ref` relationship fields so you can create a full hierarchy in a single call (initiative → workstream → milestone → task):

```json
{
  "entities": [
    {
      "type": "workstream",
      "ref": "ws-query",
      "title": "AI Query Discovery",
      "initiative_id": "e46bb475-..."
    },
    {
      "type": "milestone",
      "ref": "ms-queries",
      "title": "30+ Queries Mapped",
      "initiative_id": "e46bb475-...",
      "workstream_ref": "ws-query"
    },
    {
      "type": "task",
      "title": "Brainstorm 50 ICP queries",
      "initiative_id": "e46bb475-...",
      "workstream_ref": "ws-query",
      "milestone_ref": "ms-queries"
    }
  ]
}
```

Supported relationship refs (when the corresponding `*_id` is omitted): `initiative_ref`, `workstream_ref`, `milestone_ref`, `command_center_ref`, `project_ref`, `objective_ref`, `run_ref`.

### `scaffold_initiative`: Nested hierarchy in 1 call

For the common case of creating an initiative plus its full hierarchy, use `scaffold_initiative`:

```json
{
  "title": "AI Legibility Foundation",
  "auto_plan": false,
  "launch_after_create": true,
  "workstreams": [
    {
      "title": "AI Query Discovery",
      "milestones": [
        {
          "title": "30+ ICP Queries Mapped",
          "tasks": [
            { "title": "Brainstorm 50 ICP queries" },
            { "title": "Score + prioritize top 30" }
          ]
        }
      ]
    }
  ]
}
```

When `workstreams` are provided, `scaffold_initiative` now preserves that explicit hierarchy and disables initiative auto-planning by default (`auto_plan: false`) so OrgX does not generate a second overlapping structure on top of the scaffold. If you omit `workstreams`, auto-planning remains enabled by default so a planner can synthesize the hierarchy later.

`launch_after_create` still defaults to `true`, so stream dispatch can begin immediately after the scaffold is created. Set `launch_after_create: false` to keep the initiative in draft state after scaffold creation.

The tool returns a nested hierarchy with IDs (plus `created[]`, `failed[]`, `ref_map`, and launch outcome metadata for chaining).

### `list_entities`: hierarchy-scoped reads

`list_entities` supports hierarchy filters so clients can read one branch without reconstructing the tree client-side:

- `initiative_id` for `workstream`, `milestone`, `task`, `stream`, `decision`
- `workstream_id` for `milestone`, `task`, `stream`, `decision`
- `milestone_id` for `task`

The `fields` parameter also accepts generic aliases such as `title` and `summary`; OrgX maps them to the correct storage columns per entity type (for example, `workstream` uses `name` under the hood).

Contract note: the canonical behavior for initiative creation and hierarchy reads lives in the OrgX API. This worker must mirror that contract, especially `auto_plan` defaults, supported hierarchy filters, and generic field alias handling.

### Context attachments: `context[]` pointers on core entities

The following entity types persist a `context` JSON array: `initiative`, `workstream`, `milestone`, `task`.

Each entry is a pointer with an optional `relevance` note (pointers, not payloads):

```json
{
  "type": "task",
  "title": "Write /use-cases/solo-technical-founders page",
  "context": [
    {
      "type": "url",
      "uri": "https://...",
      "label": "Research doc",
      "relevance": "Query targets + competitor gaps"
    },
    {
      "type": "entity",
      "entity_type": "milestone",
      "entity_id": "ab0e929c-...",
      "relevance": "Use audit output"
    },
    {
      "type": "plan_session",
      "session_id": "plan-abc123",
      "section": "## Content Strategy",
      "relevance": "Decision rationale"
    }
  ]
}
```

To hydrate these pointers for execution, use `get_task_with_context` (task-focused) or `list_entities` with `id` + `hydrate_context=true` (generic).

### Plan session bridge: `complete_plan.attach_to`

`complete_plan` supports `attach_to` to automatically add a `plan_session` pointer into target entities’ `context[]`:

```json
{
  "session_id": "plan-abc123",
  "implementation_summary": "Shipped batch scaffolding improvements",
  "attach_to": [
    { "entity_type": "initiative", "entity_id": "e46bb475-..." },
    {
      "entity_type": "task",
      "entity_id": "task-xyz",
      "section": "## Content Strategy"
    }
  ]
}
```

## CI/CD & Releases

The MCP worker uses GitHub Actions for automated deployment and registry publishing.

### Automatic Deployment

Deployments are triggered automatically:

| Trigger                                | Environment  | Registry Publish |
| -------------------------------------- | ------------ | ---------------- |
| Push to `main` (\*\*) | Production   | No               |
| GitHub Release published               | Production   | Yes              |
| Manual workflow dispatch               | Configurable | Optional         |

### GitHub Secrets Required

Set these secrets in your GitHub repository settings:

| Secret                     | Description                                   | How to Get                                                             |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | Cloudflare API token with Workers permissions | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID`    | Your Cloudflare account ID                    | Cloudflare Dashboard → Workers                                         |
| `ORGX_SERVICE_KEY`         | Service key for OrgX API                      | OrgX Admin Settings                                                    |
| `MCP_JWT_SECRET`           | JWT signing secret (32+ bytes)                | Generate with `openssl rand -hex 32`                                   |
| `MCP_REGISTRY_PUBKEY`      | Ed25519 public key for registry               | Generated below                                                        |
| `MCP_REGISTRY_PRIVATE_KEY` | Ed25519 private key (hex) for registry        | Generated below                                                        |

### Creating a Release

Use the release script to bump versions and create tags:

```bash
# From the repo root

# Patch release (1.0.0 -> 1.0.1)
pnpm release:patch

# Minor release (1.0.0 -> 1.1.0)
pnpm release:minor

# Major release (1.0.0 -> 2.0.0)
pnpm release:major

# Or specify exact version
pnpm release 2.0.0
```

Then push and create the GitHub release:

```bash
# Push commit and tag
git push && git push origin mcp-v1.0.0

# Create GitHub release (triggers deploy + registry publish)
gh release create mcp-v1.0.0 --generate-notes --title "OrgX MCP v1.0.0"
```

### Manual Deployment

Trigger deployment manually from GitHub Actions:

1. Go to Actions → "MCP Worker Deploy"
2. Click "Run workflow"
3. Select options:
   - Environment: production/preview
   - Publish to registry: yes/no

## MCP Registry Publishing

OrgX MCP server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) at `com.useorgx/orgx-mcp`. This section documents how to update the registry listing.

### Prerequisites

1. **mcp-publisher CLI** - Install via:

   ```bash
   # macOS/Linux
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
   sudo mv mcp-publisher /usr/local/bin/

   # Or via Homebrew
   brew install modelcontextprotocol/tap/mcp-publisher
   ```

2. **Domain verification** - Must verify ownership of `useorgx.com`

### Initial Setup (One-time)

1. **Generate Ed25519 keypair:**

   ```bash
   # From the repo root
   ./scripts/generate-registry-keys.sh
   ```

   This creates files in `keys/` (gitignored):

   - `mcp-registry.pem` - Private key (keep secure!)
   - `http-well-known.txt` - Public key for HTTP verification

2. **Set up HTTP domain verification:**

   ```bash
   # Set the public key as a Cloudflare secret
   wrangler secret put MCP_REGISTRY_PUBKEY
   # Paste the base64 public key from keys/http-well-known.txt

   # Deploy the worker
   pnpm wrangler deploy

   # Verify it works (must be reachable on apex for com.useorgx/*)
   curl https://useorgx.com/.well-known/mcp-registry-auth
   # Should return: v=MCPv1; k=ed25519; p=<your-pubkey>

   # (Optional) Also available on:
   # curl https://www.useorgx.com/.well-known/mcp-registry-auth
   # curl https://mcp.useorgx.com/.well-known/mcp-registry-auth
   ```

3. **Login to registry:**

   ```bash
   # Read private key hex
   PRIVKEY=$(grep -v '^#' keys/private-key-hex.txt | tr -d '[:space:]')

   # Login with HTTP verification
   mcp-publisher login http --domain=useorgx.com --private-key="$PRIVKEY"
   ```

### Publishing Updates

When updating `server.json` (e.g., adding new tools), publish to the registry:

```bash
# From the repo root

# Validate first (always do this!)
./scripts/publish-to-registry.sh --dry-run

# Publish for real
./scripts/publish-to-registry.sh
```

### Endpoint Smoke Checks

Run this after deploys (or metadata/auth changes) to verify core MCP + registry endpoints:

```bash
# From the repo root
pnpm smoke:endpoints
```

Checks include:

- `/healthz`
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/mcp-registry-auth` on both `mcp.useorgx.com` and `useorgx.com`

### server.json Structure

The `server.json` file describes OrgX MCP for the registry:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.useorgx/orgx-mcp",
  "description": "AI agent orchestration and organizational memory...",
  "version": "1.0.3",
  "remotes": [
    { "type": "streamable-http", "url": "https://mcp.useorgx.com/mcp" },
    { "type": "sse", "url": "https://mcp.useorgx.com/sse" }
  ],
  "tools": [...],
  "resources": [...],
  "prompts": [...]
}
```

Key points:

- `name` uses `com.useorgx/*` namespace (requires `useorgx.com` domain verification)
- Both `streamable-http` and `sse` transports are listed
- Tools, resources, and prompts document all server capabilities
- Update `version` when making changes

### Troubleshooting

**"Domain verification failed"**

- Check that `MCP_REGISTRY_PUBKEY` secret is set correctly
- Verify endpoint: `curl https://useorgx.com/.well-known/mcp-registry-auth`
- The registry CLI does **not** follow redirects. `https://useorgx.com/.well-known/mcp-registry-auth` must return `200` directly (no 3xx to `www`).
- Ensure keypair hasn't been regenerated without updating the secret

**"Schema validation failed"**

- Run `mcp-publisher validate` to see detailed errors
- Check `server.json` against the schema

**"Rate limited"**

- The registry is in preview; retry after a few minutes
