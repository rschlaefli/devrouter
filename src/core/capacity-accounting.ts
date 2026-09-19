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
  pools: ReadonlyArray<{ hostDomain: string; hostChargeCeilingBytes: number }> = [],
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
    // Pool ceilings are independent of environment identities and consume no slots.
    for (const pool of pools) {
      if (pool.hostDomain !== domain) continue;
      if (!bytes(pool.hostChargeCeilingBytes)) return fail("unknown");
      used += BigInt(pool.hostChargeCeilingBytes);
    }
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

/** One wall-clock and monotonic reading, captured together for continuity checks. */
export type CapacityEvidenceClock = {
  wallMs: number;
  monotonicMs: number;
};

/** Bounded, ephemeral pressure evidence for a single declared domain. */
export type CapacityPressureEvidence = {
  pressure: "normal" | "pressured" | "unknown";
  observedDurationMs: number;
  sampledAtMs: number | null;
};

/** Mirrors the capacity policy domain bound; the tracker owns no policy of its own. */
const MAX_DECLARED_DOMAINS = 256;
/** Wall and monotonic deltas may differ by this much before a reading is a clock jump. */
const MAX_CLOCK_DIVERGENCE_MS = 2000;
/** A monotonic gap beyond this loses continuity, so every window has to restart. */
const MAX_MONOTONIC_GAP_MS = 15_000;

type PressureWindow = {
  pressure: "normal" | "pressured";
  firstMonotonicMs: number;
  lastMonotonicMs: number;
  lastSampledAtMs: number;
};

type DomainState = {
  /** Latest accepted evidence and timestamp, retained through every invalidation. */
  accepted: CapacityDomainSample | null;
  window: PressureWindow | null;
};

function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && bytes(value);
}

function isClock(clock: unknown): clock is CapacityEvidenceClock {
  if (typeof clock !== "object" || clock === null) return false;
  const reading = clock as CapacityEvidenceClock;
  return nonNegativeSafeInteger(reading.wallMs) && nonNegativeSafeInteger(reading.monotonicMs);
}

function isDomainSample(value: unknown): value is CapacityDomainSample {
  if (typeof value !== "object" || value === null) return false;
  const sample = value as CapacityDomainSample;
  return (
    nonNegativeSafeInteger(sample.sampledAtMs) &&
    (sample.pressure === "normal" ||
      sample.pressure === "pressured" ||
      sample.pressure === "unknown") &&
    nonNegativeSafeInteger(sample.unmanagedBytes) &&
    nonNegativeSafeInteger(sample.sharedBytes) &&
    typeof sample.ownedBytes === "object" &&
    sample.ownedBytes !== null &&
    !Array.isArray(sample.ownedBytes) &&
    Object.values(sample.ownedBytes).every(nonNegativeSafeInteger)
  );
}

function cloneDomainSample(sample: CapacityDomainSample): CapacityDomainSample {
  return {
    sampledAtMs: sample.sampledAtMs,
    pressure: sample.pressure,
    unmanagedBytes: sample.unmanagedBytes,
    sharedBytes: sample.sharedBytes,
    ownedBytes: { ...sample.ownedBytes },
  };
}

function sameDomainSample(left: CapacityDomainSample, right: CapacityDomainSample): boolean {
  const keys = Object.keys(left.ownedBytes);
  return (
    left.sampledAtMs === right.sampledAtMs &&
    left.pressure === right.pressure &&
    left.unmanagedBytes === right.unmanagedBytes &&
    left.sharedBytes === right.sharedBytes &&
    keys.length === Object.keys(right.ownedBytes).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right.ownedBytes, key) && right.ownedBytes[key] === left.ownedBytes[key],
    )
  );
}

function unknownPressureEvidence(): CapacityPressureEvidence {
  return { pressure: "unknown", observedDurationMs: 0, sampledAtMs: null };
}

/**
 * Tracks ephemeral, incarnation-local pressure duration for the declared domains.
 * It reads no policy, persists nothing and grants no authority: callers derive
 * their own predicates from `read()` and reuse `observe()` samples for the existing
 * instantaneous admission checks.
 */
export class CapacityPressureTracker {
  private readonly domainIds: ReadonlySet<string>;
  private readonly maxSampleAgeMs: number;
  private readonly states = new Map<string, DomainState>();
  private lastClock: CapacityEvidenceClock | null = null;
  private generation = 0;

  constructor(domainIds: string[], maxSampleAgeMs: number) {
    if (!Array.isArray(domainIds) || domainIds.length === 0)
      throw new Error("Capacity pressure tracker requires at least one declared domain.");
    if (domainIds.length > MAX_DECLARED_DOMAINS)
      throw new Error(
        `Capacity pressure tracker accepts at most ${MAX_DECLARED_DOMAINS} declared domains.`,
      );
    const declared = new Set<string>();
    for (const domainId of domainIds) {
      if (typeof domainId !== "string" || domainId.length === 0)
        throw new Error("Capacity pressure tracker requires nonempty string domain identifiers.");
      if (declared.has(domainId))
        throw new Error(`Capacity pressure tracker declares domain ${domainId} more than once.`);
      declared.add(domainId);
    }
    if (!nonNegativeSafeInteger(maxSampleAgeMs) || maxSampleAgeMs < 1)
      throw new Error("Capacity pressure tracker requires a positive safe maxSampleAgeMs.");
    this.domainIds = declared;
    this.maxSampleAgeMs = maxSampleAgeMs;
  }

  /**
   * Records one clock reading and returns the current generation. The generation
   * advances on every global invalidation, so a caller can capture it before an
   * await and refuse publication once it moved.
   */
  checkpoint(clock: CapacityEvidenceClock): number {
    this.acceptClock(clock);
    return this.generation;
  }

  /**
   * Clears every window and advances the generation; timestamp watermarks and their
   * accepted evidence remain.
   */
  invalidate(): void {
    this.invalidateAll();
  }

  /**
   * Validates one collection result and returns independent clones of the declared
   * domains' fresh samples for admission reuse. Malformed, stale, future, regressing
   * and contradictory equal-timestamp samples are omitted, while unknown pressure
   * stays in the result and never establishes duration.
   */
  observe(
    samples: Record<string, CapacityDomainSample>,
    clock: CapacityEvidenceClock,
  ): Record<string, CapacityDomainSample> {
    const observed: Record<string, CapacityDomainSample> = {};
    if (!this.acceptClock(clock)) return observed;
    for (const domainId of this.domainIds) {
      const state = this.stateFor(domainId);
      const sample: unknown =
        typeof samples === "object" && samples !== null ? samples[domainId] : undefined;
      if (!isDomainSample(sample)) {
        state.window = null;
        continue;
      }
      if (
        sample.sampledAtMs > clock.wallMs ||
        clock.wallMs - sample.sampledAtMs > this.maxSampleAgeMs
      ) {
        // A future reading is untrustworthy and a stale one no longer covers the window.
        state.window = null;
        continue;
      }
      if (state.accepted !== null && sample.sampledAtMs < state.accepted.sampledAtMs) {
        state.window = null;
        continue;
      }
      if (state.accepted?.sampledAtMs === sample.sampledAtMs) {
        // An equal timestamp never rebuilds or extends a window. A repeat that changes
        // any field contradicts the accepted evidence, so the window ends and the
        // contradictory sample is not handed back for admission.
        if (!sameDomainSample(state.accepted, sample)) {
          state.window = null;
          continue;
        }
      } else {
        state.accepted = cloneDomainSample(sample);
        this.recordSample(state, sample, clock);
      }
      observed[domainId] = cloneDomainSample(sample);
    }
    return observed;
  }

  /**
   * Returns bounded evidence for the requested declared domains, so arbitrary keys
   * cannot inflate the result. Windows that outlive their sample age against current
   * wall time are dropped, and a read never extends duration.
   */
  read(
    domainIds: string[],
    clock: CapacityEvidenceClock,
  ): Record<string, CapacityPressureEvidence> {
    const evidence: Record<string, CapacityPressureEvidence> = {};
    const usable = this.acceptClock(clock);
    const requested = new Set(domainIds);
    for (const domainId of this.domainIds) {
      if (!requested.has(domainId)) continue;
      const state = usable ? this.states.get(domainId) : undefined;
      const window = state?.window ?? null;
      if (window === null || clock.wallMs - window.lastSampledAtMs > this.maxSampleAgeMs) {
        if (state) state.window = null;
        evidence[domainId] = unknownPressureEvidence();
        continue;
      }
      evidence[domainId] = {
        pressure: window.pressure,
        observedDurationMs: window.lastMonotonicMs - window.firstMonotonicMs,
        sampledAtMs: window.lastSampledAtMs,
      };
    }
    return evidence;
  }

  private recordSample(
    state: DomainState,
    sample: CapacityDomainSample,
    clock: CapacityEvidenceClock,
  ): void {
    if (sample.pressure === "unknown") {
      state.window = null;
      return;
    }
    const predecessor = state.window;
    if (
      predecessor !== null &&
      predecessor.pressure === sample.pressure &&
      clock.wallMs - predecessor.lastSampledAtMs <= this.maxSampleAgeMs
    ) {
      state.window = {
        pressure: sample.pressure,
        firstMonotonicMs: predecessor.firstMonotonicMs,
        lastMonotonicMs: clock.monotonicMs,
        lastSampledAtMs: sample.sampledAtMs,
      };
      return;
    }
    // A pressure transition or a coverage gap restarts the window at zero.
    state.window = {
      pressure: sample.pressure,
      firstMonotonicMs: clock.monotonicMs,
      lastMonotonicMs: clock.monotonicMs,
      lastSampledAtMs: sample.sampledAtMs,
    };
  }

  private stateFor(domainId: string): DomainState {
    const existing = this.states.get(domainId);
    if (existing) return existing;
    const created: DomainState = { accepted: null, window: null };
    this.states.set(domainId, created);
    return created;
  }

  /**
   * Records one reading. An unusable reading returns false, clears every window and
   * advances the generation; an invalid reading also forgets the baseline, while a
   * usable but discontinuous reading becomes the new baseline so only the
   * discontinuity itself is reported and later distinct observations can rebuild.
   */
  private acceptClock(clock: CapacityEvidenceClock): boolean {
    if (!isClock(clock)) {
      this.lastClock = null;
      this.invalidateAll();
      return false;
    }
    const previous = this.lastClock;
    this.lastClock = { wallMs: clock.wallMs, monotonicMs: clock.monotonicMs };
    if (!previous) return true;
    const wallDelta = clock.wallMs - previous.wallMs;
    const monotonicDelta = clock.monotonicMs - previous.monotonicMs;
    if (
      wallDelta < 0 ||
      monotonicDelta < 0 ||
      Math.abs(wallDelta - monotonicDelta) > MAX_CLOCK_DIVERGENCE_MS ||
      monotonicDelta > MAX_MONOTONIC_GAP_MS
    ) {
      this.invalidateAll();
      return false;
    }
    return true;
  }

  private invalidateAll(): void {
    this.generation++;
    for (const state of this.states.values()) state.window = null;
  }
}
