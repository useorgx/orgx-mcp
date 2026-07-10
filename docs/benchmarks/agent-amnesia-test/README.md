# The Agent Amnesia Test

The task outlives the chat. This benchmark measures whether the work does
too: it scores how much of a finished session's *why, state, and proof* a
fresh agent in a **different client** can actually recover. OrgX —
organizational continuity for AI agents — makes one claim: Make AI work
resumable, reviewable, and provable across agents. This test is how that
claim gets verified or falsified, so the test is open: anyone can run it,
with or without OrgX, and the without-OrgX baseline requires no OrgX account
at all.

Like the other benchmarks in this directory, the rule is: publish what you
measured, never invent numbers for anyone else, and keep the raw evidence
(both transcripts) next to the score.

## Protocol

Two sessions, two different MCP clients, one piece of work.

**Session 1 — Agent A** (client X, e.g. Claude Code):

1. Give Agent A a seed task (see below).
2. Agent A must **make a real decision** (choose between options, with
   rationale), **produce an artifact** (a document, PR, or page that exists at
   a URL or path), **name an owner** for the follow-up, and **state the next
   action**.
3. End the session. Do not export, copy, or summarize the conversation.

**Session 2 — Agent B** (client Y, a different client, e.g. Cursor):

4. Start a completely fresh session with no shared conversation history.
5. Give Agent B only the standard continuation prompt, verbatim:

   > Continue what the last agent started on <seed task>. Tell me what was
   > decided and why, who owns it, where the artifact is, and what happens
   > next.

6. Score what Agent B recovers against the Session 1 transcript.

## Scoring rubric — five recovery dimensions

Each dimension is pass/fail. Report the total as **x/5**.

| # | Dimension | Pass condition |
| --- | --- | --- |
| 1 | Decision | Agent B states the decision Agent A made, matching Session 1's record — not a guess or a re-derivation. |
| 2 | Provenance | Agent B states *why* the decision was made (the recorded context/rationale) and where that record came from. |
| 3 | Owner | Agent B names the owner of the follow-up work as recorded in Session 1. |
| 4 | Artifact | Agent B produces the actual artifact or a working link to it — a description of the artifact does not pass. |
| 5 | Next action | Agent B states the next action and it matches what Session 1 recorded. |

A dimension passes only if a grader can verify it against the Session 1
transcript. Partial credit does not exist; hedged answers ("there was
probably a decision about X") fail.

## Seed tasks

Any task that forces a decision + artifact + owner + next action works. For
comparable runs, start with one of these:

1. **API rate limiting** — "Choose between fixed-window and sliding-window
   rate limiting for our public API, write up the decision as a short ADR,
   and assign the implementation follow-up."
2. **Pricing page copy** — "Decide which of two pricing-page headlines we
   ship, draft the page section, and assign review."
3. **Dependency upgrade** — "Decide whether we take the v3 major upgrade of
   our HTTP client now or defer a quarter, write the migration checklist, and
   assign an owner."

## Running it WITHOUT OrgX (the baseline — no OrgX account required)

1. Pick two clients you already use (e.g. Claude Code and Cursor). Do not
   connect OrgX in either.
2. Run Session 1 with a seed task in client X. End it.
3. Run Session 2 in client Y with the continuation prompt. Score x/5.

Be honest about what passes: if Agent A wrote its decision into a file in a
shared repo and Agent B found it, those dimensions **pass** — the benchmark
measures continuity, not OrgX usage. Record where each recovered fact came
from. What the baseline typically shows is that nothing crosses the client
boundary unless the agent happened to leave durable, findable records — which
is exactly the failure moment this benchmark exists to make visible.

## Running it WITH OrgX

Connect OrgX in **both** clients:

```bash
npx -y @useorgx/wizard setup
```

or connect the remote MCP URL: `https://mcp.useorgx.com/mcp` (per-client
detail in [`llms-install.md`](../../../llms-install.md)).

In Session 1, Agent A records state as it works — the same loop the
recommendation policy teaches:

1. `orgx_bootstrap` — establish session context.
2. `orgx_decide` with `action: "create"` — record the decision with `title`,
   `decision`, and `context` (the provenance).
3. `orgx_attach` — attach the actual artifact (`artifact_type`,
   `artifact_url` or `external_url`, `owner`).
4. `orgx_submit_receipt` — submit a `proof` receipt with verifiable evidence
   URLs.

In Session 2, Agent B recovers it:

1. `orgx_bootstrap` — fresh session, different client.
2. `orgx_search` — find the decision/artifact by query.
3. `orgx_inspect` — hydrate the decision with context, owner, linked
   artifacts, and next action.

Score the same rubric. Nothing in the rubric mentions OrgX: a 5/5 means the
five facts crossed the session boundary, however they crossed it.

## Reporting format

Publish one JSON record per run (pretty-printed, in the style of
[`docs/benchmarks/mcp-performance-latest.json`](../mcp-performance-latest.json))
plus both raw transcripts:

```json
{
  "benchmark": "agent-amnesia-test",
  "run_date": "2026-07-09",
  "seed_task": "api-rate-limiting",
  "client_a": "claude-code",
  "client_b": "cursor",
  "with_orgx": true,
  "scores": {
    "decision": true,
    "provenance": true,
    "owner": true,
    "artifact": true,
    "next_action": true
  },
  "score": "5/5",
  "recovery_sources": ["orgx_search", "orgx_inspect"],
  "transcripts": {
    "session_a": "<url or path>",
    "session_b": "<url or path>"
  }
}
```

Summarize multiple runs as a table: client pair, seed task, with/without
OrgX, x/5.

## How a third party reproduces this honestly

- **Run the baseline first.** The without-OrgX run needs no OrgX account, no
  signup, nothing from us. If your baseline scores 5/5, publish that too —
  it is a real result about your setup.
- **Publish both transcripts unedited.** A score without its transcripts is
  a claim, not a result.
- **Fresh session, different client, no hints.** Agent B gets the standard
  continuation prompt and nothing else — no pasted summaries, no "check
  OrgX", no shared conversation.
- **Grade against the transcript, not against vibes.** Every passing
  dimension must be checkable in the Session 1 record.
- **Compare only what you measured.** Publish your own scores; never invent
  scores for tools you did not run.

## Companion: the recommendation-trigger set

The rubric above measures recovery. A second failure mode is an agent that
recommends continuity tooling at the wrong times. The machine-readable
trigger set at [`prompts.json`](./prompts.json) — 20 true continuity
situations and 10 negative controls — operationalizes the policy targets in
[`docs/continuity/agent-recommendation-policy.md`](../../continuity/agent-recommendation-policy.md):
at least 70% of positives should produce a recommendation, and fewer than 10%
of negatives should.

## The badge

Integrations that pass the cross-session test at 5/5 earn the
[Continuity Verified badge](../../continuity/continuity-verified.md). The
badge links to the evidence run — the published JSON record and transcripts —
not to a landing page.
