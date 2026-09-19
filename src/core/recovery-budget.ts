import {
  RELIABILITY_MAX_ITEMS,
  type ReliabilityIncident,
  type ReliabilityIncidentUnit,
} from "./reliability-contract";

/**
 * The plan dimension a corrective action touches: one logical process from the
 * managed process set, or one retained service from the resolved service set.
 */
export type RecoveryUnitKind = "process" | "service";

/**
 * Opaque action unit. The key is the capability hash the controller delivered,
 * so no raw selector or process identity is retained anywhere.
 */
export type RecoveryUnit = { key: string; kind: RecoveryUnitKind };

/** Policy bounds for one incident; the aggregate ceiling stays on the incident itself. */
export type RecoveryBudgetLimits = {
  maxProcessRestarts: number;
  maxServiceRestarts: number;
  windowSeconds: number;
};

export type RecoveryRefusalReason = "window-closed" | "unit-exhausted" | "budget-exhausted";

/**
 * Split the repository-declared capability selectors by the plan dimension that
 * backs them. An app whose upstream alias names a declared retained service is
 * a service unit; every other routed app is served by the repository's own
 * process group and is a process unit. Both lists are sorted, so the derivation
 * never depends on declaration order.
 */
export function recoverySelectors(input: {
  apps: readonly { name: string; upstreamHost: string }[];
  aliasPrefix: string;
  services: readonly string[];
}): { process: string[]; service: string[] } {
  const declared = new Set(input.services);
  const process: string[] = [];
  const service: string[] = [];
  for (const app of [...input.apps].sort((left, right) => compare(left.name, right.name))) {
    const prefix = `${input.aliasPrefix}-`;
    const suffix = app.upstreamHost.startsWith(prefix)
      ? app.upstreamHost.slice(prefix.length)
      : undefined;
    if (suffix !== undefined && declared.has(suffix)) service.push(`app:${app.name}`);
    else process.push(`app:${app.name}`);
  }
  return { process, service };
}

/**
 * Recover the action unit for the producing failed capability. The controller
 * only ever delivers `controllerCapability(selector)` hashes, so the lifecycle
 * layer recomputes that hash over the repository-declared selectors and matches
 * the capabilities that positively failed. A capability the plan cannot
 * attribute yields no unit, and the aggregate ceiling still bounds it. When
 * several capabilities fail together only the lowest-keyed attributed unit is
 * claimed, so one corrective action is never charged more than once.
 */
export function deriveRecoveryUnit(input: {
  capabilities: readonly string[];
  selectors: { process: readonly string[]; service: readonly string[] };
  capabilityOf: (selector: string) => string;
}): RecoveryUnit | undefined {
  const units = new Map<string, RecoveryUnit>();
  for (const selector of input.selectors.service) {
    const capability = input.capabilityOf(selector);
    if (input.capabilities.includes(capability) && !units.has(capability))
      units.set(capability, { key: capability, kind: "service" });
  }
  for (const selector of input.selectors.process) {
    const capability = input.capabilityOf(selector);
    if (input.capabilities.includes(capability) && !units.has(capability))
      units.set(capability, { key: capability, kind: "process" });
  }
  const ordered = [...units.values()].sort((left, right) => compare(left.key, right.key));
  return ordered[0];
}

export function findRecoveryUnit(
  incident: ReliabilityIncident,
  unit: RecoveryUnit,
): ReliabilityIncidentUnit | undefined {
  return (incident.units ?? []).find((record) => record.key === unit.key);
}

function restartsFor(kind: RecoveryUnitKind, limits: RecoveryBudgetLimits): number {
  return kind === "service" ? limits.maxServiceRestarts : limits.maxProcessRestarts;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Refuse the next corrective action before any mutation. An unobservable active
 * duration falls back to the conservative wall duration since the incident
 * started, so lost worker time can neither extend the window nor replenish a
 * budget. Window expiry alone changes no counter and clears no incident.
 */
export function recoveryBudgetRefusal(input: {
  incident: ReliabilityIncident;
  limits: RecoveryBudgetLimits;
  unit: RecoveryUnit | undefined;
  nowMs: number;
  activeElapsedMs: number | null;
}): RecoveryRefusalReason | undefined {
  // A record written before the field existed has no recorded start; it starts
  // now rather than discarding the counters it already carries.
  const startedAtMs = input.incident.startedAtMs ?? input.nowMs;
  const elapsed = input.activeElapsedMs ?? Math.max(0, input.nowMs - startedAtMs);
  if (elapsed > input.limits.windowSeconds * 1000) return "window-closed";
  if (input.unit !== undefined) {
    const record = findRecoveryUnit(input.incident, input.unit);
    if (record !== undefined && record.actions >= restartsFor(input.unit.kind, input.limits))
      return "unit-exhausted";
  }
  if (input.incident.correctiveActionsTaken >= input.incident.actionLimit)
    return "budget-exhausted";
  return undefined;
}

/**
 * Claim one corrective action for the incident and its action unit in the same
 * durable write. A refused claim returns the unchanged incident, so an action
 * the policy does not allow leaves the environment exactly as it was. The claim
 * is never refunded: an unknown completion consumes it like any other action.
 */
export function claimRecoveryUnit(input: {
  incident: ReliabilityIncident;
  limits: RecoveryBudgetLimits;
  unit: RecoveryUnit | undefined;
  nowMs: number;
  activeElapsedMs: number | null;
}): { ok: true; incident: ReliabilityIncident } | { ok: false; reason: RecoveryRefusalReason } {
  const reason = recoveryBudgetRefusal(input);
  if (reason !== undefined) return { ok: false, reason };

  const units = (input.incident.units ?? []).map((record) => ({ ...record }));
  if (input.unit !== undefined) {
    const index = units.findIndex((record) => record.key === input.unit?.key);
    if (index === -1) {
      if (units.length >= RELIABILITY_MAX_ITEMS) return { ok: false, reason: "unit-exhausted" };
      units.push({ ...input.unit, actions: 1, lastActionAtMs: input.nowMs });
    } else {
      const record = units[index];
      units[index] = {
        ...record,
        actions: record.actions + 1,
        lastActionAtMs: input.nowMs,
      };
    }
  }

  return {
    ok: true,
    incident: {
      ...input.incident,
      startedAtMs: input.incident.startedAtMs ?? input.nowMs,
      correctiveActionsTaken: input.incident.correctiveActionsTaken + 1,
      units,
    },
  };
}
