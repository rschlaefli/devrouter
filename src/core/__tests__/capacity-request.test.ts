import { expect, it } from "vitest";
import type { CapacityEstimates } from "../../types";
import type { CapacityPolicyEnrollment } from "../capacity-policy";
import { capacityRequest } from "../capacity-request";
import { capacityEstimatesDigest } from "../repo-config";

const estimates: CapacityEstimates = {
  version: 1,
  profiles: {
    small: {
      host: { steadyBytes: 10, startupTotalBytes: 20 },
      runtime: { steadyBytes: 30, startupTotalBytes: 50 },
      operations: { build: { hostIncrementBytes: 5, runtimeIncrementBytes: 10 } },
    },
    full: {
      host: { steadyBytes: 20, startupTotalBytes: 40 },
      runtime: { steadyBytes: 60, startupTotalBytes: 100 },
      operations: {},
    },
  },
};
const enrollment: CapacityPolicyEnrollment = {
  repoPath: "/fixture/repo",
  gitCommonDir: "/fixture/git",
  workspace: "fixture",
  provider: "devsy",
  providerId: "fixture",
  hostDomain: "host",
  runtimeDomain: "guest",
  profiles: ["small", "full"],
  estimatesDigest: capacityEstimatesDigest(estimates),
  defaultOperation: { hostIncrementBytes: 10, runtimeIncrementBytes: 20 },
};

it("uses startup totals and retains the source allocation during profile expansion", () => {
  const request = { environmentId: "one", profile: "full", kind: "ensure" as const };
  expect(capacityRequest(estimates, enrollment, request).totals).toEqual({ host: 40, guest: 100 });
  expect(
    capacityRequest(estimates, enrollment, { ...request, activeProfile: "small" }).totals,
  ).toEqual({ host: 50, guest: 130 });
});

it("uses the conservative heavy class for both missing and unknown operation names", () => {
  const request = {
    environmentId: "one",
    profile: "small",
    activeProfile: "small",
    kind: "exec" as const,
  };
  for (const operation of [undefined, "unlisted"]) {
    expect(capacityRequest(estimates, enrollment, { ...request, operation })).toMatchObject({
      totals: { host: 20, guest: 50 },
      heavy: true,
      startup: false,
    });
  }
  expect(capacityRequest(estimates, enrollment, { ...request, operation: "build" }).totals).toEqual(
    { host: 15, guest: 40 },
  );
});

it("rejects changed estimates and undersized default operation authority", () => {
  const request = { environmentId: "one", profile: "small", kind: "ensure" as const };
  expect(() =>
    capacityRequest(estimates, { ...enrollment, estimatesDigest: "0".repeat(64) }, request),
  ).toThrow("changed since enrollment");
  expect(() =>
    capacityRequest(
      estimates,
      { ...enrollment, defaultOperation: { hostIncrementBytes: 0, runtimeIncrementBytes: 1 } },
      request,
    ),
  ).toThrow("does not cover");
});
