# Continuity Verified

An earned badge for MCP integrations that prove organizational continuity
for AI agents — awarded **only** when an integration passes the
cross-session [Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md).

The badge is a receipt, not a logo swap. It always links to the evidence run
— the published score record and both unedited transcripts — never to a
landing page.

## What it certifies

A paired integration (a capability server + OrgX, run per one of the
[partner recipes](../recipes/github-plus-orgx.md)) completed the Agent
Amnesia Test protocol at **5/5**:

1. Session 1, in one client, made a decision, produced an artifact, named an
   owner, and stated a next action.
2. Session 2, in a **different client** with no shared history, recovered
   all five dimensions: the decision, its provenance, the owner, the actual
   artifact, and the next action.

Make AI work resumable, reviewable, and provable across agents. — the badge
exists to mark the integrations where that sentence has been demonstrated,
not asserted. The task outlives the chat. A Continuity Verified integration
is one where the work demonstrably outlives it too.

## How to earn it

1. Run the [Agent Amnesia Test](../benchmarks/agent-amnesia-test/README.md)
   with your server as the capability side, following a recipe in
   [`docs/recipes/`](../recipes/github-plus-orgx.md) or an equivalent you
   publish.
2. Publish the evidence run: the JSON score record from the test's reporting
   format plus both unedited transcripts, at a stable URL you control (a
   repo directory works).
3. Open an issue at
   [github.com/useorgx/orgx-mcp](https://github.com/useorgx/orgx-mcp/issues)
   titled `Continuity Verified: <your server>` linking the evidence run. We
   re-run or spot-check the protocol; a verified 5/5 gets listed and may
   display the badge.

## How to display it

The badge image is served from `https://mcp.useorgx.com/badges/continuity-verified.svg`.
The link target must be your evidence run — not your homepage, not a
marketing page:

```markdown
[![Continuity Verified](https://mcp.useorgx.com/badges/continuity-verified.svg)](<evidence-run-url>)
```

A badge whose link does not resolve to a real evidence run is not a
Continuity Verified badge, and we will ask for it to be removed or fixed.

## Staying verified

- The evidence run must stay public at the linked URL.
- Material changes to either side of the pairing (a breaking change in your
  server's tool contract, or in OrgX's — see `server.json` for the current
  contract) call for a re-run. Keep the old evidence up; add the new run
  alongside it.
- Scores below 5/5 are still worth publishing as benchmark results — they
  just are not the badge.

## What it is not

- Not a partnership announcement, endorsement, or co-marketing asset.
- Not purchasable, and not granted for installing OrgX — only for a passing
  cross-session run with published evidence.
- Not permanent decoration: it certifies the linked run, nothing more.
