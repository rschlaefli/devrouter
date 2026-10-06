#!/usr/bin/env python3
"""Build a metadata-only Codex and Claude Code cwd/workdir activity index.

The history mode is "0" (recent files fully, older files bounded), "1" (every
file fully) or "recent" (only files modified inside the window). "recent" is
enough to answer "was this path active inside the window?" and is the fast
mode for a per-target veto.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import time
from collections.abc import Iterator
from typing import Any


def metadata_paths(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in {"cwd", "workdir"} and isinstance(nested, str):
                yield nested
                continue
            if (
                key == "arguments"
                and isinstance(nested, str)
                and ("cwd" in nested or "workdir" in nested)
            ):
                try:
                    yield from metadata_paths(json.loads(nested))
                except ValueError:
                    pass
                continue
            if isinstance(nested, (dict, list)):
                yield from metadata_paths(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from metadata_paths(nested)


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: session-index.py <cache> <active-window-seconds> <0|1|recent>",
            file=sys.stderr,
        )
        return 2

    cache = sys.argv[1]
    window = float(sys.argv[2])
    all_history = sys.argv[3] == "1"
    recent_only = sys.argv[3] == "recent"
    now_epoch = float(os.environ.get("WORKTREE_RECLAIM_NOW_EPOCH", time.time()))
    entries: dict[str, tuple[float, str]] = {}
    source_stores = 0

    def record(cwd: str, epoch: float, provider: str) -> None:
        if not cwd:
            return
        key = os.path.realpath(os.path.expanduser(cwd))
        if not key or key == "/":
            return
        current = entries.get(key)
        if current is None or epoch > current[0]:
            entries[key] = (epoch, provider)

    def scan_session(
        path: str, epoch: float, provider: str, max_lines: int | None = None
    ) -> None:
        with open(path, encoding="utf-8", errors="replace") as session:
            for index, line in enumerate(session):
                if max_lines is not None and index >= max_lines:
                    break
                if "cwd" not in line and "workdir" not in line:
                    continue
                try:
                    record_data = json.loads(line)
                except ValueError:
                    continue
                for cwd in metadata_paths(record_data):
                    record(cwd, epoch, provider)

    def raise_walk_error(error: OSError) -> None:
        raise error

    def is_session_store(path: str) -> bool:
        try:
            return stat.S_ISDIR(os.stat(path).st_mode)
        except FileNotFoundError:
            return False

    codex_root = os.path.expanduser(
        os.environ.get(
            "WORKTREE_RECLAIM_CODEX_SESSIONS_DIR", "~/.codex/sessions"
        )
    )
    if is_session_store(codex_root):
        source_stores += 1
        for dirpath, _dirs, files in os.walk(
            codex_root, onerror=raise_walk_error
        ):
            for filename in files:
                if not filename.endswith(".jsonl"):
                    continue
                path = os.path.join(dirpath, filename)
                epoch = os.stat(path).st_mtime
                if all_history or now_epoch - epoch <= window:
                    scan_session(path, epoch, "codex")
                elif not recent_only:
                    scan_session(path, epoch, "codex", max_lines=1)

    claude_root = os.path.expanduser(
        os.environ.get(
            "WORKTREE_RECLAIM_CLAUDE_PROJECTS_DIR", "~/.claude/projects"
        )
    )
    if is_session_store(claude_root):
        source_stores += 1
        with os.scandir(claude_root) as project_scan:
            projects = list(project_scan)
        for project in projects:
            if not project.is_dir():
                continue
            candidates: list[tuple[str, float]] = []
            for dirpath, _dirs, files in os.walk(
                project.path, onerror=raise_walk_error
            ):
                for filename in files:
                    if not filename.endswith(".jsonl"):
                        continue
                    path = os.path.join(dirpath, filename)
                    candidates.append((path, os.stat(path).st_mtime))
            if not candidates:
                continue

            if all_history:
                for path, epoch in candidates:
                    scan_session(path, epoch, "claude")
                continue

            recent = [item for item in candidates if now_epoch - item[1] <= window]
            for path, epoch in recent:
                scan_session(path, epoch, "claude")

            older = [item for item in candidates if now_epoch - item[1] > window]
            if older and not recent_only:
                path, epoch = max(older, key=lambda item: item[1])
                scan_session(path, epoch, "claude", max_lines=100)

    if source_stores == 0:
        print("no Codex or Claude session store is readable", file=sys.stderr)
        return 1

    with open(cache, "w", encoding="utf-8") as output:
        for path, (epoch, provider) in sorted(entries.items()):
            output.write(
                f"{path}\t{provider}\t{max(0, int(now_epoch - epoch))}\n"
            )
    return 0


if __name__ == "__main__":
    try:
        status_code = main()
    except OSError:
        print("session metadata index incomplete: read error", file=sys.stderr)
        status_code = 1
    raise SystemExit(status_code)
