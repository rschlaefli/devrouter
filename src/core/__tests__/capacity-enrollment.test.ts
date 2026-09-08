import fs from "node:fs";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { enrollCapacityLifecycle, resolveCapacityEnrollment } from "../capacity-enrollment";
import type { CapacityPolicy } from "../capacity-policy";

const fixture = vi.hoisted(() => ({
  resolve: vi.fn(),
  probe: vi.fn(),
  config: vi.fn(),
  digest: vi.fn(),
  journal: vi.fn(),
  enroll: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("../capacity-policy", () => ({ readCapacityPolicy: fixture.policy }));
vi.mock("../reliability-operation-store", () => ({
  readReliabilityOperation: fixture.journal,
  enrollStoppedLifecycle: fixture.enroll,
}));
vi.mock("../controller-binding", () => ({
  resolveControllerBinding: fixture.resolve,
  readControllerEvidence: () => "synthetic",
}));
vi.mock("../controller-probe", () => ({ runControllerProbe: fixture.probe }));
vi.mock("../repo-config", () => ({
  loadRepoConfig: fixture.config,
  capacityEstimatesDigest: fixture.digest,
}));
afterEach(() => vi.clearAllMocks());

it.each([
  "match",
  "provider",
  "providerId",
  "workspace",
  "gitCommonDir",
  "profile",
  "digest",
  "ownership-change",
])("requires exact enrollment evidence (%s)", async (difference) => {
  const environment = {
    id: "environment",
    repoPath: "/fixture/checkout",
    workspace: "fixture",
    provider: "devsy",
    providerId: "provider",
    profile: "full",
    fingerprint: "fingerprint",
  };
  fixture.resolve.mockResolvedValue(environment);
  if (difference === "ownership-change")
    fixture.resolve
      .mockResolvedValueOnce(environment)
      .mockResolvedValueOnce({ ...environment, providerId: "replacement" });
  const common = fs.realpathSync(os.tmpdir());
  fixture.probe.mockResolvedValue(common);
  fixture.config.mockReturnValue({ capacity: { version: 1 } });
  fixture.digest.mockReturnValue(difference === "digest" ? "changed" : "approved");
  const enrollment = {
    ...environment,
    gitCommonDir: common,
    profiles: ["full"],
    estimatesDigest: "approved",
  };
  const changed = {
    ...enrollment,
    ...(difference === "provider" ? { provider: "devpod" } : {}),
    ...(difference === "providerId" ? { providerId: "other" } : {}),
    ...(difference === "workspace" ? { workspace: "other" } : {}),
    ...(difference === "gitCommonDir" ? { gitCommonDir: "/other" } : {}),
    ...(difference === "profile" ? { profiles: ["small"] } : {}),
  };
  const policy = { enrollments: [changed] } as unknown as CapacityPolicy;
  const resolve = resolveCapacityEnrollment(
    policy,
    { path: environment.repoPath, profile: "full", require: ["runtime"] },
    new AbortController().signal,
  );
  if (difference === "match")
    await expect(resolve).resolves.toMatchObject({ environment, enrollment: changed });
  else await expect(resolve).rejects.toThrow();
});

it.each([
  "match",
  "paused",
  "journal-missing",
  "cancelled",
  "policy-changed",
  "policy-missing",
] as const)("converts only canonical enabled enrollment with an existing journal (%s)", async (condition) => {
  const common = fs.realpathSync(os.tmpdir());
  const environment = {
    id: "environment",
    repoPath: "/fixture/checkout",
    workspace: "fixture",
    provider: "devsy" as const,
    providerId: "provider",
    profile: "full",
    fingerprint: "fingerprint",
  };
  const enrollment = {
    ...environment,
    gitCommonDir: common,
    profiles: ["full"],
    estimatesDigest: "a".repeat(64),
    hostDomain: "host",
    runtimeDomain: "guest",
  };
  const runtime = { kind: "runtime", endpoint: "/tmp/synthetic.sock", daemonId: "daemon" };
  const policy = {
    revision: 7,
    admissions: condition === "paused" ? "paused" : "enabled",
    enrollments: [enrollment],
    domains: { guest: runtime },
  } as unknown as CapacityPolicy;
  fixture.policy.mockReturnValue(policy);
  if (condition === "policy-missing") fixture.policy.mockReturnValue(undefined);
  if (condition === "policy-changed")
    fixture.policy
      .mockReturnValueOnce(policy)
      .mockReturnValueOnce({ ...policy, admissions: "paused" });
  fixture.resolve.mockResolvedValue(environment);
  fixture.probe.mockResolvedValue(common);
  fixture.config.mockReturnValue({ capacity: { version: 1 } });
  fixture.digest.mockReturnValue(enrollment.estimatesDigest);
  fixture.journal.mockReturnValue(condition === "journal-missing" ? undefined : { revision: 19 });
  const abort = new AbortController();
  if (condition === "cancelled") abort.abort();
  const result = enrollCapacityLifecycle(
    policy,
    { path: environment.repoPath, profile: "full", require: [] },
    abort.signal,
  );
  if (condition === "match") {
    await expect(result).resolves.toMatchObject({ environment });
    expect(fixture.enroll).toHaveBeenCalledWith(
      {
        repoPath: environment.repoPath,
        workspace: environment.workspace,
        provider: environment.provider,
      },
      19,
      {
        policyRevision: 7,
        gitCommonDir: common,
        providerId: "provider",
        hostDomain: "host",
        runtimeDomain: "guest",
        endpoint: runtime.endpoint,
        daemonId: runtime.daemonId,
        estimatesDigest: enrollment.estimatesDigest,
      },
    );
  } else {
    await expect(result).rejects.toThrow();
    expect(fixture.enroll).not.toHaveBeenCalled();
  }
});
