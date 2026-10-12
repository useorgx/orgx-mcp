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
