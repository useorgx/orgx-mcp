# OrgX operation cutover adversarial review

The review compares the operation refactor with source baseline `44d18580ea5f9f9e030f6f47fdf7cf7d2895e793`, then integrates the latest `main` changes before publication. The [before-and-after inventory](tool-inventory-before-after.md) lists every old ChatGPT/default descriptor and every proposed descriptor. This is a coordinated cutover: current clients update together and reconnect. Historical descriptor parity is not a release requirement.

## Findings fixed in the initial descriptor review

- Generic entity completion must not shadow runtime `orgx_complete_work`. The runtime command requires `task_id`, `expected_updated_at`, and `expected_aggregate_version`; the separate generic operation is `orgx_complete_entity`.
- Fixed operation adapters must advertise their actual result envelopes, while intentionally supported native runtime adapters must retain their own result contracts. Schema inference must follow the registered implementation rather than an operation with a coincidentally equal name.
- Alias output-schema resolution must not depend on whether the alias target belongs to the current ChatGPT profile. This matters for active runtime profiles that remain separate from the new public workflow catalog.
- Human receipt rulings require a signed, revision-bound approval capability. Producer verification and acceptance fields are claims; import cannot authorize a human ruling. An unavailable capability never falls back to unsigned approval.

## Current review

The review also examines plan compare-and-set behavior, receipt revision identity, workspace boundaries, callback authorization, current advertised tool instructions, and installed-client configuration. Concrete findings and verification are recorded in the pull request descriptions after the final fixes. Source checks do not establish production deployment, a successful provider scan, or publication of the reconstructed ChatGPT plugin candidate.
