import { describe, expect, it } from "vitest";
import { GitLabPreviewForge } from "../forge/gitlab";
import { previewStatusBody } from "../forge/status";

function fixture() {
  const head = "a".repeat(40),
    target = "b".repeat(40),
    base = "c".repeat(40);
  let branchHead = target;
  let controllerRole = "no_one_allowed";
  let outsiders = 0;
  let edited = false,
    fork = false,
    truncated = false,
    moving = false,
    permission = 30,
    published: Record<string, unknown> | undefined;
  const reads: string[] = [],
    writes: string[] = [];
  const note = () => ({
    id: 1,
    type: null,
    imported: false,
    project_id: 123,
    noteable_iid: 9,
    noteable_type: "MergeRequest",
    resolvable: false,
    system: false,
    body: "/preview start web",
    created_at: "2026-01-01T00:00:00.123Z",
    updated_at: "2026-01-01T00:00:00.123Z",
    author: { id: 8 },
  });
  const merge = () => ({
    iid: 9,
    target_project_id: 123,
    source_project_id: fork ? 999 : 123,
    target_branch: "main",
    state: "opened",
    sha:
      moving && reads.filter((p) => p === "/api/v4/projects/123/merge_requests/9").length > 1
        ? "f".repeat(40)
        : head,
    changes_count: truncated ? "2" : "1",
    diff_refs: { head_sha: head, start_sha: target, base_sha: base },
  });
  const forge = new GitLabPreviewForge({
    apiUrl: "https://gitlab.example.org/api/v4/",
    forgeHost: "gitlab.example.org",
    repository: "group/app",
    projectId: "123",
    botId: "456",
    controllerProjectId: "777",
    token: async () => "synthetic",
    fetch: async (input, init) => {
      const url = new URL(String(input)),
        route = url.pathname;
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "x-next-page": "" } });
      if (route === "/api/graphql")
        return reply({
          data: {
            note: {
              id: "gid://gitlab/Note/1",
              body: note().body,
              createdAt: "2026-01-01T00:00:00Z",
              lastEditedAt: edited ? note().created_at : null,
              author: { id: "gid://gitlab/User/8" },
            },
          },
        });
      if (init?.method !== "GET") {
        writes.push(route);
        published = {
          id: 99,
          author: { id: 456 },
          project_id: 123,
          noteable_iid: 9,
          ...JSON.parse(String(init?.body)),
        };
        return reply(published);
      }
      reads.push(route);
      if (route === "/api/v4/projects/777")
        return reply({ id: 777, ci_pipeline_variables_minimum_override_role: controllerRole });
      if (route === "/api/v4/projects/123")
        return reply({ id: 123, path_with_namespace: "group/app" });
      if (route === "/api/v4/projects/123/merge_requests/9") return reply(merge());
      if (route.endsWith("/resource_state_events")) return reply([]);
      if (route.endsWith("/repository/branches/main")) return reply({ commit: { id: branchHead } });
      if (route.endsWith("/repository/merge_base")) return reply({ id: base });
      if (route.endsWith("/diffs"))
        return reply([
          {
            old_path: "src/old.py",
            new_path: "src/app.py",
            a_mode: "100644",
            b_mode: "100644",
            renamed_file: true,
            new_file: false,
            deleted_file: false,
            collapsed: false,
            too_large: false,
          },
        ]);
      if (route.endsWith("/notes/1")) return reply(note());
      if (route.endsWith("/notes/99")) return reply(published);
      if (route.endsWith("/notes")) {
        const notes = [
          note(),
          ...Array.from({ length: outsiders }, (_, i) => ({
            ...note(),
            id: i + 2,
            author: { id: 1000 + i },
          })),
          ...(published ? [published] : []),
        ];
        const page = Number(url.searchParams.get("page") ?? "1");
        return new Response(JSON.stringify(notes.slice((page - 1) * 100, page * 100)), {
          headers: { "x-next-page": notes.length > page * 100 ? String(page + 1) : "" },
        });
      }
      if (route.endsWith("/members/all")) return reply([{ id: 8, access_level: permission }]);
      if (route.endsWith("/members/all/8")) return reply({ id: 8, access_level: permission });
      if (route.endsWith("/users/8")) return reply({ id: 8, state: "active", bot: false });
      if (route === "/api/v4/projects/123/merge_requests") return reply([merge()]);
      throw new Error(`unexpected fixture request ${route}`);
    },
  });
  return {
    forge,
    reads,
    writes,
    edit: () => {
      edited = true;
    },
    fork: () => {
      fork = true;
    },
    truncate: () => {
      truncated = true;
    },
    move: () => {
      moving = true;
    },
    unsafeController: () => {
      controllerRole = "maintainer";
    },
    outsiderBurst: () => {
      outsiders = 130;
    },
    advanceTarget: () => {
      branchHead = "d".repeat(40);
    },
    revoke: () => {
      permission = 20;
    },
  };
}

describe("GitLab registered preview forge", () => {
  it("binds current cumulative source and preserves both rename paths", async () => {
    const f = fixture(),
      snapshot = await f.forge.snapshot(9);
    expect(snapshot.source.complete).toBe(true);
    expect(snapshot.source.changes).toEqual([
      { status: "R", path: "src/app.py", oldPath: "src/old.py" },
    ]);
    expect((await f.forge.admission(9, "1"))?.actorCanWrite).toBe(true);
    expect((await f.forge.commands(9, 0, Date.now()))[0].id).toBe("1");
  });
  it("binds an advanced target when the cumulative diff still has the verified merge base", async () => {
    const f = fixture();
    f.advanceTarget();
    expect((await f.forge.snapshot(9)).source.target).toBe("d".repeat(40));
    expect((await f.forge.snapshot(9, false)).source.target).toBe("d".repeat(40));
  });
  it("refuses truncated or moved source and fork admission", async () => {
    for (const method of ["truncate", "move"] as const) {
      const f = fixture();
      f[method]();
      await expect(f.forge.snapshot(9)).rejects.toThrow();
    }
    const f = fixture();
    f.fork();
    expect((await f.forge.snapshot(9)).source.complete).toBe(false);
    expect((await f.forge.admission(9, "1"))?.sameProject).toBe(false);
  });
  it("rechecks membership and ignores edited notes", async () => {
    const edited = fixture();
    edited.edit();
    expect(await edited.forge.admission(9, "1")).toBeNull();
    const revoked = fixture();
    revoked.revoke();
    expect(await revoked.forge.admission(9, "1")).toBeNull();
  });
  it("requires the registered controller project to forbid all pipeline variable overrides", async () => {
    const f = fixture();
    await f.forge.verifyControllerSafe();
    f.unsafeController();
    await expect(f.forge.verifyControllerSafe()).rejects.toMatchObject({
      reason: "forge-unqualified",
    });
  });
  it("excludes an outsider burst before the controller authority window", async () => {
    const f = fixture();
    f.outsiderBurst();
    expect((await f.forge.commands(9, 0, Date.now())).map((row) => row.id)).toEqual(["1"]);
    expect(f.reads.filter((path) => path.includes("/members/all/"))).toEqual([]);
  });
  it("recovers and updates one bot-owned root status", async () => {
    const f = fixture(),
      body = previewStatusBody(null);
    const id = await f.forge.publish(9, body);
    expect(await f.forge.findStatus(9, "devrouter-preview")).toBe(id);
    expect(await f.forge.publish(9, body, id)).toBe(id);
    await expect(f.forge.publish(9, body, "1")).rejects.toThrow();
    expect(f.writes).toHaveLength(2);
    expect(await f.forge.changes(0)).toEqual([9]);
  });
});
