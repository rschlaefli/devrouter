import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapacityHistoryError, CapacityStore } from "../../core/capacity-store";
import { runCapacityCommand } from "../capacity";

type JournalBinding = { environmentId: string; repoPath: string; workspace: string | null };

const journal = vi.hoisted(() => ({
  floor: 0,
  bindings: [] as Array<{ environmentId: string; repoPath: string; workspace: string | null }>,
  failure: undefined as Error | undefined,
  enumerations: 0,
  sequence: undefined as
    | Array<{
        floor: number;
        bindings: Array<{ environmentId: string; repoPath: string; workspace: string | null }>;
      }>
    | undefined,
}));

vi.mock("../../core/reliability-operation-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/reliability-operation-store")>();
  return {
    ...actual,
    listUnsettledCapacityBindings: () => {
      journal.enumerations += 1;
      if (journal.failure) throw journal.failure;
      const step = journal.sequence?.shift();
      if (step)
        return { floor: step.floor, bindings: step.bindings.map((entry) => ({ ...entry })) };
      return { floor: journal.floor, bindings: journal.bindings.map((entry) => ({ ...entry })) };
    },
  };
});

let directory: string;

function ledgerPath(): string {
  return path.join(directory, "capacity-reservations.json");
}

function markerPath(): string {
  return path.join(directory, "capacity-ledger.established");
}

function writeAbsentEvidence(): void {
  fs.writeFileSync(markerPath(), '{"version":1}\n', { mode: 0o600 });
}

function writeLedger(revision: number, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    ledgerPath(),
    `${JSON.stringify({ version: 1, revision, reservations: [], ...extra })}\n`,
    { mode: 0o600 },
  );
}

function writeRuntimePolicy(endpoint: string): void {
  fs.writeFileSync(
    path.join(directory, "capacity-policy.json"),
    `${JSON.stringify({
      version: 1,
      revision: 1,
      admissions: "enabled",
      scheduling: {
        maxQueuedPerDomain: 32,
        maxQueuedTotal: 64,
        queueLifetimeSeconds: 900,
        clientWaitSeconds: 300,
        maxClientWaitSeconds: 900,
        watchSeconds: 30,
        sampleIntervalSeconds: 5,
        maxSampleAgeSeconds: 15,
      },
      recovery: {
        enabled: false,
        maxProcessRestarts: 2,
        maxServiceRestarts: 1,
        maxCorrectiveActions: 3,
        windowSeconds: 600,
        observationSeconds: 30,
        resumeDwellSeconds: 300,
      },
      domains: {
        host: {
          kind: "host",
          adapter: "macos-host-v1",
          capacityBytes: 1000,
          protectedHeadroomBytes: 100,
          startupSlots: 1,
          heavySlots: 1,
        },
        "runtime-a": {
          kind: "runtime",
          adapter: "orbstack-local-v1",
          endpoint,
          daemonId: "daemon-a",
          hostDomain: "host",
          hostChargeCeilingBytes: 800,
          capacityBytes: 500,
          protectedHeadroomBytes: 50,
          startupSlots: 1,
          heavySlots: 1,
        },
      },
      enrollments: [],
    })}\n`,
    { mode: 0o600 },
  );
}

function stdout(): string {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((call) => String(call[0]))
    .join("");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.exitCode = undefined;
  journal.floor = 0;
  journal.bindings = [];
  journal.failure = undefined;
  journal.enumerations = 0;
  journal.sequence = undefined;
  // The policy reader rejects any symlinked path component, and macOS exposes
  // the temp root through /var.
  directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "devrouter-capacity-command-")),
  );
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("runCapacityCommand reconcile", () => {
  it("refuses without --yes and writes nothing", async () => {
    writeAbsentEvidence();

    await runCapacityCommand(
      "reconcile",
      { json: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-reconcile-confirmation-required",
    });
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it("refuses while a journal charge remains and names each blocking environment", async () => {
    writeAbsentEvidence();
    journal.floor = 3;
    journal.bindings = [
      { environmentId: "env-one", repoPath: "/tmp/plain/repo", workspace: null },
      { environmentId: "env-two", repoPath: "/tmp/it's here/repo", workspace: "feat" },
    ];
    const observePools = vi.fn(async () => []);

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory), observePools },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-charges-pending",
      bindings: journal.bindings,
    });
    // A pending charge is decisive on local evidence alone: no pool probe, no write.
    expect(observePools).not.toHaveBeenCalled();
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it("quotes the recovery command so an operator can paste it verbatim", async () => {
    writeAbsentEvidence();
    journal.bindings = [
      { environmentId: "env-two", repoPath: "/tmp/it's here/repo", workspace: null },
    ];

    await runCapacityCommand(
      "reconcile",
      { yes: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(stdout()).toContain("devrouter stop '/tmp/it'\\''s here/repo'");
  });

  it("refuses when the ledger is intact and leaves the bytes untouched", async () => {
    writeAbsentEvidence();
    writeLedger(4);
    const before = fs.readFileSync(ledgerPath(), "utf8");

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-history-intact",
    });
    expect(fs.readFileSync(ledgerPath(), "utf8")).toBe(before);
    expect(journal.enumerations).toBe(0);
  });

  it("refuses a pristine store as having no loss to reconcile", async () => {
    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({ reason: "capacity-history-intact" });
    expect(fs.existsSync(ledgerPath())).toBe(false);
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it("refuses a snapshot the surviving journals have outrun", async () => {
    writeAbsentEvidence();
    writeLedger(1);
    const before = fs.readFileSync(ledgerPath(), "utf8");

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory, undefined, () => 5) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-ledger-unusable",
    });
    expect(fs.readFileSync(ledgerPath(), "utf8")).toBe(before);
  });

  it("refuses when a declared runtime pool cannot be observed", async () => {
    writeAbsentEvidence();
    writeRuntimePolicy(path.join(directory, "missing-daemon.sock"));

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-pools-unresolved",
      domains: ["runtime-a"],
    });
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it("refuses when the journals cannot be enumerated", async () => {
    writeAbsentEvidence();
    journal.failure = new CapacityHistoryError("capacity-history-unprovable");

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory) },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-history-unprovable",
    });
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it("publishes a fresh baseline above the journal floor with the observed ceilings", async () => {
    writeAbsentEvidence();
    journal.floor = 6;
    const pools = [
      {
        daemonId: "daemon-a",
        runtimeDomain: "runtime-a",
        hostDomain: "host",
        hostChargeCeilingBytes: 800,
      },
    ];

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      {
        directory,
        store: new CapacityStore(directory),
        observePools: async () => pools,
      },
    );

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: true,
      reconciled: true,
      revision: 7,
      unresolved: 0,
    });
    expect(JSON.parse(fs.readFileSync(ledgerPath(), "utf8"))).toEqual({
      version: 1,
      revision: 7,
      reservations: [],
      pools,
    });
    expect(fs.existsSync(markerPath())).toBe(true);
  });

  it("withdraws the fresh baseline when a charge appears before confirmation", async () => {
    writeAbsentEvidence();
    const appeared: JournalBinding[] = [
      { environmentId: "env-late", repoPath: "/tmp/late/repo", workspace: null },
    ];
    journal.bindings = appeared;
    journal.sequence = [
      { floor: 0, bindings: [] },
      { floor: 0, bindings: appeared },
    ];

    await runCapacityCommand(
      "reconcile",
      { yes: true, json: true },
      { directory, store: new CapacityStore(directory), observePools: async () => [] },
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      version: 1,
      ok: false,
      reason: "capacity-charges-pending",
      bindings: appeared,
    });
    expect(fs.existsSync(ledgerPath())).toBe(false);
    expect(fs.existsSync(markerPath())).toBe(true);
  });
});
