# Canonical domain contracts

OrgX owns claimed delegation evidence and the atomic scaffold wire contract.
The entity vocabulary also comes from OrgX. The MCP facade retains workspace
in its lifecycle route list; OrgX's domain lifecycle list excludes it. Neither
list grants permission to perform an operation.
Producer proof input schemas and revision description decoding also come from
OrgX's `artifactProofInput` contract. Existing facade exports remain available.
The cached-client verification decoder stays on its existing server call path;
MCP continues to adapt producer input. Receipt purpose, review eligibility,
completion, authorization and acceptance remain server-owned.
MCP consumes the pinned generated modules in `src/generated/`; protocol
envelopes, operation descriptions and host rendering remain in the Worker.
Claim waiting and all resource, token, review and execution admission checks
remain in OrgX.

Run `node scripts/check-mcp-domain-contracts.mjs` to verify source and fixture
SHA256. To compare with the canonical checkout, add `--orgx-root <checkout>`.
Refresh from that checkout using
`node orgx/scripts/generate-mcp-domain-contracts.mjs --mcp-root <mcp-checkout>`.
Then regenerate the normal catalog and discovery snapshots and run the
contract suites. Never edit generated domain modules first.

The portable scaffold schema uses the common Zod3/4 API. Both products retain
their locked dependencies. Tests characterize known UUID and URL whitespace
differences; OrgX's parser remains authoritative. The richer legacy scaffold
retains its previous source-evidence contract until the server supports all
its fields and behavior.

These modules add no network operations. Old and new adapters preserve the
v2 delegation response contract, including opaque IDs and extra receipt fields.
The extraction targets existing server capabilities;
rolling back either client preserves the server's admission rules. Reuse a
retry key only with identical declared material. A missing claimed receipt
does not permit replaying paid work.

Task prediction input and pending record shapes are generated from OrgX `packages/contracts/src/taskPrediction.ts` (`task_prediction_v1`). The canonical duplicate-index rule is shared, while MCP preserves its original per-index error paths and additive JSON output parsing. OrgX retains strict server parsing and all prediction scoring, registration and authority logic. Shared fixtures pin each installed Zod version's existing UUID and diagnostic behavior; they do not assert universal cross-version parser equivalence.

Metric registration is generated from OrgX's closed observer registry, strict registration shape and dependency-free registration policy. MCP retains the existing flattened argument profile, defaulting/diagnostic behavior and regex parsing. Canonical strict schemas remain available for compatibility tests under both installed Zod releases; TypeScript body fields derive from the canonical schema while preserving the legacy extensible parameter projection. Client argument parsing is not server workspace admission, observer evaluation or grant authority.

Dispatch acceptance bytes use OrgX's generated `dispatch_acceptance_serialization_v1` codec. The old `canonicalJson` and `hashAcceptanceContract` exports remain compatible aliases/wrappers. This historical encoding retains lexical numeric-key ordering and legacy unsupported-value behavior, so it must not be replaced by the general contract digest. Shared golden fixtures pin material and bare SHA256; the codec does not observe, verify or accept work.

Pure legacy scaffold planning now comes from OrgX's versioned `legacy_scaffold_plan_v1` and preparation companion. The `buildScaffoldInitiativeBatch` facade preserves original behavior; `buildScaffoldHierarchy` retains edge rendering. The original producer-check parser is an explicit callback, so this contract neither imports client protocol nor claims server admission. Seventy-four original-source golden plans pin aliases, defaults, estimates and dependency materialization. The legacy batch transport and handler sequence remain unchanged until a complete compatible server command and capability advertisement are available.
