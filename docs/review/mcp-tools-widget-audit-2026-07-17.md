# OrgX MCP tool and widget audit — 2026-07-17

## Outcome

The production worker is running the verified widget, gallery, and assignment repair as Cloudflare version `ed260ae7-130d-4bc7-a0e0-3fedf6c1baf7`. The production health, upstream, OAuth, and registry checks all pass. An error-only Wrangler tail has recorded no production worker exceptions during the audit or post-deploy smoke checks.

The visual system now has one shared quality layer, state-complete widgets, consistent interaction geometry, and a reproducible Playwright audit. The final audit rendered 148 widget/state/viewport combinations with zero failures, zero targets under 44px, zero suspicious-data flags, and zero `Unassigned` strings.

## Why `Unassigned` was returned

The assignment existed in the scaffold input but was lost before the compact tool response and widget projection were built:

1. `ownerAgent` and `primaryAgent` were intentionally excluded from the API entity payload.
2. Assignment resolution then read the sanitized payload instead of the original input node.
3. The compact response did not carry the resolved assignment for every hierarchy level.
4. The widget and shared domain chip used `Unassigned` as a final visual fallback.

The repair resolves identity from the original input, retains canonical assignment metadata in the compact result, normalizes legacy domains such as `brand` and `content` to `marketing`, and presents a truthful neutral state (`OrgX routing · owner pending`) when no owner actually exists. It does not fabricate an agent.

Agent status had a separate truthfulness problem: the API could report an agent as `idle` while also returning a current in-progress task. The widget now renders that combination as `assigned`, preserving the distinction between active execution and queued responsibility.

## Widget registry

| Surface | Role | Primary question | State coverage |
|---|---|---|---|
| Decisions | Action / escalation | What needs my judgment now? | populated, empty, loading, success/error action |
| Agent status | State / command | Which agent is active, assigned, blocked, or idle? | active, assigned, blocked, idle |
| Search results | State / readout | What prior context answers this request? | populated, empty, loading |
| Scaffolded initiative | Process / creation | What structure was created and who owns it? | compact, long, urgent, resolved, owner pending |
| Initiative pulse | State / command | Is this initiative healthy and what blocks it? | healthy, blocked, empty, loading |
| Task spawned | Process / creation | Who took the task and what happens next? | queued, started, blocked/error |
| Morning brief | Executive readout | What changed, what needs attention, and what is proven? | populated, empty, loading |
| Artifact review | Action / escalation | Is this artifact ready to approve or revise? | pending, approved, changes requested, error |
| Plan session live | Process / creation | What is happening during planning now? | connected, progressing, complete, disconnected |
| Daily brief | Executive readout | What is the useful operating brief for today? | loading, populated, agents lens, empty |
| Scaffold stream | Development harness | Is a live scaffold stream attached? | live opt-in, demo opt-in, calm unattached state |

`daily-brief` remains a registered visual resource without a current tool output-template binding. It is treated as a prepared readout surface, not represented as a live tool-backed widget. `scaffold-streaming` is a development harness and no longer opens an unauthenticated demo stream by default.

## Design and microinteraction changes

- Added one shared matte-instrument quality layer and inlined it into MCP Apps resources so Claude receives the same styling as direct web renders.
- Removed nested-card stacking from scaffold, pulse, and result lists; hierarchy now comes from separators, indentation, type, and urgency.
- Standardized control height, radii, focus rings, hover response, pressed state, pending/disabled behavior, and 150ms motion.
- Added reduced-motion behavior and compact 375px geometry without hiding ownership or proof data.
- Added useful loading and empty states to the daily brief and stream harness.
- Fixed the decisions empty-state null dereference.
- Escaped assignment display fields in the shared domain chip.
- Updated the MCP Apps client bridge from `@modelcontextprotocol/ext-apps` 1.1.2 to 1.7.4 and unified MCP SDK 1.29.0 across the worker and Cloudflare agent runtime.

## Verification evidence

| Gate | Result |
|---|---|
| `pnpm verify` | pass: typecheck, 152 MCP contract tests, widget build, MCP Apps SDK bundle |
| Focused widget/data tests | pass: 63/63 across 9 files |
| Widget audit before | 99 renders, 9 failures, 180 undersized targets |
| Widget audit after | 148 renders, 0 failures, 0 undersized targets |
| Focus feedback | 104/104 interactive cases |
| Hover feedback | 104/104 interactive cases |
| Reduced-motion interaction checks | 26 |
| Production endpoint smoke | 6/6 pass |
| Production error-only tail | no worker exceptions observed |

Final report: `artifacts/widget-audit/2026-07-17/quality-final/report.json`.

### Gallery coverage

The widget gallery was rebuilt from an incomplete eight-card directory into one manifest-backed inspection workbench. It now surfaces all 11 widget surfaces, restores widget/state/theme/viewport selection from the URL, exposes binding and build provenance, and distinguishes production-bound, binding-pending, and development-harness surfaces. Its dedicated browser audit passes four viewport/theme cases with zero failures; evidence is stored in `artifacts/widget-gallery/2026-07-17/final/` and the design record is `docs/review/widget-gallery-design-brief-2026-07-17.md`.

## Tool usage audit

The connected production OrgX server reported 37 visible tools. The following safe, read-only/list operations were exercised successfully before the production deployment and returned structured data rather than transport errors:

- `orgx_bootstrap`
- `orgx_search`
- `get_agent_status`
- `approve_agent_work` with `action=list`
- `orgx_inspect`
- `get_initiative_pulse`
- `track_project_progress`
- `orgx_recommend`
- `recommend_next_action`
- `get_morning_brief`
- `query_org_memory`
- `recall_memory`
- `review_artifact`
- `orgx_decide` with `action=list_pending`

The remaining effectful tools require a Claude-client audit using list, estimate, dry-run, or intentionally invalid fixture identifiers so the audit cannot mutate production data. Sending that prompt in the user's open Claude session requires action-time confirmation.

## Errors and boundaries

- Cloudflare's MCP adapter returned `Unexpected response type` for `version_list`, `wrangler_config_get`, and `workers_analytics_search`. The same account, worker inventory, deployments, endpoint checks, and live error tails worked through Wrangler CLI. This is an adapter-result decoding failure, not a worker runtime exception.
- The production deploy emitted an informational assets-routing warning for `useorgx.com/.well-known/mcp-registry-auth*`; the route forwards to worker code when no asset matches, and both registry endpoint checks pass.
- Preview deploy warning was fixed by declaring `ORGX_API_FALLBACK_URL` explicitly. Preview smoke still exposes environment drift: `staging.useorgx.com` has no DNS and preview has no `MCP_REGISTRY_PUBKEY`, yielding 502 and 503 on those two checks. No preview worker exception was emitted. Production is not affected.
- No changes were made in `/Users/hopeatina/Code/orgx`. The assignment loss, widget rendering, MCP Apps bridge, and Cloudflare worker all live in `orgx-mcp`; the `Code/orgx` worktree is also carrying extensive unrelated user changes and was left untouched.
