#!/usr/bin/env python3
"""Create and validate content-addressed worktree reclaim manifests.

The manifest format is shared with devrouter (`workspace cleanup --manifest`):
both tools read either tool's manifests, and `hash`/`select` output is
byte-identical. Canonical JSON uses sorted keys, two-space indentation, UTF-8
without ASCII escaping and one trailing newline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


KIND = "worktree-reclaim-manifest"
# Manifests written before the format was shared; still accepted for reading.
LEGACY_KIND = "rs-worktree-reclaim-manifest"
SCHEMA_VERSION = 1
ACTIONS = {"reclaim", "trim"}
ACTIVITY_SOURCES = {"agent-sessions", "devrouter"}
DEFAULT_ACTIVE_WITHIN_SECONDS = 86400
HEX_SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
HEX_ID_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_ROOT_KEYS = {"activeWithin", "activeWithinSeconds", "allHistory"}
ROOT_KEYS = {
    "action",
    "activitySource",
    "candidateCount",
    "candidates",
    "createdAtEpoch",
    "kind",
    "schemaVersion",
}
LEGACY_ROOT_KEYS = (ROOT_KEYS - {"action", "activitySource"}) | SESSION_ROOT_KEYS
SESSION_CANDIDATE_KEYS = {"sessionAgeSeconds", "sessionEvidence", "sessionProvider"}
CANDIDATE_KEYS = {
    "branch",
    "branchRef",
    "commonDir",
    "gitDir",
    "head",
    "id",
    "path",
    "reason",
    "repo",
}
OPTIONAL_CANDIDATE_KEYS = SESSION_CANDIDATE_KEYS | {"paths", "sizeKb"}


class ManifestError(ValueError):
    pass


def fail(message: str) -> None:
    raise ManifestError(message)


def parse_optional_int(value: str) -> int | None:
    return int(value) if value.isdigit() else None


def identity(candidate: dict[str, Any]) -> dict[str, str]:
    return {
        "branchRef": candidate["branchRef"],
        "commonDir": candidate["commonDir"],
        "gitDir": candidate["gitDir"],
        "head": candidate["head"],
        "path": candidate["path"],
        "repo": candidate["repo"],
    }


def identity_id(candidate: dict[str, Any]) -> str:
    payload = json.dumps(
        identity(candidate), ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def require_exact_keys(
    value: dict[str, Any], expected: set[str], label: str, optional: set[str] | None = None
) -> None:
    actual = set(value)
    allowed = expected | (optional or set())
    if not expected <= actual <= allowed:
        missing = ", ".join(sorted(expected - actual)) or "none"
        extra = ", ".join(sorted(actual - allowed)) or "none"
        fail(f"{label} fields differ (missing: {missing}; extra: {extra})")


def valid_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or "\0" in value or "\\" in value:
        return False
    if value.startswith("/"):
        return False
    return all(part not in {"", ".", ".."} for part in value.split("/"))


def validate_candidate(candidate: Any, index: int, action: str, legacy: bool) -> dict[str, Any]:
    label = f"candidate[{index}]"
    if not isinstance(candidate, dict):
        fail(f"{label} must be an object")
    if legacy:
        require_exact_keys(candidate, CANDIDATE_KEYS | SESSION_CANDIDATE_KEYS | {"sizeKb"}, label)
    else:
        require_exact_keys(candidate, CANDIDATE_KEYS, label, OPTIONAL_CANDIDATE_KEYS)
    if action == "trim":
        paths = candidate.get("paths")
        if not isinstance(paths, list) or not paths:
            fail(f"{label}.paths must be a non-empty array for a trim manifest")
        if not all(valid_relative_path(item) for item in paths):
            fail(f"{label}.paths must hold worktree-relative paths without '..'")
        if paths != sorted(set(paths)):
            fail(f"{label}.paths must be sorted and unique")
    elif "paths" in candidate:
        fail(f"{label}.paths is only valid in a trim manifest")

    for key in (
        "branch",
        "branchRef",
        "commonDir",
        "gitDir",
        "head",
        "id",
        "path",
        "reason",
        "repo",
    ):
        if not isinstance(candidate[key], str):
            fail(f"{label}.{key} must be a string")
        if "\0" in candidate[key]:
            fail(f"{label}.{key} cannot contain a NUL byte")

    for key in ("repo", "path", "commonDir", "gitDir"):
        if not os.path.isabs(candidate[key]):
            fail(f"{label}.{key} must be an absolute path")

    if not candidate["branchRef"].startswith("refs/heads/"):
        fail(f"{label}.branchRef must name a local branch")
    if candidate["branch"] != candidate["branchRef"].removeprefix("refs/heads/"):
        fail(f"{label}.branch does not match branchRef")
    if not HEX_SHA_RE.fullmatch(candidate["head"]):
        fail(f"{label}.head is not a Git object ID")
    if not HEX_ID_RE.fullmatch(candidate["id"]):
        fail(f"{label}.id is not a SHA-256 identifier")
    if candidate["id"] != identity_id(candidate):
        fail(f"{label}.id does not match its immutable identity")

    evidence = candidate.get("sessionEvidence", "")
    if not isinstance(evidence, str) or "\0" in evidence:
        fail(f"{label}.sessionEvidence must be a string")
    provider = candidate.get("sessionProvider")
    if provider is not None and not isinstance(provider, str):
        fail(f"{label}.sessionProvider must be a string or null")
    for key in ("sessionAgeSeconds", "sizeKb"):
        value = candidate.get(key)
        if value is not None and (type(value) is not int or value < 0):
            fail(f"{label}.{key} must be a non-negative integer or null")
    return candidate


def validate_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("manifest root must be an object")
    kind = value.get("kind")
    legacy = kind == LEGACY_KIND
    if kind not in {KIND, LEGACY_KIND}:
        fail(f"manifest kind must be {KIND}")
    if legacy:
        require_exact_keys(value, LEGACY_ROOT_KEYS, "manifest")
        action, activity_source = "reclaim", "agent-sessions"
    else:
        require_exact_keys(value, ROOT_KEYS, "manifest", SESSION_ROOT_KEYS)
        action, activity_source = value["action"], value["activitySource"]
        if action not in ACTIONS:
            fail("manifest action must be reclaim or trim")
        if activity_source not in ACTIVITY_SOURCES:
            fail("manifest activitySource must be agent-sessions or devrouter")
        if activity_source == "agent-sessions" and not SESSION_ROOT_KEYS <= set(value):
            fail("an agent-sessions manifest records activeWithin, activeWithinSeconds and allHistory")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != SCHEMA_VERSION:
        fail(f"manifest schemaVersion must be {SCHEMA_VERSION}")
    if type(value["createdAtEpoch"]) is not int or value["createdAtEpoch"] < 0:
        fail("manifest createdAtEpoch must be a non-negative integer")
    if "activeWithin" in value and (
        not isinstance(value["activeWithin"], str) or not value["activeWithin"]
    ):
        fail("manifest activeWithin must be a non-empty string")
    if "activeWithinSeconds" in value and (
        type(value["activeWithinSeconds"]) is not int or value["activeWithinSeconds"] <= 0
    ):
        fail("manifest activeWithinSeconds must be a positive integer")
    if "allHistory" in value and not isinstance(value["allHistory"], bool):
        fail("manifest allHistory must be a boolean")
    if not isinstance(value["candidates"], list):
        fail("manifest candidates must be an array")
    if type(value["candidateCount"]) is not int or value["candidateCount"] < 0:
        fail("manifest candidateCount must be a non-negative integer")
    if value["candidateCount"] != len(value["candidates"]):
        fail("manifest candidateCount does not match candidates")

    candidates = [
        validate_candidate(row, i, action, legacy) for i, row in enumerate(value["candidates"])
    ]
    if candidates != sorted(candidates, key=lambda row: (row["repo"], row["path"], row["id"])):
        fail("manifest candidates are not in canonical order")

    for key, label in (
        ("id", "candidate ID"),
        ("path", "worktree path"),
        ("gitDir", "worktree Git directory"),
    ):
        values = [row[key] for row in candidates]
        if len(values) != len(set(values)):
            fail(f"manifest contains a duplicate {label}")

    branch_keys = [(row["repo"], row["branchRef"]) for row in candidates]
    if len(branch_keys) != len(set(branch_keys)):
        fail("manifest contains a duplicate repository branch")
    return value


def read_manifest(path: Path) -> tuple[bytes, dict[str, Any]]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        fail(f"cannot read manifest: {exc}")
    try:
        def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, item in pairs:
                if key in result:
                    fail(f"manifest contains duplicate JSON key: {key}")
                result[key] = item
            return result

        value = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"manifest is not valid UTF-8 JSON: {exc}")
    return raw, validate_manifest(value)


def require_hash(raw: bytes, expected: str, label: str = "manifest") -> str:
    actual = hashlib.sha256(raw).hexdigest()
    expected = expected.lower()
    if not HEX_ID_RE.fullmatch(expected):
        fail("--expected-sha256 must be a 64-character hexadecimal SHA-256")
    if actual != expected:
        fail(f"{label} SHA-256 mismatch (expected {expected}; got {actual})")
    return actual


def write_manifest(manifest: dict[str, Any]) -> None:
    validate_manifest(manifest)
    json.dump(manifest, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def create_manifest(args: argparse.Namespace) -> None:
    columns = [
        "repo",
        "path",
        "branch",
        "verdict",
        "reason",
        "extra",
        "session_provider",
        "session_age_seconds",
        "size_kb",
        "head",
        "branch_ref",
        "common_dir",
        "git_dir",
        "codes",
    ]
    candidates: list[dict[str, Any]] = []
    try:
        lines = Path(args.rows).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        fail(f"cannot read audit rows: {exc}")

    for line_number, line in enumerate(lines, 1):
        parts = line.split("\x1f")
        if len(parts) != len(columns):
            fail(f"audit row {line_number} has {len(parts)} fields; expected {len(columns)}")
        row = dict(zip(columns, parts, strict=True))
        if row["verdict"] != "SAFE-TO-PURGE":
            continue
        candidate: dict[str, Any] = {
            "branch": row["branch"],
            "branchRef": row["branch_ref"],
            "commonDir": row["common_dir"],
            "gitDir": row["git_dir"],
            "head": row["head"],
            "id": "",
            "path": row["path"],
            "reason": row["reason"],
            "repo": row["repo"],
            "sessionAgeSeconds": parse_optional_int(row["session_age_seconds"]),
            "sessionEvidence": row["extra"],
            "sessionProvider": row["session_provider"] or None,
            "sizeKb": parse_optional_int(row["size_kb"]),
        }
        candidate["id"] = identity_id(candidate)
        candidates.append(candidate)

    candidates.sort(key=lambda row: (row["repo"], row["path"], row["id"]))
    manifest = {
        "action": "reclaim",
        "activeWithin": args.active_within,
        "activitySource": "agent-sessions",
        "activeWithinSeconds": args.active_within_seconds,
        "allHistory": bool(args.all_history),
        "candidateCount": len(candidates),
        "candidates": candidates,
        "createdAtEpoch": args.created_at_epoch,
        "kind": KIND,
        "schemaVersion": SCHEMA_VERSION,
    }
    write_manifest(manifest)


def manifest_hash(args: argparse.Namespace) -> None:
    raw, _ = read_manifest(Path(args.manifest))
    print(hashlib.sha256(raw).hexdigest())


def inspect_manifest(args: argparse.Namespace) -> None:
    _, manifest = read_manifest(Path(args.manifest))

    def display(value: Any) -> str:
        if value is None:
            return ""
        return str(value).replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")

    print(f"# action={manifest.get('action', 'reclaim')} candidates={manifest['candidateCount']}")
    print("id\trepo\tpath\tbranch\treason\tsession_evidence")
    for candidate in manifest["candidates"]:
        print(
            "\t".join(
                display(candidate.get(key))
                for key in ("id", "repo", "path", "branch", "reason", "sessionEvidence")
            )
        )


def select_manifest(args: argparse.Namespace) -> None:
    raw, manifest = read_manifest(Path(args.manifest))
    require_hash(raw, args.expected_sha256, "source manifest")
    requested_ids = args.id
    if len(requested_ids) != len(set(requested_ids)):
        fail("the same candidate ID was selected more than once")
    by_id = {candidate["id"]: candidate for candidate in manifest["candidates"]}
    missing = sorted(set(requested_ids) - set(by_id))
    if missing:
        fail(f"candidate ID is not in the source manifest: {missing[0]}")
    requested = set(requested_ids)
    selected = [candidate for candidate in manifest["candidates"] if candidate["id"] in requested]
    if not selected:
        fail("manifest selection is empty")
    subset = dict(manifest)
    subset["candidates"] = selected
    subset["candidateCount"] = len(selected)
    write_manifest(subset)


def validate_for_apply(args: argparse.Namespace) -> None:
    raw, manifest = read_manifest(Path(args.manifest))
    actual_hash = require_hash(raw, args.expected_sha256)

    now = int(os.environ.get("WORKTREE_RECLAIM_NOW_EPOCH", str(int(time.time()))))
    created = manifest["createdAtEpoch"]
    if created > now + 300:
        fail("manifest creation time is in the future")
    age = max(0, now - created)
    if age > args.max_age_seconds:
        fail(f"manifest is {age}s old; maximum allowed age is {args.max_age_seconds}s")

    if manifest.get("action", "reclaim") != "reclaim":
        fail("this is a trim manifest; apply it with `devrouter workspace trim`")
    selected = manifest["candidates"]
    if not selected:
        fail("approved manifest is empty")

    records_path = Path(args.records)
    try:
        with records_path.open("wb") as output:
            # A devrouter manifest carries no session window; the skill still
            # rebuilds agent-session evidence with the default window.
            metadata = [
                str(manifest.get("activeWithinSeconds", DEFAULT_ACTIVE_WITHIN_SECONDS)),
                "1" if manifest.get("allHistory", False) else "0",
                actual_hash,
            ]
            for field in metadata:
                output.write(field.encode("utf-8") + b"\0")
            for candidate in selected:
                for key in ("id", "repo", "path", "branchRef", "head", "commonDir", "gitDir"):
                    output.write(candidate[key].encode("utf-8") + b"\0")
    except OSError as exc:
        fail(f"cannot write validated records: {exc}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create", help="create a canonical manifest from fleet audit rows")
    create.add_argument("--rows", required=True)
    create.add_argument("--created-at-epoch", type=int, required=True)
    create.add_argument("--active-within", required=True)
    create.add_argument("--active-within-seconds", type=int, required=True)
    create.add_argument("--all-history", type=int, choices=(0, 1), required=True)
    create.set_defaults(func=create_manifest)

    hash_command = commands.add_parser("hash", help="print the manifest SHA-256")
    hash_command.add_argument("manifest")
    hash_command.set_defaults(func=manifest_hash)

    inspect = commands.add_parser("inspect", help="print the canonical candidate list as TSV")
    inspect.add_argument("manifest")
    inspect.set_defaults(func=inspect_manifest)

    select = commands.add_parser("select", help="create a canonical subset manifest")
    select.add_argument("manifest")
    select.add_argument("--expected-sha256", required=True)
    select.add_argument("--id", action="append", required=True)
    select.set_defaults(func=select_manifest)

    validate = commands.add_parser("validate", help="validate an approved manifest for apply")
    validate.add_argument("manifest")
    validate.add_argument("--expected-sha256", required=True)
    validate.add_argument("--max-age-seconds", type=int, required=True)
    validate.add_argument("--records", required=True)
    validate.set_defaults(func=validate_for_apply)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        args.func(args)
        return 0
    except ManifestError as exc:
        print(f"REFUSING: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
