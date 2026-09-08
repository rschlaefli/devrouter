export type CapacityDomainBudget = {
  capacityBytes: number;
  protectedHeadroomBytes: number;
  startupSlots: number;
  heavySlots: number;
};

export type CapacityDomainSample = {
  sampledAtMs: number;
  pressure: "normal" | "pressured" | "unknown";
  unmanagedBytes: number;
  sharedBytes: number;
  ownedBytes: Record<string, number>;
};

export type CapacityCharge = {
  environmentId: string;
  totals: Record<string, number>;
  startup: boolean;
  heavy: boolean;
};

export type CapacityDecision =
  | { admitted: true }
  | {
      admitted: false;
      domain: string;
      reason: "unknown" | "stale" | "pressure" | "memory" | "startup-slot" | "heavy-slot";
    };

function bytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Evaluate every domain before the caller persists any reservation. */
export function evaluateCapacity(
  budgets: Record<string, CapacityDomainBudget>,
  samples: Record<string, CapacityDomainSample>,
  charges: CapacityCharge[],
  requested: CapacityCharge,
  nowMs: number,
  maxSampleAgeMs: number,
): CapacityDecision {
  if (!bytes(nowMs) || !bytes(maxSampleAgeMs)) throw new Error("Invalid capacity sample clock.");
  for (const domain of Object.keys(requested.totals).sort()) {
    const fail = (reason: Exclude<CapacityDecision, { admitted: true }>["reason"]) =>
      ({ admitted: false, domain, reason }) as const;
    const budget = budgets[domain];
    const sample = samples[domain];
    if (
      !budget ||
      !sample ||
      !bytes(budget.capacityBytes) ||
      !bytes(budget.protectedHeadroomBytes) ||
      budget.protectedHeadroomBytes >= budget.capacityBytes ||
      !Number.isSafeInteger(budget.startupSlots) ||
      budget.startupSlots < 1 ||
      !Number.isSafeInteger(budget.heavySlots) ||
      budget.heavySlots < 1 ||
      !bytes(sample.unmanagedBytes) ||
      !bytes(sample.sharedBytes) ||
      !bytes(sample.sampledAtMs) ||
      Object.values(sample.ownedBytes).some((value) => !bytes(value)) ||
      !bytes(requested.totals[domain])
    )
      return fail("unknown");
    if (sample.sampledAtMs > nowMs || nowMs - sample.sampledAtMs > maxSampleAgeMs)
      return fail("stale");
    if (sample.pressure !== "normal")
      return fail(sample.pressure === "pressured" ? "pressure" : "unknown");

    const totals = new Map<string, number>();
    let startups = 0;
    let heavy = 0;
    for (const charge of charges) {
      if (!Object.hasOwn(charge.totals, domain)) continue;
      if (!bytes(charge.totals[domain]) || totals.has(charge.environmentId)) return fail("unknown");
      totals.set(charge.environmentId, charge.totals[domain]);
      if (charge.environmentId !== requested.environmentId) {
        if (charge.startup) startups++;
        if (charge.heavy) heavy++;
      }
    }
    // A request replaces the environment's phase total, never its observed charge.
    // Retained allocations cannot decrease until the settlement path proves cessation.
    totals.set(
      requested.environmentId,
      Math.max(totals.get(requested.environmentId) ?? 0, requested.totals[domain]),
    );
    for (const [environment, observed] of Object.entries(sample.ownedBytes))
      totals.set(environment, Math.max(totals.get(environment) ?? 0, observed));
    // BigInt keeps a sum of individually valid byte values from losing precision.
    let used = BigInt(sample.unmanagedBytes) + BigInt(sample.sharedBytes);
    for (const total of totals.values()) used += BigInt(total);
    if (used > BigInt(budget.capacityBytes) - BigInt(budget.protectedHeadroomBytes))
      return fail("memory");
    const existing = charges.find((charge) => charge.environmentId === requested.environmentId);
    if ((requested.startup || existing?.startup) && startups >= budget.startupSlots)
      return fail("startup-slot");
    if ((requested.heavy || existing?.heavy) && heavy >= budget.heavySlots)
      return fail("heavy-slot");
  }
  if (Object.keys(requested.totals).length === 0)
    throw new Error("Capacity request has no domains.");
  return { admitted: true };
}
