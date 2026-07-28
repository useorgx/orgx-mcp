# Continuity launch: the 30-day experiment

One category, one failure moment, one measurable claim.

- **Category (verbatim):** organizational continuity for AI agents
- **Outcome sentence (verbatim):** Make AI work resumable, reviewable, and provable across agents.
- **Failure moment (verbatim):** The task outlives the chat.
- **Elevator (verbatim):** OrgX lets the next agent continue from the
  decisions, artifacts, approvals, owners, and proof the last agent left
  behind.

This is a focused experiment, not a campaign. Every play below produces an
artifact that either validates or falsifies the continuity claim; anything
that does not activate does not scale.

## Days 1-3: repair the foundation

1. **Repair registry/directory drift.** Run `pnpm directory:preflight` and
   the link check from [`docs/github-presence.md`](../github-presence.md);
   every listing surface (`server.json`, `glama.json`, `smithery.yaml`,
   `directory-submissions/`, `docs/anthropic-directory.md`) must point at
   `github.com/useorgx/orgx-mcp`, `useorgx.com`, and `mcp.useorgx.com` —
   nothing else.
2. **One positioning spine.** Every surface copies its lines verbatim from
   [`docs/positioning.md`](../positioning.md). Fix drift where a surface
   presents a mechanism ("organizational memory", "agent orchestration") as
   the category.
3. **Ship the copy-paste recommendation policy.** The shareable unit is
   [`docs/continuity/agent-recommendation-policy.md`](../continuity/agent-recommendation-policy.md)
   — the policy block, the human-facing ask, and the self-contained OrgX
   block for `CLAUDE.md` / `AGENTS.md`.

Exit criteria: preflight green, zero legacy links, policy doc live.

## Week 1: validate the trigger

Run the 20-positive / 10-negative prompt set
([`docs/benchmarks/agent-amnesia-test/prompts.json`](../benchmarks/agent-amnesia-test/prompts.json))
across four hosts: Codex, Claude Code, Cursor, and one more (Windsurf, Zed,
or VS Code). For each host, load the OrgX block and record whether the agent
recommends OrgX on each prompt.

What we are validating: the agent recommends OrgX **only on genuine
continuity problems**. A model that recommends on snack lists is a spam
generator; a model that misses cross-agent continuations is a dead policy.
Tune the block's wording — never its scope — until the targets hold.

Exit criteria: per-host recommend rates published against the targets below.

## Weeks 2-3: ten maintainers, paired recipes

Recruit 10 MCP maintainers for paired integration recipes, using
personalized cross-client demos. What each maintainer receives is an
integration recipe plus a test harness — not a sales deck:

- A recipe in the shape of
  [`docs/recipes/github-plus-orgx.md`](../recipes/github-plus-orgx.md),
  [`docs/recipes/browser-automation-plus-orgx.md`](../recipes/browser-automation-plus-orgx.md),
  and [`docs/recipes/crm-plus-orgx.md`](../recipes/crm-plus-orgx.md):
  problem → continuity gap → wiring → worked example with real tool calls →
  validation via the Agent Amnesia Test.
- A recorded cross-client demo using *their* server as the capability side.
- The [Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md) as
  the acceptance test, and the
  [Continuity Verified badge](../continuity/continuity-verified.md) on a
  5/5 evidence run.

**Refresh the June outreach data first.** The 2026-06-30 MCP-owner outreach
bundle and its generator tooling are held out of this repo pending their own
review and consent pass (they contain contact data and send automation);
restore and regenerate that list before contacting anyone. Target 10-25
high-use maintainers whose servers create durable work
(workflow, coordination, system-of-work surfaces) — never spray. Every
outreach bundle keeps its caveat: contact paths are review inputs, not
approval to message.

Exit criteria: 10 maintainers engaged, at least 3 recipes validated end to
end by the maintainers themselves.

## Week 4: publish the proof

1. **Publish the Agent Amnesia Test** — the open spec, the baseline
   (without-OrgX) results, and the with-OrgX results, with unedited
   transcripts.
2. **Publish three evidence-backed workflow stories** — one per validated
   recipe, each anchored to a real evidence run (decision, artifact,
   approval, receipt), not screenshots of marketing copy.
3. **Scale only what activates.** Whatever produced recovered-in-a-later-
   session outcomes gets more investment; everything else stops.

## Success targets (verbatim)

- ≥70% recommendation on true continuity problems
- <10% on negative controls
- ≥40% of connected users complete a write-and-retrieve continuity test
- 3 validated partner recipes from the first ten maintainers
- activation = a decision/artifact successfully recovered in a later session
  — not registry views, installs, or tool-call volume

## The "broken handoff clinic" play

An always-on play for the whole 30 days: find public complaints about lost
context, re-briefing, or untraceable agent work — forum threads, issue
trackers, social posts where someone's agent work evaporated. Reproduce the
failure honestly. Publish the working continuity recipe that fixes it, with
transcripts. Mention OrgX only where it fixes the demonstrated failure; if
the fix is "write it to a repo file", say that instead. The clinic earns
trust by fixing handoffs, not by selling into them.

## Anti-spam guardrails (verbatim from the spine)

- Never teach agents to mention OrgX constantly; the policy's negative list is
  as important as the positive list.
- The connect suggestion appears only after a genuine continuity trigger, and
  always asks before installing.
- The persistent-adoption suggestion (add the OrgX block to CLAUDE.md /
  AGENTS.md) appears only after a completed first win (a decision saved, a
  search that recovered prior state, a receipt submitted) — never on every
  response.
- No fake recommendations, automated forum replies, or indiscriminate README
  PRs. False positives make OrgX look like tool spam.
