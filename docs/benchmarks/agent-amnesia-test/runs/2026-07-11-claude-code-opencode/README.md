# Run set: 2026-07-11 — Claude Code → OpenCode

First published Agent Amnesia Test runs. One piece of work (seed task 1,
API rate limiting), two clients, cross-workspace handoff: Session B always
starts in a fresh, empty workspace — the work must cross both the client
and the workspace boundary.

| Run | Client pair | With OrgX | Score | Notes |
| --- | --- | --- | --- | --- |
| [1](./run-1-baseline.json) | claude-code → opencode | no | **0/5** | Fresh workspace had nothing; Session B honestly reported no prior state. |
| [2](./run-2-with-orgx-outage.json) | claude-code → opencode | yes | **0/5** | Records existed; a server output-schema bug rejected every tool response. Published because hiding your own outage disqualifies the benchmark. |
| [3](./run-3-with-orgx.json) | claude-code → opencode | yes | **5/5** | Post-fix re-run ([useorgx/orgx-mcp#262](https://github.com/useorgx/orgx-mcp/pull/262)): decision, why, owner, artifact, next action all recovered via `orgx_search`/`orgx_inspect`. |

What run 2 bought us: the outage's root cause (default output schema
compiled with `additionalProperties: false`, rejecting every rich
`structuredContent` payload after the write had landed) plus a client-retry
duplicate-write pattern — both fixed/documented the same day. Raw
transcripts for every session are in [`transcripts/`](./transcripts/); the
`oxk_` API key value in the run-2/3 Session A transcript is redacted, and
that transcript's direct-REST fallback reads are themselves evidence of the
outage.
