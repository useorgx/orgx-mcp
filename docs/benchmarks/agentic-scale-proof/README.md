# Agentic Scale Proof

This public harness tests the bounded contracts OrgX needs before claiming it
can govern Jalapeño-scale autonomous work. It separates raw telemetry volume
from accountability volume, injects adversarial failures, and verifies one
portable proof packet using two dependency-free implementations.

Run the canonical scale workload:

```bash
pnpm benchmark:agentic-scale
```

Verify the same packet independently:

```bash
pnpm verify:agentic-scale:js
pnpm verify:agentic-scale:python
```

Run both verifiers against tampered and semantically invalid packets:

```bash
pnpm test:agentic-scale
```

The canonical workload contains 50,000 agent identities and 1,000,000 episode
nodes. It injects duplicates, reordering, drops, expired leases, stale policy,
clock skew, replay, hidden branches, out-of-band effects, and correlated judges.
The latest raw result is committed as [`latest.json`](./latest.json).

## Claim boundary

Passing this harness proves deterministic protocol behavior on the machine that
ran it. It does not prove production network capacity, real-work receipt
coverage, an independently operated transparency log, third-party review, or a
realized customer outcome. Those remain separate acceptance evidence and must
never be inferred from this fixture.

The fixture declares `fixture_class: synthetic_contract_fixture` for the same
reason. Its closed outcome exercises both verifier implementations; it is not a
customer-outcome claim.
