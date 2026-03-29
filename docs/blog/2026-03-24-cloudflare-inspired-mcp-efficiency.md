# How We Used Cloudflare's MCP Posts to Cut OrgX MCP Overhead

On March 24, 2026, Cloudflare published [Sandboxing AI agents, 100x faster](https://blog.cloudflare.com/dynamic-workers/), building on two related posts:

- [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/)
- [Slashing agent token costs by 98% with RFC 9457-compliant error responses](https://blog.cloudflare.com/rfc-9457-agent-error-pages/)

Those posts are directionally right for any serious MCP implementation: the biggest wins usually come from shrinking the surface area the model sees, collapsing intermediate chatter, and making error and state handoffs machine-readable.

We applied that lens to `orgx-mcp` and implemented the highest-confidence, lowest-risk optimizations first.

## What we changed

We did not rewrite OrgX MCP into a two-tool `search + execute` server yet.

Instead, we shipped a smaller first pass:

1. Compacted always-on session copy.
   We shortened the natural-language text emitted for:
   - first-session welcome
   - welcome-back digest
   - client skill onboarding
   - client activation progress

   The rich machine-readable structures are still present. We trimmed the prose that was being injected into the conversation on normal tool calls.

2. Removed duplicated widget error payloads.
   Widget failures no longer emit both JSON text and plain text into the model context. The detailed object remains in `structuredContent`; the content block now stays short.

3. Cached hydration access tier lookups.
   Hydrated task/entity reads were repeatedly calling billing usage to resolve the same user's hydration tier. We added a 5-minute in-memory cache for that path.

4. Deduplicated and parallelized context hydration.
   Task context hydration previously awaited entity/artifact/plan-session fetches serially and refetched duplicates. We now collapse repeated targets and resolve unique fetches in parallel before rebuilding the response in order.

## What we measured

We added a benchmark-style test in `tests/mcpEfficiencyImpact.spec.ts` and verified the worker with:

```bash
pnpm exec vitest run
pnpm type-check
```

Result: all 83 tests passed, and typecheck passed.

### Session-copy token reduction

Our benchmark used representative outputs for the four always-on copy blocks we changed.

| Surface | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| New session welcome | 162 tokens | 30 tokens | -81% |
| Welcome-back digest | 130 tokens | 65 tokens | -50% |
| Skill onboarding | 98 tokens | 39 tokens | -60% |
| Activation progress | 74 tokens | 21 tokens | -72% |
| **Total** | **464 tokens** | **155 tokens** | **-67%** |

This is not a synthetic "whole tool surface" benchmark. It is a measured reduction on real response copy paths that were previously injected into normal conversations.

### Hydration-path fetch reduction

We also added targeted tests for the two biggest read-path inefficiencies:

- Repeated hydration tier resolution for the same user now hits OrgX billing once within the cache TTL.
  In the test case, two consecutive resolutions became one upstream billing call.
- Duplicate context pointers no longer trigger duplicate fetches.
  In the test case, 4 context pointers with 2 duplicate targets collapsed to 2 upstream fetches.

That gives us two concrete fetch-path wins:

- same-user tier resolution on repeat hydrated reads: 2 calls to 1, a 50% reduction on the repeated path
- duplicate hydration targets in a single read: 4 logical refs to 2 upstream fetches, a 50% reduction in the sample case

We also parallelized unique hydration fetches, which reduces latency even when the number of upstream calls does not change.

## Why these changes came directly from the Cloudflare posts

Cloudflare's three posts point to the same core idea from different angles:

- `code-mode-mcp`: reduce model-visible surface area
- `rfc-9457-agent-error-pages`: stop sending verbose human-first payloads to models
- `dynamic-workers`: move multi-step execution into a controlled server-side runtime when the workflow is large enough

We applied the first two ideas immediately:

- keep the structured data, reduce the prose
- stop duplicating payloads across multiple text blocks
- stop paying repeated fetch costs for the same information

We have not yet applied the full `search + execute` / server-side Code Mode model to OrgX MCP. That remains the next large step if we want to materially shrink the 55-tool surface and push toward the kind of 80%+ discovery-token reduction Cloudflare reports for larger APIs.

## What remains

The next major optimization is still ahead of us:

1. Introduce progressive capability discovery for long-tail OrgX workflows.
2. Keep a small set of explicit high-UX tools.
3. Move exploratory, multi-call, long-tail workflows behind a compact `search + execute` style interface.
4. Standardize machine-readable error contracts across the MCP boundary.

The important part is that we now have a measured first pass, not a theory:

- 67% less session-copy token overhead on the paths we changed
- fewer repeated upstream calls on hydrated reads
- no loss of test coverage or type safety

That is exactly the kind of incremental, quantifiable improvement loop these Cloudflare posts encourage.
