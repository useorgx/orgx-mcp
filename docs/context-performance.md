# OrgX context delivery

Use the existing tools to prepare, inspect changes, and expand evidence:

- `orgx_bootstrap`: prepare current context. Pass `initiative_id` for initiative scope.
- `orgx_tail`: inspect the supported material event feed. This does not verify a
  capsule base or reconstruct complete current context. Bootstrap again before
  consequential action and recheck applicable permissions and revisions.
- `orgx_inspect`: expand a referenced entity or artifact. Count expanded content
  in the receiving model's total input budget.

Bootstrap carries the app's `context_delivery` metadata when available. A null
value from an older app deployment means the guarantee is unknown. Current
capsules use best-effort reads. Empty bounded results do not prove that no other
relevant information exists.

Proposed targets and measurement status are available after the app change ships
at `https://useorgx.com/.well-known/orgx-performance.json`. No comparative speedup,
coherent snapshot, exact model-token count, or customer SLA is established here.


Bootstrap now requests the context transfer protocol and reconstructs full or
acknowledged delta responses before returning the established tool response.
The bounded cache is optional; loss or an invalid base triggers a fresh read.
Every request still authenticates and prepares current context on the app.
Workspace capsule snapshots can report `database_snapshot`; initiative frames
include additional reads and remain `best_effort_multi_read`. Transport reuse
does not grant action authority or establish comparative performance.
