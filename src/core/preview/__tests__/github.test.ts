import { describe, expect, it } from "vitest";
import { GitHubPreviewForge } from "../forge/github";
import { PreviewForgeHTTP, previewStatusBody } from "../forge/status";

function fixture() {
  const sha = "a".repeat(40),
    target = "b".repeat(40);
  const now = "2026-01-01T00:00:00Z";
  const comments = [
    {
      id: 1,
      node_id: "IC_fixture",
      body: "/preview start web",
      user: { id: 7, login: "maintainer", type: "User" },
      issue_url: "https://api.github.com/repos/example/app/issues/9",
      created_at: now,
      updated_at: now,
    },
  ];
  let permission = "write",
    head = sha,
    sourceReads = 0,
    race = false,
    truncated = false,
    fork = false,
    edited = false,
    copied = false,
    large = false;
  let savedComment: Record<string, unknown> | undefined;
  const writes: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(init?.redirect).toBe("error");
    let data: unknown;
    if (init?.method !== "GET" && path !== "/graphql") writes.push(path);
    if (path.endsWith("/repos/example/app")) data = { id: 123, full_name: "example/app" };
    else if (path.endsWith("/pulls/9")) {
      sourceReads++;
      if (race && sourceReads > 1) head = "f".repeat(40);
      data = {
        number: 9,
        state: "open",
        merged: false,
        changed_files: truncated ? 2 : 1,
        head: { sha: head, repo: { id: fork ? 456 : 123 } },
        base: { sha: target, repo: { id: 123 } },
      };
    } else if (path.endsWith("/files"))
      data = [
        {
          filename: "src/new.ts",
          previous_filename: "src/old.ts",
          status: copied ? "copied" : "renamed",
          ...(large ? { patch: "x".repeat(2 * 1024 * 1024) } : {}),
        },
      ];
    else if (path.includes("/compare/")) data = { merge_base_commit: { sha: "c".repeat(40) } };
    else if (path.endsWith("/permission")) data = { permission, user: { id: 7 } };
    else if (path.endsWith("/comments/1")) data = comments[0];
    else if (path.endsWith("/comments/99")) {
      if (init?.method === "PATCH")
        savedComment = { ...savedComment, ...JSON.parse(init.body as string) };
      data = savedComment;
    } else if (path.endsWith("/comments")) {
      if (init?.method === "POST") {
        savedComment = {
          id: 99,
          user: { id: 99 },
          issue_url: comments[0].issue_url,
          ...JSON.parse(init.body as string),
        };
        data = savedComment;
      } else data = comments;
    } else if (path === "/graphql")
      data = {
        data: {
          node: {
            id: comments[0].node_id,
            body: comments[0].body,
            createdAt: comments[0].created_at,
            author: { __typename: "User", login: "maintainer" },
            lastEditedAt: edited ? now : null,
          },
        },
      };
    else throw new Error("Unexpected fixture endpoint");
    return new Response(JSON.stringify(data));
  };
  const forge = new GitHubPreviewForge({
    apiUrl: "https://api.github.com/",
    forgeHost: "github.com",
    repository: "example/app",
    projectId: "123",
    botId: "99",
    token: async () => "synthetic",
    fetch: fetcher,
  });
  return {
    forge,
    comments,
    writes,
    edited: () => {
      edited = true;
    },
    copied: () => {
      copied = true;
    },
    large: () => {
      large = true;
    },
    readOnly: () => {
      permission = "read";
    },
    race: () => {
      race = true;
    },
    truncate: () => {
      truncated = true;
    },
    fork: () => {
      fork = true;
    },
  };
}

describe("GitHub preview source and authority", () => {
  it("re-fetches original human root comments and effective current write permission", async () => {
    const f = fixture();
    expect(await f.forge.admission(9, "1")).toMatchObject({
      actorCanWrite: true,
      originalHumanRoot: true,
      sameProject: true,
      command: { kind: "start", aliases: ["web"] },
    });
    f.readOnly();
    expect((await f.forge.admission(9, "1"))?.actorCanWrite).toBe(false);
    f.comments[0].updated_at = "2026-01-01T00:00:01Z";
    expect(await f.forge.admission(9, "1")).toBeNull();
    f.comments[0].updated_at = f.comments[0].created_at;
    f.comments[0].user.type = "Bot";
    expect(await f.forge.admission(9, "1")).toBeNull();
    expect(f.writes).toEqual([]);
  });
  it("binds cumulative rename paths and rejects truncated or racing source evidence", async () => {
    const f = fixture();
    expect((await f.forge.snapshot(9)).source).toMatchObject({
      complete: true,
      changes: [{ status: "R", path: "src/new.ts", oldPath: "src/old.ts" }],
    });
    f.truncate();
    await expect(f.forge.snapshot(9)).rejects.toThrow("incomplete");
    const race = fixture();
    race.race();
    await expect(race.forge.snapshot(9)).rejects.toThrow("changed");
  });
  it("marks fork sources ineligible and excludes edited comments from recovered history", async () => {
    const f = fixture();
    f.fork();
    expect((await f.forge.snapshot(9)).sameProject).toBe(false);
    f.comments[0].body = "```/preview start web```";
    expect(await f.forge.commands(9, 0, Date.now())).toEqual([]);
  });
  it("reads every linked page and fails bounded or non-advancing pagination", async () => {
    let calls = 0;
    const http = new PreviewForgeHTTP({
      apiUrl: "https://api.github.com/",
      token: async () => "synthetic",
      kind: "github",
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify(calls === 1 ? [{ id: 1 }] : [{ id: 2 }]), {
          headers:
            calls === 1 ? { link: '<https://api.github.com/unused?page=2>; rel="next"' } : {},
        });
      },
    });
    expect(await http.pages("repos/example/app/issues/9/comments")).toEqual([{ id: 1 }, { id: 2 }]);
    await expect(http.request("GET", "https://attacker.example/path")).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it("does not publish updates to unowned status comments", async () => {
    const f = fixture();
    await expect(f.forge.publish(9, "status", "1")).rejects.toThrow("ownership");
    expect(f.writes).toEqual([]);
  });
  it("rejects edits even when REST timestamps are equal", async () => {
    const f = fixture();
    f.edited();
    expect(await f.forge.admission(9, "1")).toBeNull();
  });
  it("carries copy-source paths and projects large patch responses down to source metadata", async () => {
    const f = fixture();
    f.copied();
    f.large();
    const snapshot = await f.forge.snapshot(9);
    expect(snapshot.source.changes).toEqual([
      { status: "C", path: "src/new.ts", oldPath: "src/old.ts" },
    ]);
  });
  it("updates the same bot-owned status after reporting no environment", async () => {
    const f = fixture();
    const body = previewStatusBody(null);
    const id = await f.forge.publish(9, body);
    expect(await f.forge.publish(9, body, id)).toBe(id);
    expect(f.writes).toHaveLength(2);
  });
});
