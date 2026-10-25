import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePreviewInstallation, loadPreviewInstallation } from "../installation";
import { createPreviewPool, PreviewStateConflict, type PreviewStateStore } from "../state";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-installation-"));
  dirs.push(root);
  const config = "version: 1\napps: []\n";
  const manifest = `version: 1
aliases: {web: {resources: [web]}}
bindings: {apps: {}, dependencies: {}, services: {}, processes: {}}
resources:
  web:
    kind: service
    image: example/app@sha256:${"a".repeat(64)}
    ports: [{name: http, port: 8080, public: true}]
selection:
  rules: [{paths: ['src/**'], aliases: [web]}]
  ignorePaths: ['docs/**']
  controlPaths: []
  allowedUnions: []
`;
  fs.writeFileSync(path.join(root, "local.yml"), config);
  fs.writeFileSync(path.join(root, "preview.yml"), manifest);
  const ref = (file: string, bytes: string) => ({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const policy = {
    version: 1,
    installationId: "test",
    state: {
      containerUrl: "https://example.blob.core.windows.net/previews",
      tokenEnv: "DEVROUTER_PREVIEW_STATE_TOKEN",
    },
    maxActive: 2,
    maxReservedCents: 1000,
    projects: [
      {
        key: "app",
        forge: {
          kind: "github",
          host: "github.com",
          apiUrl: "https://api.github.com/",
          repository: "example/app",
          projectId: "123",
          botId: "456",
          tokenEnv: "DEVROUTER_PREVIEW_GITHUB_TOKEN",
        },
        config: ref("local.yml", config),
        manifest: ref("preview.yml", manifest),
        northflank: {
          projectId: "test",
          tokenEnv: "DEVROUTER_PREVIEW_NORTHFLANK_TOKEN",
          graph: {
            namespace: "test",
            baseDomain: "preview.example.org",
            allowedNetworks: ["192.0.2.0/24"],
            resources: {
              web: {
                deploymentPlan: "nf-compute-10",
                readiness: { port: "http", path: "/health" },
              },
            },
          },
          qualification: {
            fixedDeadline: false,
            sameEnvironment: false,
            deletionFence: false,
            scopedRuntimeSecrets: false,
            restrictedIngress: false,
          },
          runtimeSecrets: {},
        },
        hourlyCents: { web: 1 },
        acceptance: { command: ["/bin/false"], environment: [] },
      },
    ],
  };
  const filename = path.join(root, "installation.json");
  const write = () => fs.writeFileSync(filename, JSON.stringify(policy));
  write();
  return { filename, policy, write, root };
}

describe("reviewed preview installation", () => {
  it("diagnoses an unqualified installation without requesting credentials or network", () => {
    const f = fixture();
    let calls = 0;
    const installed = loadPreviewInstallation(f.filename, {
      env: {},
      fetch: async () => {
        calls++;
        throw new Error("unexpected network");
      },
    });
    expect(installed.diagnostic.projects[0].qualified).toBe(false);
    expect(installed.diagnostic.projects[0].aliases).toEqual(["web"]);
    expect(calls).toBe(0);
  });
  it("rejects changed controls, escaping files and non-scoped credential mappings before effects", () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.root, "preview.yml"), "\n# drift\n");
    expect(() => loadPreviewInstallation(f.filename)).toThrow("fingerprint");
    f.policy.projects[0].manifest.file = "../outside.yml";
    f.write();
    expect(() => loadPreviewInstallation(f.filename)).toThrow();
    f.policy.state.tokenEnv = "GITHUB_TOKEN";
    f.write();
    expect(() => loadPreviewInstallation(f.filename)).toThrow("scoped");
  });
  it("sanitizes malformed credential maps and forbids deployment tokens in runtime mappings", () => {
    const f = fixture();
    expect(() =>
      loadPreviewInstallation(f.filename, {
        env: { DEVROUTER_PREVIEW_CREDENTIALS: "synthetic-secret-marker-not-json" },
      }),
    ).toThrow(/^Preview credential map is not valid JSON\.$/);
    f.policy.projects[0].northflank.runtimeSecrets = { upstream: "DEVROUTER_PREVIEW_STATE_TOKEN" };
    f.write();
    expect(() => loadPreviewInstallation(f.filename, { env: {} })).toThrow(
      "Deployment credentials cannot",
    );
  });
  it("automatically selects a bare start and reports unreviewed controls without allocating", async () => {
    for (const kind of ["github", "gitlab"] as const) {
      for (const mismatch of kind === "github"
        ? ([false, true, "symlink"] as const)
        : [false, true]) {
        const f = fixture(),
          now = 1_700_000_000_000;
        if (kind === "gitlab") {
          Object.assign(f.policy.projects[0].forge, {
            kind,
            host: "gitlab.example.org",
            apiUrl: "https://gitlab.example.org/api/v4/",
            repository: "group/app",
          });
          f.write();
        }
        const rows = new Map<string, { value: string; version: number }>();
        rows.set("installations/test/pool", {
          value: JSON.stringify(createPreviewPool("test")),
          version: 1,
        });
        let posted: unknown;
        const pull = {
          number: 9,
          state: "open",
          merged: false,
          changed_files: 1,
          base: { sha: "b".repeat(40), repo: { id: 123 } },
          head: { sha: "a".repeat(40), repo: { id: 123 } },
        };
        const comment = {
          id: 1,
          node_id: "synthetic-node",
          user: { id: 8, login: "maintainer", type: "User" },
          author_association: "MEMBER",
          issue_url: "https://api.github.com/repos/example/app/issues/9",
          body: "/preview start",
          created_at: new Date(now - 1).toISOString(),
          updated_at: new Date(now - 1).toISOString(),
        };
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
            new Response(JSON.stringify(body), { status, headers });
          if (url.hostname.endsWith(".blob.core.windows.net")) {
            const key = url.pathname.replace("/previews/", ""),
              row = rows.get(key);
            if (init?.method === "GET")
              return row
                ? new Response(row.value, { headers: { etag: `"${row.version}"` } })
                : new Response(null, {
                    status: 404,
                    headers: { "x-ms-error-code": "BlobNotFound" },
                  });
            const headers = new Headers(init?.headers);
            if (
              row
                ? headers.get("if-match") !== `"${row.version}"`
                : headers.get("if-none-match") !== "*"
            )
              return new Response(null, { status: 412 });
            const version = (row?.version ?? 0) + 1;
            rows.set(key, { value: String(init?.body), version });
            return new Response(null, { status: 201, headers: { etag: `"${version}"` } });
          }
          if (kind === "gitlab") {
            const prefix = "/api/v4/projects/123",
              route = url.pathname;
            const note = {
              id: 1,
              type: null,
              imported: false,
              project_id: 123,
              noteable_iid: 9,
              noteable_type: "MergeRequest",
              resolvable: false,
              system: false,
              body: comment.body,
              created_at: comment.created_at,
              updated_at: comment.updated_at,
              author: { id: 8 },
            };
            if (route === prefix) return json({ id: 123, path_with_namespace: "group/app" });
            if (route === `${prefix}/merge_requests/9`)
              return json({
                iid: 9,
                target_project_id: 123,
                source_project_id: 123,
                target_branch: "main",
                state: "opened",
                sha: "a".repeat(40),
                changes_count: "1",
                diff_refs: {
                  head_sha: "a".repeat(40),
                  start_sha: "b".repeat(40),
                  base_sha: "c".repeat(40),
                },
              });
            if (route.endsWith("/resource_state_events")) return json([]);
            if (route.endsWith("/repository/branches/main"))
              return json({ commit: { id: "d".repeat(40) } });
            if (route.endsWith("/repository/merge_base")) return json({ id: "c".repeat(40) });
            if (route.endsWith("/diffs"))
              return json([
                {
                  old_path: "docs/guide.md",
                  new_path: "docs/guide.md",
                  a_mode: "100644",
                  b_mode: "100644",
                  renamed_file: false,
                  new_file: false,
                  deleted_file: false,
                  collapsed: false,
                  too_large: false,
                },
              ]);
            if (route.endsWith("/notes/1")) return json(note);
            if (route.endsWith("/notes")) {
              if (init?.method === "POST") {
                posted = JSON.parse(String(init.body));
                return json({ id: 10, author: { id: 456 }, project_id: 123, noteable_iid: 9 });
              }
              return json([note]);
            }
            if (route.endsWith("/members/all")) return json([{ id: 8, access_level: 30 }]);
            if (route.endsWith("/members/all/8")) return json({ id: 8, access_level: 30 });
            if (route.endsWith("/users/8")) return json({ id: 8, bot: false, state: "active" });
            if (route === "/api/graphql")
              return json({
                data: {
                  note: {
                    id: "gid://gitlab/Note/1",
                    body: note.body,
                    createdAt: new Date(
                      Math.floor(Date.parse(note.created_at) / 1000) * 1000,
                    ).toISOString(),
                    lastEditedAt: null,
                    author: { id: "gid://gitlab/User/8" },
                  },
                },
              });
            if (route.includes("/repository/files/")) {
              const file = decodeURIComponent(route.split("/repository/files/")[1]),
                name = file === ".devrouter.yml" ? "local.yml" : "preview.yml";
              const bytes = Buffer.from(
                fs.readFileSync(path.join(f.root, name), "utf8") + (mismatch ? "\n# drift" : ""),
              );
              return json({
                file_path: file,
                encoding: "base64",
                size: bytes.length,
                content: bytes.toString("base64"),
              });
            }
            throw new Error(`unexpected GitLab synthetic route: ${route}`);
          }
          if (url.pathname === "/repos/example/app")
            return json({ id: 123, full_name: "example/app" });
          if (url.pathname === "/repos/example/app/pulls/9") return json(pull);
          if (url.pathname.endsWith("/events")) return json([]);
          if (url.pathname.endsWith("/issues/comments/1")) return json(comment);
          if (url.pathname.endsWith("/issues/9/comments")) {
            if (init?.method === "POST") {
              posted = JSON.parse(String(init.body));
              return json({ id: 10, user: { id: 456 }, issue_url: comment.issue_url });
            }
            return json([comment]);
          }
          if (url.pathname.endsWith("/collaborators/maintainer/permission"))
            return json({ permission: "write", user: { id: 8 } });
          if (url.pathname === "/graphql")
            return json({
              data: {
                node: {
                  id: comment.node_id,
                  lastEditedAt: null,
                  body: comment.body,
                  createdAt: comment.created_at,
                  author: { __typename: "User", login: "maintainer" },
                },
              },
            });
          if (url.pathname.endsWith("/files"))
            return json([{ status: "modified", filename: "docs/guide.md" }]);
          if (url.pathname.includes("/compare/"))
            return json({ merge_base_commit: { sha: "c".repeat(40) } });
          if (url.pathname.includes("/contents/")) {
            const file = url.pathname.split("/contents/")[1],
              name = file === ".devrouter.yml" ? "local.yml" : "preview.yml";
            const bytes = Buffer.from(
              fs.readFileSync(path.join(f.root, name), "utf8") + (mismatch ? "\n# drift" : ""),
            );
            return json({
              type: mismatch === "symlink" ? "symlink" : "file",
              path: file,
              encoding: "base64",
              size: bytes.length,
              content: bytes.toString("base64"),
            });
          }
          throw new Error(`unexpected synthetic request: ${url.pathname}`);
        };
        const installed = loadPreviewInstallation(f.filename, {
          env: {
            DEVROUTER_PREVIEW_STATE_TOKEN: "synthetic",
            DEVROUTER_PREVIEW_GITHUB_TOKEN: "synthetic",
          },
          fetch,
          now: () => now,
        });
        await installed.controllers[0].controller.scan(9);
        const inbox = [...rows.entries()].find(([key]) => key.includes("/inbox/"))?.[1];
        expect(JSON.parse(inbox?.value ?? "{}").selection).toBe(
          mismatch ? "review-required" : "no-runtime",
        );
        expect(JSON.parse(inbox?.value ?? "{}").processed).toHaveLength(1);
        expect(posted).toBeDefined();
        expect(await installed.engine.identities()).toEqual([]);
      }
    }
  });
  it("never reinitializes an established or partially initialized pool", async () => {
    const rows = new Map<string, unknown>();
    const store: PreviewStateStore = {
      async read(key, decode) {
        const value = rows.get(key);
        return value ? { value: decode(structuredClone(value)), version: "1" } : null;
      },
      async compareAndSwap(key, expected, value) {
        if (expected !== null || rows.has(key)) throw new PreviewStateConflict();
        rows.set(key, structuredClone(value));
        return "1";
      },
    };
    await initializePreviewInstallation("test", store);
    expect(rows.get("installations/test/pool")).toEqual(createPreviewPool("test"));
    rows.delete("installations/test/pool");
    await expect(initializePreviewInstallation("test", store)).rejects.toThrow(
      "already initialized",
    );
    expect(rows.has("installations/test/pool")).toBe(false);
  });
});
