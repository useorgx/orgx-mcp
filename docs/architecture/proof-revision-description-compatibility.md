# OrgX proof revision description compatibility

Use the typed `artifact.predecessor` input when the client advertises it. A client
with a cached completion schema can instead put this documented encoding in the
declared `artifact.description` string for a **task**:

```text
orgx:proof-revision:v1:{"predecessor":{"artifact_id":"33333333-3333-4333-8333-333333333333","expected_version":2,"expected_updated_at":"2026-10-10T07:00:00.123+02:00"},"description":"Corrected implementation proof."}
```

Send one complete envelope, using `JSON.stringify` without added JSON whitespace.
The whole description must fit the existing 4,000-character limit. Read the prior
artifact's actual ID, version and updated timestamp; do not guess a predecessor.
The envelope permits only `predecessor` and optional `description`. The predecessor
permits only `artifact_id`, `expected_version` and `expected_updated_at`. OrgX
rejects malformed, duplicate or privileged members, unsupported carrier versions,
and disagreement with a separately supplied typed predecessor.

The namespace `orgx:proof-revision:` is reserved. The restored description cannot
begin with it or contain another revision envelope at its start.

OrgX restores the original description and the typed predecessor before request
hashing and proof registration. Typed and encoded forms of the same material use
the same default retry key. Identical retries reuse the recorded proof and recheck
remaining completion gates; completed command retries reuse existing receipts.
A changed witness or proof needs a new key. A stale or out-of-scope predecessor
fails in the existing atomic replacement transaction. Historical content and
reviews remain intact.

This encoding carries a revision witness. The current proof still needs its own
modality evidence, required independent evaluations and permitted completion
transition. It cannot supply a quality result, human ruling or task status. Use it
only with `orgx_complete_work_with_proof` on a task after both core and MCP releases
that support this contract are verified. Other attachment operations treat the
string as ordinary text and do not register a replacement.
