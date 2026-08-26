# OrgX MCP Performance Benchmarks

OrgX optimizes MCP for agent price/performance: low edge latency, compact tool
payloads, dependable follow-up execution, and high leverage per tool call.

This directory also hosts the [Agent Amnesia Test](./agent-amnesia-test/README.md),
an open cross-session continuity benchmark: it scores how much of a finished
session's why, state, and proof a fresh agent in a different client can recover.
The [Agentic Scale Proof](./agentic-scale-proof/README.md) adds a deterministic
50,000-agent / 1,000,000-node adversarial workload plus cross-language proof
packet verification. Its claim boundary explicitly excludes production and
customer-outcome claims.
The same rule applies to both harnesses: publish what you measured, and keep
the raw evidence next to the score.

Run the public benchmark:

```bash
pnpm benchmark:mcp
```

Run authenticated discovery as well:

```bash
MCP_BENCHMARK_AUTH_TOKEN=... pnpm benchmark:mcp
```

The harness writes `docs/benchmarks/mcp-performance-latest.json` by default and
prints p50/p95/max latency for:

- `/health`
- `/server.json`
- public `tools/list`
- authenticated `tools/list` when `MCP_BENCHMARK_AUTH_TOKEN` is set

## Current Targets

| Scenario | Target p95 |
| --- | ---: |
| Edge health | 150 ms |
| Server metadata | 100 ms |
| Public tools/list | 150 ms |
| Authenticated tools/list | 250 ms |
| `scaffold_initiative` fast acknowledgement | 1,500 ms |

`scaffold_initiative` is intentionally not run by the public benchmark because it
creates durable work records. The worker now exposes `response_mode`:

- `fast_ack` returns after durable hierarchy creation and queues assignment,
  billing-consume, credential checks, launch, stream snapshot, and fallback
  dispatch asynchronously.
- `complete` preserves the older behavior and waits for those follow-ups before
  returning.

## Competitor Framing

Most competitors publish rate limits and supported tools, not MCP latency SLOs.
Use this harness to publish OrgX's own measured latency while comparing against
public constraints:

- Linear publishes GraphQL request and complexity limits.
- Atlassian publishes Rovo MCP calls-per-hour limits by plan.
- Notion publishes MCP/API request limits and a lower search-specific cap.
- MCP-Atlas measures end-to-end model tool-use success across real MCP servers;
  it is not a per-server latency benchmark.
