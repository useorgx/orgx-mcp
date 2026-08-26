#!/usr/bin/env python3
"""Dependency-free second implementation of the public proof-packet verifier."""

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path


def canonicalize(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(value):
    return "sha256:" + hashlib.sha256(canonicalize(value).encode("utf-8")).hexdigest()


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def verify(packet):
    failures = []
    payload = dict(packet)
    payload.pop("content_digest", None)
    if packet.get("schema") != "orgx.agentic-scale-proof.v1":
        failures.append("unsupported_schema")
    if sha256(payload) != packet.get("content_digest"):
        failures.append("content_digest_mismatch")

    missing = [item["id"] for item in packet["expected_evidence"] if item["required"] and not item.get("observed_ref")]
    if missing:
        failures.append("missing_required_evidence:" + ",".join(missing))

    unaccounted = [
        branch["id"]
        for branch in packet["branches"]
        if branch["material"]
        and (not branch.get("disposition") or (branch["disposition"] == "adopted" and not branch.get("selection_receipt_ref")))
    ]
    if unaccounted:
        failures.append("unaccounted_branches:" + ",".join(unaccounted))

    assurance = packet["assurance"]
    for dependency, digest in assurance["digests"].items():
        if packet["current_digests"].get(dependency) != digest:
            failures.append("stale_assurance:" + dependency)
    if parse_time(assurance["expires_at"]) <= parse_time(packet["verified_at"]):
        failures.append("expired_assurance")
    if packet["expectation"].get("state") != "outcome_realized" or not packet["expectation"].get("observation_ref"):
        failures.append("outcome_not_closed")

    return {"implementation": "python-stdlib", "valid": not failures, "failures": failures}


path = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/benchmarks/agentic-scale-proof/fixtures/proof-packet.json")
result = verify(json.loads(path.read_text(encoding="utf-8")))
print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if result["valid"] else 1)

