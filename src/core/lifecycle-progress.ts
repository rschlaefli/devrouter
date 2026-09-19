const ROLES = {
  validation: "lifecycle-worker",
  preparation: "repository-preparation",
  provider: "provider-operation",
  "service-start": "service-reconciliation",
  "service-stop": "service-reconciliation",
  "process-start": "repository-process-adapter",
  "process-stop": "repository-process-adapter",
  "route-publication": "lifecycle-worker",
  "route-removal": "lifecycle-worker",
  readiness: "lifecycle-worker",
  rollback: "lifecycle-worker",
  stop: "lifecycle-stop",
} as const;

export type LifecycleProgressPhase = keyof typeof ROLES;

export function isLifecycleProgressPhase(value: unknown): value is LifecycleProgressPhase {
  return typeof value === "string" && Object.hasOwn(ROLES, value);
}

let sender: ((phase: LifecycleProgressPhase) => void) | undefined;

/** Install only inside ensure/stop workers; diagnostics never wait for IPC delivery. */
export function installLifecycleProgressSender(
  send: (message: { lifecycleProgress: LifecycleProgressPhase }, done: () => void) => void,
): () => void {
  let active = true;
  let pending = false;
  let latest: LifecycleProgressPhase | undefined;
  const report = (phase: LifecycleProgressPhase) => {
    if (!active || !isLifecycleProgressPhase(phase)) return;
    if (pending) {
      latest = phase;
      return;
    }
    pending = true;
    try {
      send({ lifecycleProgress: phase }, () => {
        pending = false;
        const next = latest;
        latest = undefined;
        if (active && next) report(next);
      });
    } catch {
      pending = false;
      latest = undefined;
    }
  };
  sender = report;
  return () => {
    active = false;
    latest = undefined;
    if (sender === report) sender = undefined;
  };
}

export function reportLifecycleProgress(phase: LifecycleProgressPhase): void {
  sender?.(phase);
}

/** A receipt proves the last stage reached, not a live child or completed readiness. */
export function lifecycleProgressSnapshot(
  phase: LifecycleProgressPhase | undefined,
  receivedAt: number | undefined,
  now: number,
) {
  const elapsedMs = receivedAt === undefined ? null : Math.max(0, Math.floor(now - receivedAt));
  return {
    type: "lifecycle-progress" as const,
    phase: phase ?? "unknown",
    role: phase ? ROLES[phase] : "unknown",
    elapsedMs,
    evidence: elapsedMs === null ? "unknown" : elapsedMs >= 30_000 ? "stale" : "recent",
    liveness: "unknown" as const,
  };
}
