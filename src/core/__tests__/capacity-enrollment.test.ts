import fs from "node:fs";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCapacityEnrollment } from "../capacity-enrollment";
import type { CapacityPolicy } from "../capacity-policy";

const fixture = vi.hoisted(() => ({
  resolve: vi.fn(),
  probe: vi.fn(),
  config: vi.fn(),
  digest: vi.fn(),
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
