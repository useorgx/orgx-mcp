# `requireWorkspace` — workspace authz at the MCP boundary

Every tool handler that mutates a workspace-scoped resource needs to verify
the caller actually owns the workspace. The web API has its own enforcement
(see [SECURITY.md](https://github.com/hopeatina/orgx/blob/main/SECURITY.md))
but the MCP layer is the right place to fail fast — we want to refuse before
spawning agent runs, before the API round-trip, and with audit context that
includes the caller's tool args.

## API

```ts
import { requireWorkspace, detectWorkspaceArgConflict } from './requireWorkspace';

const access = await requireWorkspace({
  args,
  sessionWorkspaceId: this.sessionContext.workspaceId,
  userId: this.props?.userId ?? this.sessionAuth?.userId ?? null,
  env: this.env,
});
if (!access.ok) return access.error;
const workspaceId = access.workspaceId;
// rest of the handler can assume workspaceId is owned by the caller
```

## Migration recipe

Every handler that currently does this:

```ts
const workspaceId =
  typeof args.workspace_id === 'string' && args.workspace_id.trim().length > 0
    ? args.workspace_id.trim()
    : typeof args.command_center_id === 'string' &&
      args.command_center_id.trim().length > 0
    ? args.command_center_id.trim()
    : this.sessionContext.workspaceId ?? null;

// ... no membership check ...
```

becomes:

```ts
const conflict = detectWorkspaceArgConflict(args);
if (conflict) return conflict;

const access = await requireWorkspace({
  args,
  sessionWorkspaceId: this.sessionContext.workspaceId,
  userId: this.props?.userId ?? this.sessionAuth?.userId ?? null,
  env: this.env,
});
if (!access.ok) return access.error;
const workspaceId = access.workspaceId;
```

Five lines of resolution + zero authz turns into seven lines that are
IDOR-safe by construction. Same downstream code; the variable contract is
strictly stronger.

## Failure shapes

| Status | When |
|---|---|
| `400 missing_workspace` | No `workspace_id` arg, no session default |
| `400 invalid_input` | Both `workspace_id` and `command_center_id` present and different (only when caller used `detectWorkspaceArgConflict`) |
| `401 unauthorized` | No caller `userId` |
| `404 not_found` | Workspace doesn't exist OR caller doesn't own it (we never 403) |
| `503 membership_check_failed` | Transient web-API error — try again |

## Caching

Per `(userId, workspaceId)` cache with a 60-second TTL. Hits are checked
before the API probe; misses populate the cache. Negative results are
cached so a probing client can't burn API rate-limit cycling through random
UUIDs. Transient errors (5xx, timeouts) are NOT cached — they fail closed
with 503 instead, so the next call retries.

The cache lives in module scope inside the worker; each isolate has its
own. That's fine because the worst case is two duplicate API calls within
a single isolate's lifetime.

## When NOT to use this

- **Reads of public data** (the widget manifest, OAuth metadata, health
  endpoints). Those don't have a `workspace_id` and shouldn't pretend to.
- **Workspace creation** (action=create on `workspace`) — the workspace
  doesn't exist yet, so there's nothing to verify ownership of.
- **Tool listings / tool discovery** that don't yet know which workspace
  is in play.

For reads of *workspace-scoped* data that aren't mutations, requireWorkspace
is still the right call — it's not just for writes. Reading another
workspace's plan sessions or initiatives is the same IDOR class as writing
to them.

## Sequence of perimeter checks (recommended order)

1. `withRateLimit(...)` — already enforced upstream by `edgeRateLimit.ts`
2. `withTier(...)` — plan-tier gate via `contextAccessTier`
3. **`requireWorkspace(...)` ← this helper**
4. Schema validation on the rest of `args`
5. Handler body

Doing tier before workspace lets you reject free-tier callers from paid
tools without revealing which of their workspaces exist. Doing schema
validation last avoids leaking which fields exist on a tool a caller
isn't allowed to use.

## Tests

[`tests/requireWorkspace.spec.ts`](../../tests/requireWorkspace.spec.ts)
covers 17 cases: positive/negative ownership, alias support, fallback to
session, no caller, no workspace_id, the 403 → 404 collapse, transient-error
no-cache behaviour, per-user cache isolation, conflict detection. Mirror the
shape when adding new failure modes.
