# MCP-owner first-125 experiment

This is a proof-first partner motion, not a registry-volume campaign. It is
designed for MCP maintainers whose product creates work that must survive a
handoff between sessions, agents, tools, or teammates.

## Non-negotiable gates

Do not activate an external campaign until all of these are true:

1. `useorgxpartners.com` has a dedicated Google Workspace mailbox, not Namecheap forwarding.
2. Google domain verification, MX, SPF, DKIM, and DMARC are published and verified.
3. The mailbox is connected to Instantly, warmed for at least 14 days, and has a conservative campaign cap of 25 total messages per day.
4. Every recipient has a named owner/operator, a business contact path verified from a public source, a one-sentence relevance note, and a suppression/opt-out check.
5. Each lead has been reviewed as a legitimate business contact. Do not guess addresses, scrape personal inboxes, or send to generic lists.
6. The campaign includes the sender identity, a valid business mailing address, and an obvious one-step opt-out. Reply-stop, global blocklist, and stop-on-reply must be enabled.
7. Do not send a generic proof-page link as the primary CTA. The currently live
   [`hope-ux` walkthrough](https://mcp.useorgx.com/hope-ux.html) is a useful
   product explainer, but it has no booking destination and is not tailored to
   an owner. A proof-page experiment begins only after each cohort has a
   relevant recipe page and a functioning booking URL.

`artifacts/outreach/` is intentionally local-only. It may contain public
registry and repository research, but never contact details, consent state, or
live send state in version control.

## Domain and mailbox cutover

On 2026-07-13, `useorgxpartners.com` resolves but is still configured for
Namecheap forwarding: its MX records point to `eforward*.registrar-servers.com`,
its SPF record includes `spf.efwd.registrar-servers.com`, and it has no DMARC
record. It must not be used for outreach in that state.

1. In the existing `useorgx.com` Google Workspace tenant, add
   `useorgxpartners.com` as a secondary domain. Publish the exact Google
   verification TXT record the Admin console produces.
2. Create the dedicated `hope@useorgxpartners.com` user. This is an additional
   seat in the existing tenant, not a separate Workspace subscription.
3. Disable Namecheap email forwarding and remove its `eforward*` MX records.
   Per Google's current Workspace guidance, publish one MX record with priority
   `1` and value `smtp.google.com`.
4. Publish one consolidated SPF record. For Google-only sending, begin with
   `v=spf1 include:_spf.google.com ~all`; do not leave the forwarding include
   in place or publish multiple SPF records.
5. Generate a DKIM record in Google Admin, publish the selector/value supplied
   there, wait for DNS propagation, then turn DKIM on. Add DMARC with
   monitoring policy `p=none` and a monitored report mailbox; move to
   quarantine only after aligned SPF/DKIM traffic is clean.
6. Connect the new mailbox to Instantly by Google OAuth, enable warm-up, and
   keep the campaign paused until the 14-day warm-up and seed-test gates pass.

Do not accept an OAuth permission or submit an additional Workspace-seat
charge without an action-time confirmation.

## Build the research universe

```bash
pnpm outreach:rank-mcp-owners -- --limit 125 \
  --out artifacts/outreach/mcp-owner-first-125.json
```

The ranker uses the official MCP Registry public API and returns one
representative server per GitHub owner. It requires an explicit workflow,
handoff, decision, team, customer, ticket, knowledge, or orchestration signal
and rejects obvious incidental matches such as consumer automation, data
catalogs, and parsers. A rank is only a research priority, never permission to
contact someone.

## Next sends

The next actual external sends are **not** the 125 contacts today. The first
messages after all gates pass are:

1. Three internal seed messages from `hope@useorgxpartners.com` to controlled
   inboxes. Verify authentication alignment, inbox placement, reply handling,
   and unsubscribes. No prospect sends on a failure.
2. Eight owner-level, text-only first touches from the highest-ranked,
   contact-verified research records. Four use Variant A and four use Variant
   B. One owner/company receives at most one message.
3. Eight more new first touches per day, for fifteen days, then five on day
   sixteen. Each first touch receives a follow-up on day four and a final
   close-the-loop message on day eleven only when there has been no reply or
   opt-out.

This reaches 125 first touches over sixteen days. With the two follow-ups, the
plan remains under a 25-message daily campaign cap after warm-up.

### First eight, after infrastructure and contact gates pass

These are account-level research priorities, not email addresses. Each needs a
named owner/operator, public business contact path, relevance note, and final
review before it enters Instantly.

| Variant | GitHub owner | MCP server | Why this is in the pilot |
| --- | --- | --- | --- |
| A | `CSOAI-ORG` | `agent-handoff-certified-mcp` | Direct agent-to-agent handoff and provenance fit. |
| B | `cyanheads` | `workflows-mcp-server` | Durable workflow playbooks for LLM agents. |
| A | `clauxel` | `agenticbudgetrouter-mcp` | Workflow approvals and usage receipts are a direct proof boundary. |
| B | `taskforcehq` | `taskforce` | Task/planning workspace for humans working with AI agents. |
| A | `doriku-io` | `task-manager` | Shared control plane for coding-agent tasks, memory, decisions, and locks. |
| B | `wyre-technology` | `autotask-mcp` | Customer tickets, projects, and time-entry workflows. |
| A | `mindstone` | `mcp-server-salesforce` | CRM accounts, opportunities, leads, and tasks create durable ownership state. |
| B | `crunchtools` | `gitlab` | Merge requests, issues, and pipelines provide an engineering-workflow recipe. |

### Instantly campaign configuration

- Keep the campaign paused through mailbox warm-up and the three internal seed
  tests.
- Text only; no images, attachments, open tracking, or click tracking in the
  first 125.
- Campaign cap: 25 total messages/day. Company cap: one owner/company in this
  experiment. Stop on reply and global blocklist: enabled.
- Send only Tuesday through Thursday in the recipient's local business hours.
- Add every unsubscribe and `not_relevant` response to the blocklist before
  the next scheduled send window.

### Variant A: tailored integration recipe

**Subject:** `A continuity recipe for {{server_name}}`

```text
Hi {{first_name}},

I noticed {{specific_product_or_workflow_observation}}.

The failure point is usually a task crossing a session, agent, or teammate:
the next run has the tool, but not the decision, owner, or proof from the last
one. We built a short {{server_name}} + OrgX recipe that makes that handoff
recoverable.

Worth sending you the tailored recipe for one real workflow?

Hope
P.S. Reply "stop" and I will not follow up.
```

### Variant B: broken-handoff teardown

**Subject:** `When {{server_name}} work outlives the chat`

```text
Hi {{first_name}},

{{specific_product_or_workflow_observation}} made me think of the handoff
gap: an agent can call {{server_name}}, but the next agent often cannot recover
what was decided, who owns the next step, or the proof that it happened.

I can send a three-minute teardown of that workflow and the smallest OrgX
integration that makes it resumable. Useful?

Hope
P.S. Reply "stop" and I will not follow up.
```

### Follow-up 1: day four

```text
Hi {{first_name}},

One concrete use case is {{specific_handoff_example}}. The goal is not another
system of record; it is to let the next agent recover the decision, artifact,
owner, and verification without a re-brief.

Should I send the recipe, or is this outside {{company_name}}'s current work?

Hope
```

### Follow-up 2: day eleven

```text
Hi {{first_name}},

I will close this out. If cross-session handoffs are not a problem for
{{company_name}}, no reply needed. If they are, reply "recipe" and I will send
the tailored integration rather than another pitch.

Hope
```

## Experiment design

Use one experiment at a time. Randomize Variant A/B deterministically by the
GitHub owner so that score deciles and categories stay balanced. Do not change
the offer, copy, audience, and daily volume in the same window.

| Question | Control | Variant | Decision metric |
| --- | --- | --- | --- |
| Which opening earns relevant conversations? | Tailored integration recipe | Broken-handoff teardown | Positive replies per delivered message |
| Which category activates? | All other categories | Category cohort | Qualified conversations and recipe requests |
| Does the proof room reduce friction? | Email only | Email plus tailored proof-room link | Meetings or a real workflow supplied |

Primary metrics are delivered messages, positive replies, qualified
conversations, recipes requested, meetings booked, and later recovered-work
events. Opens are not a decision metric. Track `reply`, `positive`,
`not_now`, `not_relevant`, `opt_out`, `bounce`, and `meeting` at the lead
level.

Evaluate a copy variant only after 30 delivered first touches. Continue the
winner only when it improves positive-reply rate without a worse bounce,
opt-out, or complaint signal. Stop the campaign immediately for any complaint,
an opt-out processing failure, or a hard-bounce rate above 2% after 25
delivered messages. Re-check the address source, targeting, and authentication
before resuming.

The proof-room row is not active in the first 125 until the page and booking
requirements above are met. The initial CTA is a reply asking for a tailored
recipe or a real workflow to evaluate.

## What counts as a win

A reply alone is not activation. A qualified win is a maintainer who supplies
one real workflow and receives a working recipe that proves a later agent can
recover the relevant decision, artifact, owner, or receipt. Scale only after
that proof, not from registry views, opens, or raw send volume.
