#!/usr/bin/env python3
"""List exact checkout paths that hold devrouter, DevPod or Devsy state.

Usage: runtime-inventory.py <git-common-dir>

Prints "realpath<TAB>evidence" per bound path. A source that exists but cannot
be read prints "!error<TAB>source" first, so the classifier fails closed. Reads
metadata only and changes nothing.
"""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
from typing import Any


def real(path: str) -> str:
    return os.path.realpath(os.path.expanduser(path))


def run_json(argv: list[str]) -> Any:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        raise RuntimeError(argv[0])
    return json.loads(result.stdout or "[]")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    common = sys.argv[1]
    errors: list[str] = []
    bound: list[tuple[str, str]] = []

    # devrouter ownership records for linked worktrees of this repository.
    for record_path in sorted(glob.glob(os.path.join(common, "devrouter", "workspaces", "*.json"))):
        try:
            with open(record_path, encoding="utf-8") as handle:
                record = json.load(handle)
            if isinstance(record.get("worktreePath"), str):
                bound.append((real(record["worktreePath"]), "devrouter workspace record"))
        except (OSError, ValueError, AttributeError):
            errors.append("devrouter workspace records")

    # devrouter host routes, which name the checkout that serves them.
    home = os.environ.get("WORKTREE_RECLAIM_DEVROUTER_HOME", "~/.config/devrouter")
    routes_path = os.path.join(real(home), "host-routes-state.json")
    if os.path.exists(routes_path):
        try:
            with open(routes_path, encoding="utf-8") as handle:
                routes = json.load(handle)
            for route in routes if isinstance(routes, list) else []:
                if isinstance(route, dict) and isinstance(route.get("repoPath"), str):
                    bound.append((real(route["repoPath"]), "devrouter route"))
        except (OSError, ValueError):
            errors.append("devrouter routes")

    providers = (
        ("devpod", ["devpod", "list", "--output", "json"], "DevPod", "DevPods"),
        (
            "devsy",
            ["devsy", "workspace", "list", "--result-format", "json", "--skip-pro"],
            "Devsy",
            "Devsy workspaces",
        ),
    )
    for binary, argv, label, plural in providers:
        if not shutil.which(binary):
            continue
        try:
            workspaces = run_json(argv)
            for workspace in workspaces if isinstance(workspaces, list) else []:
                source = workspace.get("source") if isinstance(workspace, dict) else None
                folder = source.get("localFolder") if isinstance(source, dict) else None
                if isinstance(folder, str) and folder:
                    bound.append((real(folder), f"{label} {workspace.get('id', '?')}"))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            errors.append(plural)

    for source in errors:
        print(f"!error\t{source}")
    for path, evidence in bound:
        print(f"{path}\t{evidence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
