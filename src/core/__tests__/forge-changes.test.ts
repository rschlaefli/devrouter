import { describe, expect, it, vi } from "vitest";
import {
  type ForgeCommandRunner,
  listForgeChanges,
  newestSameRepositoryChange,
} from "../forge-changes";

const sha = "a".repeat(40);

function mergeRequest(iid: number) {
  return {
    iid,
    source_branch: `b${iid}`,
    state: "merged",
    sha,
    source_project_id: 1,
    target_project_id: 1,
  };
}

describe("listForgeChanges", () => {
  it("retries a failing call and then reports the forge unavailable", () => {
    const runner = vi.fn<ForgeCommandRunner>(() => ({ status: 1, stdout: "" }));
    const sleep = vi.fn();
    const listing = listForgeChanges(
      { provider: "github", project: "acme/repo" },
      { runner, sleep },
    );
    expect(listing.status).toBe("unavailable");
    expect(runner).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("recovers when a retry succeeds", () => {
    const runner = vi
      .fn<ForgeCommandRunner>()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]" });
    const listing = listForgeChanges(
      { provider: "github", project: "acme/repo" },
      { runner, sleep: () => {} },
    );
    expect(listing).toEqual({ status: "listed", provider: "github", changes: [] });
  });

  it("reports a malformed listing as unavailable", () => {
    const runner: ForgeCommandRunner = () => ({ status: 0, stdout: '[{"number":"x"}]' });
    expect(
      listForgeChanges({ provider: "github", project: "acme/repo" }, { runner, sleep: () => {} })
        .status,
    ).toBe("unavailable");
  });

  it("pages GitLab merge requests until a short page", () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => mergeRequest(index + 1)),
      [mergeRequest(101)],
    ];
    const runner = vi.fn<ForgeCommandRunner>(() => ({
      status: 0,
      stdout: JSON.stringify(pages.shift() ?? []),
    }));
    const listing = listForgeChanges(
      { provider: "gitlab", project: "group/sub/repo" },
      { runner, sleep: () => {} },
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(listing.status === "listed" && listing.changes).toHaveLength(101);
  });
});

describe("newestSameRepositoryChange", () => {
  it("ignores fork changes and picks the highest number", () => {
    const change = (number: number, crossRepository: boolean) => ({
      number,
      sourceBranch: "feature",
      headSha: sha,
      state: "OPEN" as const,
      crossRepository,
    });
    expect(
      newestSameRepositoryChange([change(3, false), change(9, true), change(5, false)], "feature")
        ?.number,
    ).toBe(5);
  });
});
