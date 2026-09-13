const NO_SPACE_LEFT_RE = /no space left on device/i;
const ADDRESS_POOLS_FULL_RE = /all predefined address pools have been fully subnetted/i;

import type { NetworkCapacityReport } from "./network-capacity";

export function withDockerFailureGuidance(
  details: string,
  capacity?: NetworkCapacityReport,
): string {
  const base = details.trim() || "unknown error";
  const guidance: string[] = [];

  if (NO_SPACE_LEFT_RE.test(base)) {
    guidance.push(
      'Docker storage appears full ("no space left on device"). ' +
        "Free Docker disk space using your preferred method, then retry the command.",
    );
  }

  if (capacity?.allocation.status === "exhausted" || ADDRESS_POOLS_FULL_RE.test(base)) {
    guidance.push(
      "Docker network address capacity is exhausted. Run devrouter doctor for capacity " +
        "diagnostics. Stopping a workspace or removing its worktree does not release " +
        "its subnet. Review operator-approved route-safe pools or exact ownership-aware " +
        "recovery; do not automatically prune retained networks or containers.",
    );
  }

  return guidance.length === 0 ? base : `${base}\n\n${guidance.join("\n\n")}`;
}
