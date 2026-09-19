import path from "node:path";
import { readDockerCapacityInfo } from "../core/capacity-docker-probe";
import { readCapacityPolicy } from "../core/capacity-policy";
import type { CapacityPoolReservation, CapacityStore } from "../core/capacity-store";
import {
  createLifecycleCapacityStore,
  listUnsettledCapacityBindings,
  type UnsettledCapacityBinding,
} from "../core/reliability-operation-store";
import { DEVROUTER_HOME } from "../core/router";

/** Bound on one pool probe; an unobservable runtime domain refuses instead of being assumed absent. */
const POOL_PROBE_TIMEOUT_MS = 3_000;

/** Fixed refusal reasons; each names one condition an operator can act on. */
export type CapacityReconcileReason =
  | "capacity-reconcile-confirmation-required"
  | "capacity-history-intact"
  | "capacity-charges-pending"
  | "capacity-pools-unresolved"
  | "capacity-ledger-unusable"
  | "capacity-history-unprovable";

export class CapacityReconcileRefusal extends Error {
  constructor(
    readonly reason: CapacityReconcileReason,
    readonly detail: { bindings?: UnsettledCapacityBinding[]; domains?: string[] } = {},
  ) {
    super(reason);
    this.name = "CapacityReconcileRefusal";
  }
}

/** Quote one path as a single shell word, so a recovery command can be pasted verbatim. */
function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

function enumerateBindings(): { floor: number; bindings: UnsettledCapacityBinding[] } {
  try {
    return listUnsettledCapacityBindings();
  } catch {
    // Journals are the last evidence of what was charged; an unreadable journal
    // directory must refuse rather than reconcile around it.
    throw new CapacityReconcileRefusal("capacity-history-unprovable");
  }
}

/**
 * Positively observe the runtime domains the active policy declares, so a
 * reconciled baseline keeps the ceilings the lost ledger carried. A domain that
 * cannot be observed refuses: a failed probe is not evidence of absence.
 */
async function observeDeclaredPools(directory: string): Promise<CapacityPoolReservation[]> {
  const policy = readCapacityPolicy(directory);
  if (!policy) return [];
  const observed: CapacityPoolReservation[] = [];
  const unresolved: string[] = [];
  for (const [runtimeDomain, domain] of Object.entries(policy.domains)) {
    if (domain.kind !== "runtime") continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POOL_PROBE_TIMEOUT_MS);
    try {
      const info = await readDockerCapacityInfo(domain.endpoint, controller.signal);
      if (info.ID !== domain.daemonId) throw new Error("Pool observation identity changed.");
      observed.push({
        daemonId: domain.daemonId,
        runtimeDomain,
        hostDomain: domain.hostDomain,
        hostChargeCeilingBytes: domain.hostChargeCeilingBytes,
      });
    } catch {
      unresolved.push(runtimeDomain);
    } finally {
      clearTimeout(timer);
    }
  }
  if (unresolved.length > 0)
    throw new CapacityReconcileRefusal("capacity-pools-unresolved", { domains: unresolved });
  return observed;
}

function refusalLines(refusal: CapacityReconcileRefusal): string {
  const bindings = refusal.detail.bindings ?? [];
  const domains = refusal.detail.domains ?? [];
  switch (refusal.reason) {
    case "capacity-reconcile-confirmation-required":
      return "Refusing without --yes: reconciliation publishes a fresh empty capacity baseline.";
    case "capacity-history-intact":
      return "Capacity ledger history is intact or absent; there is no loss to reconcile.";
    case "capacity-charges-pending":
      return [
        "Capacity reconciliation is blocked by " +
          bindings.length +
          " unsettled capacity binding" +
          (bindings.length === 1 ? "" : "s") +
          ":",
        ...bindings.map(
          (binding) =>
            "  - " +
            binding.environmentId +
            (binding.workspace ? " (workspace " + binding.workspace + ")" : "") +
            ": run: devrouter stop " +
            shellQuote(binding.repoPath),
        ),
      ].join("\n");
    case "capacity-pools-unresolved":
      return [
        "Runtime domain" +
          (domains.length === 1 ? "" : "s") +
          " could not be observed: " +
          domains.join(", ") +
          ".",
        "Start them so their pool ceiling can be recorded, or remove them from the capacity policy, then retry.",
      ].join("\n");
    case "capacity-ledger-unusable":
      return "The capacity ledger exists but cannot satisfy the surviving lifecycle evidence; preserve it and investigate before retrying.";
    case "capacity-history-unprovable":
      return "Capacity history cannot be proven; inspect the private lifecycle journals before retrying.";
  }
}

/**
 * `devrouter capacity reconcile` replaces a provably absent ledger with a fresh
 * baseline. It refuses for every other state, for any journal-visible charge,
 * and whenever a declared runtime pool cannot be observed.
 */
export async function runCapacityCommand(
  method: string,
  options: { yes?: boolean; json?: boolean },
  dependencies: {
    directory?: string;
    store?: CapacityStore;
    observePools?: (directory: string) => Promise<CapacityPoolReservation[]>;
  } = {},
): Promise<void> {
  if (method !== "reconcile") throw new Error(`Unsupported capacity command: ${method}`);
  const directory = dependencies.directory ?? path.join(DEVROUTER_HOME, "controller");
  const json = Boolean(options.json);
  const emit = (payload: object, human: string): void => {
    process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${human}\n`);
  };
  try {
    if (!options.yes)
      throw new CapacityReconcileRefusal("capacity-reconcile-confirmation-required");
    const store = dependencies.store ?? createLifecycleCapacityStore(directory);
    // Preflight the cheap local evidence before probing a runtime domain, so a
    // reachability failure cannot mask a charge or "nothing to reconcile". The
    // authoritative checks stay inside the locked transaction below.
    const preflight = store.inspect();
    if (preflight.kind === "intact" || preflight.kind === "pristine")
      throw new CapacityReconcileRefusal("capacity-history-intact");
    if (preflight.kind === "stale") throw new CapacityReconcileRefusal("capacity-ledger-unusable");
    const pending = enumerateBindings().bindings;
    if (pending.length > 0)
      throw new CapacityReconcileRefusal("capacity-charges-pending", { bindings: pending });
    // Pool observation is asynchronous while the ledger transaction is
    // synchronous, so the ceilings are gathered immediately before it.
    const pools = await (dependencies.observePools ?? observeDeclaredPools)(directory);
    let appeared: UnsettledCapacityBinding[] = [];
    const outcome = store.reconcileLostHistory(
      (state) => {
        if (state.kind === "intact" || state.kind === "pristine")
          throw new CapacityReconcileRefusal("capacity-history-intact");
        if (state.kind === "stale") throw new CapacityReconcileRefusal("capacity-ledger-unusable");
        const { floor, bindings } = enumerateBindings();
        if (bindings.length > 0)
          throw new CapacityReconcileRefusal("capacity-charges-pending", { bindings });
        return { revision: floor + 1, pools };
      },
      () => {
        appeared = enumerateBindings().bindings;
        return appeared.length === 0;
      },
    );
    if (!outcome.reconciled)
      throw new CapacityReconcileRefusal("capacity-charges-pending", { bindings: appeared });
    emit(
      { version: 1, ok: true, reconciled: true, revision: outcome.revision, unresolved: 0 },
      "Reconciled the lost capacity ledger: baseline revision " +
        outcome.revision +
        ", no charges carried. No journal-visible charge remained. Charges that were never journal-bound are not recoverable from the journals.",
    );
  } catch (error) {
    if (!(error instanceof CapacityReconcileRefusal)) throw error;
    process.exitCode = 1;
    emit(
      {
        version: 1,
        ok: false,
        reason: error.reason,
        ...(error.detail.bindings ? { bindings: error.detail.bindings } : {}),
        ...(error.detail.domains ? { domains: error.detail.domains } : {}),
      },
      refusalLines(error),
    );
  }
}
