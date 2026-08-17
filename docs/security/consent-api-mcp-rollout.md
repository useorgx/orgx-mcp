# OrgX consent, API, and MCP capability rollout

Status: locally implemented foundation; not merged, deployed, or
production-proven.

## Product contract

OrgX should expose one capability contract across five surfaces:

```text
versioned authorization policy
  -> OAuth consent and review
  -> MCP tool/resource discovery
  -> invocation-time authorization
  -> API and tool documentation
  -> audit and revocation receipts
```

The contract must describe the resource, action, consequence, requested scope,
effective grant, account boundary, and environment. Generated surfaces may add
presentation, but they must not invent scopes or imply authority the runtime
does not enforce.

## Phase 1: enforceable least privilege

The current implementation establishes the first release gate:

- one versioned resource/action registry drives OAuth discovery, consent copy,
  MCP security schemes, generated scope documentation, and catalog metadata;
- Read, Operate, and Customize compile only to scopes the client requested;
- offline access is a separate choice and is never silently added by a preset;
- tool discovery is the intersection of the connection profile and the OAuth
  grant;
- every public OAuth tool has an explicit scope contract, and every invocation
  rechecks it;
- an authenticated but under-scoped call returns `403 insufficient_scope` with
  required and granted scopes; a missing login returns `401`;
- narrower re-consent replaces the stored grant instead of retaining old
  permissions;
- the consent page receives only an opaque session key, loads trusted details
  same-origin, and approves or denies with POST;
- the consent flow has Configure and Review states, requested-only resource
  controls, a separate persistence choice, exact client/callback context, and a
  clear accessible-workspaces boundary;
- generated MCP catalog and authorization policy artifacts are synchronized
  into the OrgX documentation site;
- the documented live-agents REST route is tenant-scoped before its surface is
  expanded.

Release gate: deterministic authorization, catalog freshness, documentation,
type, MCP contract, and responsive browser checks all pass.

Production gate still open: consent state currently lives in KV, whose
read/delete sequence is not an atomic consume. Before deployment, move final
approval through a Durable Object or provider-supported idempotent operation so
two concurrent submissions of the same opaque state key cannot both attempt
grant creation.

## Phase 2: workspace-bound grants and lifecycle

Add a server-authoritative workspace selector backed by the signed OrgX
identity handoff. The browser must never turn an unsigned workspace name or ID
into authority. A grant should bind client, user, selected workspace, resource,
final scopes, issued policy version, and expiry.

Consent then becomes:

1. choose one or more eligible workspaces or environments;
2. configure access for each selection;
3. review the compiled grant and any change from the prior grant;
4. authorize and receive a durable receipt;
5. return directly to the client, which proves readiness with
   `orgx_bootstrap`.

Add a connection-management surface for session history, last use, effective
scopes, workspace/environment, policy version, and revocation. Re-consent must
highlight added and removed capabilities.

Release gate: membership is resolved server-side; cross-workspace and revoked
session tests pass; a real browser OAuth round trip proves configure, review,
redirect, bootstrap, narrowing, and revocation.

## Phase 3: Stripe-level API reference

The current public OpenAPI file covers only the limited `/api/v1` Studio
surface. Do not imply that it describes the broader Public Preview
`/api/client` routes. Establish one generated contract for those routes before
adding a polished explorer.

The reference experience should then provide:

- stable product/resource navigation, search, version and changelog context;
- endpoint method/path, auth and scope requirement, required and optional
  parameters, return type, errors, pagination, idempotency, and rate limits;
- runnable sandbox examples plus request and response fixtures;
- language snippets, copy-as-Markdown, and copy-for-agent output;
- reciprocal links between a REST operation, its OAuth capability, and the MCP
  workflow or tool that uses it;
- generated SDK and conformance tests from the same contract.

Release gate: every published route has an owner/workspace isolation test, an
OpenAPI operation, a docs page, a working sandbox example, and a contract
freshness check.

## Phase 4: compact MCP API bridge

After the REST contract is complete, add compact discovery and execution
primitives rather than advertising one MCP tool per endpoint:

- `orgx_api_search` finds supported operations and workflows;
- `orgx_api_details` returns exact schema, scope, risk, and examples;
- `orgx_api_read` performs approved read operations;
- `orgx_api_operate` performs approved state changes with idempotency and
  review metadata.

Keep curated OrgX workflow tools for high-value organizational actions. The API
bridge and curated tools must compile through the same scope registry and
runtime authorization wrapper.

Release gate: search/details results are versioned, execution cannot escape the
grant, write-like calls carry idempotency and receipts, and tool discovery stays
within the intended context budget.

## Phase 5: configurable API keys

Only add Read, Operate, and Customize controls to API-key settings after every
API route enforces a validated scope allowlist. Existing stored scope fields are
not sufficient proof of enforcement.

Release gate: route-level enforcement, key rotation/revocation, least-privilege
defaults, audit history, and tenant-isolation tests pass before the picker ships.

## Evidence boundaries

Local tests and screenshots prove only the local implementation. A commit or PR
proves reviewable source state; merge, deployment, a production OAuth round
trip, and a post-connect capability check are separate receipts.
