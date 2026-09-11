"""Read-only ZIP/TAR member access using Python's standard libraries.

No extract()/extractall(), filesystem writes, links or archive code execution.
UTF-8 text pages and hashes are returned over stdout; limits come from the UI.
"""
from __future__ import annotations
import hashlib
import json
import pathlib
import stat
import sys
import tarfile
import zipfile


def main() -> None:
    request = json.load(sys.stdin)
    file = pathlib.Path(request["file"])
    member = request.get("member")
    offset = max(0, int(request.get("offset", 0)))
    limit = min(24000, max(1, int(request.get("limit", 12000))))
    max_bytes = int(request["maxBytes"])
    if file.stat().st_size > max_bytes:
        raise ValueError("Archive exceeds configured source size limit")
    is_zip = zipfile.is_zipfile(file)
    archive = zipfile.ZipFile(file, "r") if is_zip else tarfile.open(file, "r:*")
    with archive:
        entries = archive.infolist() if is_zip else archive.getmembers()
        if len(entries) > 50000:
            raise ValueError("Archive member count exceeds 50000")
        name_of = (lambda m: m.filename) if is_zip else (lambda m: m.name)
        size_of = (lambda m: m.file_size) if is_zip else (lambda m: m.size)
        regular = (lambda m: not m.is_dir() and not stat.S_ISLNK(m.external_attr >> 16)) if is_zip else (lambda m: m.isfile())
        if member is None:
            selected = entries[offset:offset + min(limit, 200)]
            result = {"entries": [{"name": name_of(m), "bytes": size_of(m), "regular": regular(m)} for m in selected],
                      "offset": offset, "totalEntries": len(entries), "nextOffset": offset + len(selected) if offset + len(selected) < len(entries) else None}
        else:
            matches = [m for m in entries if name_of(m) == member]
            if len(matches) != 1:
                raise ValueError("Member missing or ambiguous; use a unique name from the listing")
            item = matches[0]
            if not regular(item) or size_of(item) > max_bytes:
                raise ValueError("Only bounded regular text members are readable, not links/directories")
            stream = archive.open(item, "r") if is_zip else archive.extractfile(item)
            with stream:
                raw = stream.read(max_bytes + 1)
            if len(raw) > max_bytes or b"\0" in raw:
                raise ValueError("Member is binary or exceeds configured source size limit")
            text = raw.decode("utf-8-sig", errors="strict")
            end = min(len(text), offset + limit)
            result = {"member": member, "text": text[offset:end], "offset": offset, "totalCharacters": len(text),
                      "nextOffset": end if end < len(text) else None, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        raise SystemExit(1)
