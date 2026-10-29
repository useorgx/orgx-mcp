# Directory operation source audit

Reviewed MCP base cc3481dc3e620aedd26e6fc972058362dadfd2e0 and core main ba9203bcea570c9c312b33e503b1144a7843c206. Core deployed SHA was not established; findings are source contracts, not a production exploit. No foreign-run probes, fixture mutations or paid model calls were made.

The 14 adapters project 5 canonical routers. No adapter executes the same canonical operation twice. The additional 15 tools use existing handlers, including app-only Resume. Read/write/dispatch separation is intentional and shares the canonical implementation.

- Plan start/improve/edit/complete schemas do not consume retry keys. Start inserts a new session; edit and completion append history rows; improvement calls the external model again. Remove directory retry guarantees rather than inventing backend dedup.
- Plan latest lookup is owner/status scoped across owned workspaces. Require explicit session ID in the directory read adapter.
- Workspace creation drops retry keys and promotes later workspaces to account default. Exclude it from directory creation, while retaining workspace reads and content updates.
- Proof completion does not consume its retry key. Its loose artifact input accepts empty objects and caller approval overrides. Require a typed linked artifact and reject approval metadata, then preserve canonical verification gates. Keep the directory flow primary-only.

Pinned primary sources:

- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/plan-sessions/route.ts#L186
- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/plan-sessions/route.ts#L74
- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/plan-sessions/improve/route.ts#L122
- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/plan-sessions/edit/route.ts#L101
- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/plan-sessions/complete/route.ts#L253
- https://github.com/hopeatina/orgx/blob/ba9203bcea570c9c312b33e503b1144a7843c206/orgx/app/api/workspaces/route.ts#L376

Authenticated production workflow receipts are still required. Source, local regressions, CI, merge, deploy, provider capture and submission are separate states.
