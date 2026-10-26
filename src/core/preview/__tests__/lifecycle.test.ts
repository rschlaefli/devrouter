import { describe, expect, it } from "vitest";

import { createPreviewSession, transitionPreviewSession } from "../lifecycle";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_700_000_000_000;
const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

function create() {
  return createPreviewSession({
    generation: "gen-1",
    now: NOW,
    revision: REV_A,
    aliases: [],
    commandId: "start-1",
  });
}

function ready(session = create(), now = NOW + 5 * MINUTE) {
  return transitionPreviewSession(session, {
    kind: "ready",
    now,
    generation: session.generation,
    operationVersion: session.operationVersion,
    revision: session.desiredRevision,
    deadlineConfirmed: true,
  });
}

describe("preview lifecycle", () => {
  it("uses the setup and backstop cutoffs, then exactly two hours from readiness", () => {
    const initial = create();
    expect(initial.setupDeadline).toBe(NOW + 20 * MINUTE);
    expect(initial.expiresAt).toBe(NOW + 140 * MINUTE);
    expect(initial.firstReadyAt).toBeUndefined();

    expect(() =>
      transitionPreviewSession(initial, {
        kind: "ready",
        now: NOW + 5 * MINUTE,
        generation: initial.generation,
        operationVersion: 1,
        revision: REV_A,
        deadlineConfirmed: false,
      }),
    ).toThrow();

    const active = ready();
    expect(active.firstReadyAt).toBe(NOW + 5 * MINUTE);
    expect(active.expiresAt).toBe(NOW + 125 * MINUTE);
    const beforeExpiry = transitionPreviewSession(active, {
      kind: "tick",
      now: active.expiresAt - 1,
    });
    expect(beforeExpiry).toEqual(active);
    const expired = transitionPreviewSession(active, {
      kind: "tick",
      now: active.expiresAt,
    });
    expect(expired.status).toBe("stopping");
    expect(expired.stopReason).toBe("expiry");
  });

  it("marks pushes stale without deploying or renewing the deadline", () => {
    const active = ready();
    const pushed = transitionPreviewSession(active, {
      kind: "push",
      now: NOW + 10 * MINUTE,
      revision: REV_B,
    });
    expect(pushed.stale).toBe(true);
    expect(pushed.desiredRevision).toBe(REV_A);
    expect(pushed.expiresAt).toBe(active.expiresAt);
    expect(pushed.operationVersion).toBe(active.operationVersion);
  });

  it("fences stale readiness and preserves readiness time across updates", () => {
    const active = ready();
    const updating = transitionPreviewSession(active, {
      kind: "start",
      now: NOW + 10 * MINUTE,
      commandId: "update-1",
      revision: REV_B,
      aliases: ["chat"],
      startupBudgetMs: 20 * MINUTE,
    });
    expect(updating.status).toBe("updating");
    expect(updating.operationVersion).toBe(active.operationVersion + 1);

    expect(() =>
      transitionPreviewSession(updating, {
        kind: "ready",
        now: NOW + 11 * MINUTE,
        generation: "gen-1",
        operationVersion: active.operationVersion,
        revision: REV_A,
        deadlineConfirmed: true,
      }),
    ).toThrow();
    expect(() =>
      transitionPreviewSession(updating, {
        kind: "ready",
        now: NOW + 11 * MINUTE,
        generation: "gen-2",
        operationVersion: updating.operationVersion,
        revision: REV_B,
        deadlineConfirmed: true,
      }),
    ).toThrow();

    const updated = transitionPreviewSession(updating, {
      kind: "ready",
      now: NOW + 12 * MINUTE,
      generation: "gen-1",
      operationVersion: updating.operationVersion,
      revision: REV_B,
      deadlineConfirmed: true,
    });
    expect(updated.status).toBe("ready");
    expect(updated.firstReadyAt).toBe(active.firstReadyAt);
    expect(updated.expiresAt).toBe(active.expiresAt);
  });

  it("deduplicates extension commands and confirmations, and caps extensions", () => {
    const active = ready();
    const refreshing = transitionPreviewSession(active, {
      kind: "effect-started",
      now: NOW + 6 * MINUTE,
      generation: "gen-1",
      operationVersion: active.operationVersion,
      operationId: "refresh-op",
    });
    const pending = transitionPreviewSession(refreshing, {
      kind: "extend",
      now: NOW + 6 * MINUTE,
      commandId: "extend-1",
    });
    expect(pending.pendingDeadline?.target).toBe(active.expiresAt + HOUR);
    expect(pending.extensions).toBe(0);
    expect(
      transitionPreviewSession(pending, {
        kind: "extend",
        now: NOW + 7 * MINUTE,
        commandId: "extend-1",
      }),
    ).toEqual(pending);

    const firstConfirmed = transitionPreviewSession(pending, {
      kind: "deadline-confirmed",
      now: NOW + 7 * MINUTE,
      generation: "gen-1",
      deadlineVersion: pending.deadlineVersion,
      expiresAt: pending.pendingDeadline!.target,
    });
    expect(firstConfirmed.extensions).toBe(1);
    expect(
      transitionPreviewSession(firstConfirmed, {
        kind: "deadline-confirmed",
        now: NOW + 8 * MINUTE,
        generation: "gen-1",
        deadlineVersion: firstConfirmed.deadlineVersion,
        expiresAt: firstConfirmed.expiresAt,
      }),
    ).toEqual(firstConfirmed);

    const secondPending = transitionPreviewSession(firstConfirmed, {
      kind: "extend",
      now: NOW + 8 * MINUTE,
      commandId: "extend-2",
    });
    const secondConfirmed = transitionPreviewSession(secondPending, {
      kind: "deadline-confirmed",
      now: NOW + 9 * MINUTE,
      generation: "gen-1",
      deadlineVersion: secondPending.deadlineVersion,
      expiresAt: secondPending.pendingDeadline!.target,
    });
    expect(secondConfirmed.extensions).toBe(2);
    expect(secondConfirmed.expiresAt).toBe(active.firstReadyAt! + 4 * HOUR);
    expect(() =>
      transitionPreviewSession(secondConfirmed, {
        kind: "extend",
        now: NOW + 10 * MINUTE,
        commandId: "extend-3",
      }),
    ).toThrow();
  });

  it("cancels a pending extension when stop fences the generation", () => {
    const pending = transitionPreviewSession(ready(), {
      kind: "extend",
      now: NOW + 6 * MINUTE,
      commandId: "extend-1",
    });
    const stopped = transitionPreviewSession(pending, {
      kind: "stop",
      now: NOW + 7 * MINUTE,
      commandId: "stop-1",
    });
    expect(stopped.status).toBe("stopping");
    expect(stopped.stopReason).toBe("stop");
    expect(stopped.pendingDeadline).toBeUndefined();
    expect(stopped.extensions).toBe(0);
    expect(stopped.operationVersion).toBe(pending.operationVersion + 1);
    expect(() =>
      transitionPreviewSession(stopped, {
        kind: "deadline-confirmed",
        now: NOW + 8 * MINUTE,
        generation: "gen-1",
        deadlineVersion: pending.deadlineVersion,
        expiresAt: pending.pendingDeadline!.target,
      }),
    ).toThrow();
  });

  it("rejects stale cleanup evidence after a late operation settles", () => {
    const initial = create();
    const dispatch = transitionPreviewSession(initial, {
      kind: "effect-started",
      now: NOW,
      generation: "gen-1",
      operationVersion: 1,
      operationId: "late",
    });
    const stopping = transitionPreviewSession(dispatch, { kind: "stop", now: NOW + 1 });
    const stale = {
      kind: "cleanup-observed" as const,
      now: NOW + 3,
      generation: "gen-1",
      absent: true,
      ownershipVersion: stopping.ownershipVersion,
    };
    const settled = transitionPreviewSession(stopping, {
      kind: "effect-settled",
      now: NOW + 2,
      generation: "gen-1",
      operationId: "late",
      resources: ["late-db"],
    });
    const result = transitionPreviewSession(settled, stale);
    expect(result.status).toBe("cleanup-pending");
    expect(result.ownedResources).toEqual(["late-db"]);
    expect(result.reservationHeld).toBe(true);
  });

  it("accepts an unchanged start while an extension is pending or time is short", () => {
    const active = ready();
    const pending = transitionPreviewSession(active, {
      kind: "extend",
      now: NOW + 6 * MINUTE,
      commandId: "extend",
    });
    for (const [session, now] of [
      [pending, NOW + 7 * MINUTE],
      [active, active.expiresAt - MINUTE],
    ] as const) {
      const result = transitionPreviewSession(session, {
        kind: "start",
        now,
        commandId: "noop",
        revision: REV_A,
        aliases: [],
        startupBudgetMs: 20 * MINUTE,
      });
      expect(result.expiresAt).toBe(session.expiresAt);
      expect(result.operationVersion).toBe(session.operationVersion);
      expect(result.processedCommands).toContain("noop");
    }
  });

  it("retains late allocations and the reservation until absence is proven", () => {
    const started = transitionPreviewSession(ready(), {
      kind: "effect-started",
      now: NOW + 6 * MINUTE,
      generation: "gen-1",
      operationVersion: 1,
      operationId: "provider-op-1",
    });
    const stopping = transitionPreviewSession(started, {
      kind: "closed",
      now: NOW + 7 * MINUTE,
      commandId: "close-1",
    });
    const observed = transitionPreviewSession(stopping, {
      kind: "cleanup-observed",
      ownershipVersion: stopping.ownershipVersion,
      now: NOW + 8 * MINUTE,
      generation: "gen-1",
      absent: true,
    });
    expect(observed.status).toBe("cleanup-pending");
    expect(observed.reservationHeld).toBe(true);

    const settled = transitionPreviewSession(observed, {
      kind: "effect-settled",
      now: NOW + 9 * MINUTE,
      generation: "gen-1",
      operationId: "provider-op-1",
      resources: ["cluster-1"],
    });
    expect(settled.outstandingOperations).toEqual([]);
    expect(settled.ownedResources).toEqual(["cluster-1"]);
    expect(settled.reservationHeld).toBe(true);

    const cleaned = transitionPreviewSession(settled, {
      kind: "cleanup-observed",
      ownershipVersion: settled.ownershipVersion,
      now: NOW + 10 * MINUTE,
      generation: "gen-1",
      absent: true,
    });
    expect(cleaned.status).toBe("stopped");
    expect(cleaned.ownedResources).toEqual([]);
    expect(cleaned.reservationHeld).toBe(false);
    const unknown = transitionPreviewSession(cleaned, {
      kind: "effect-settled",
      now: NOW + 11 * MINUTE,
      generation: "gen-1",
      operationId: "unknown-op",
      resources: ["cluster-2"],
    });
    expect(unknown.ownedResources).toEqual([]);
  });

  it("stops setup timeout work at twenty minutes and keeps charges pending", () => {
    const initial = create();
    expect(
      transitionPreviewSession(initial, {
        kind: "tick",
        now: initial.setupDeadline - 1,
      }),
    ).toEqual(initial);
    const timedOut = transitionPreviewSession(initial, {
      kind: "tick",
      now: initial.setupDeadline,
    });
    expect(timedOut.status).toBe("stopping");
    expect(timedOut.stopReason).toBe("setup-timeout");
    expect(timedOut.reservationHeld).toBe(true);
    expect(() => ready(timedOut)).toThrow();
  });

  it("moves confirmed expiry to stopping, then expired after absence", () => {
    const active = ready();
    const stopping = transitionPreviewSession(active, {
      kind: "tick",
      now: active.expiresAt,
    });
    expect(stopping.status).toBe("stopping");
    const expired = transitionPreviewSession(stopping, {
      kind: "cleanup-observed",
      ownershipVersion: stopping.ownershipVersion,
      now: active.expiresAt + MINUTE,
      generation: "gen-1",
      absent: true,
    });
    expect(expired.status).toBe("expired");
    expect(expired.reservationHeld).toBe(false);
    expect(() =>
      transitionPreviewSession(expired, {
        kind: "start",
        now: active.expiresAt + 2 * MINUTE,
        commandId: "restart",
        revision: REV_B,
        aliases: [],
        startupBudgetMs: MINUTE,
      }),
    ).toThrow();
  });
});
