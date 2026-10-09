#!/usr/bin/env python3
"""Build a deterministic local upload candidate, without network or publishing."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

from verify_package import ROOT, package_files, verify


def archive() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in package_files():
            info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return stream.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT.parent / "artifacts/orgx-chatgpt-plugin-1.1.0.zip")
    parser.add_argument("--verify-reproducible", action="store_true")
    args = parser.parse_args()
    result = verify()
    data = archive()
    if args.verify_reproducible and data != archive():
        raise ValueError("Package generation is not reproducible")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    args.output.with_suffix(".zip.sha256").write_text(f"{digest}  {args.output.name}\n")
    print(json.dumps({**result, "archive": str(args.output.resolve()), "bytes": len(data),
                      "sha256": digest, "reproducible": args.verify_reproducible}, sort_keys=True))


if __name__ == "__main__":
    main()
