import { describe, expect, it } from "vitest";
import type { DevrouterConfig } from "../../../types";
import { parsePreviewManifest } from "../manifest";
import { buildPreviewPlan, listPreviewAliases } from "../plan";
import type { PreviewManifest, PreviewSource } from "../types";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);

function config(): DevrouterConfig {
  return {
    version: 1,
    managedRuntime: {
      devcontainer: {
        baseServices: ["postgres"],
        profileServices: ["redis", "mailhog"],
      },
      processes: ["worker", "cleanup"],
    },
    profiles: {
      chat: {
        apps: ["api"],
        dependencies: ["db"],
        devcontainerServices: ["redis"],
        processes: ["worker", "cleanup"],
        default: true,
      },
    },
    apps: [
      {
        name: "api",
        host: "api.example.localhost",
        protocol: "http",
        runtime: "proxy",
        upstream: "api:3000",
        dependencies: [{ app: "db" }],
      },
      {
        kind: "dependency",
        name: "db",
        runtime: "docker",
        dependencies: [],
        docker: { service: "db", composeFiles: ["compose.yml"] },
      },
    ],
  };
}

function manifestSource(): string {
  return `
version: 1
aliases:
  chat:
    profiles: [chat]
  ai:
    resources: [worker]
  data:
    resources: [db]
  full:
    profiles: [chat]
bindings:
  apps:
    api: [api]
  dependencies:
    db: [db]
  services:
    postgres: []
    redis: [cache]
  processes:
    worker: [worker]
    cleanup: []
resources:
  api:
    kind: service
    dependsOn: [db, cache]
    image: ghcr.io/example/api:1
  worker:
    kind: job
    dependsOn: [api]
    image: ghcr.io/example/worker:1
    command: ["node", "worker.js"]
  db:
    kind: postgres
    dependsOn: [assets]
  cache:
    kind: redis
  assets:
    kind: volume
selection:
  rules: []
  ignorePaths: []
  controlPaths: []
  allowedUnions: []
`;
}

function manifest(): PreviewManifest {
  return parsePreviewManifest(manifestSource());
}

function source(
  changes: PreviewSource["changes"],
  options: { complete?: boolean } = {},
): PreviewSource {
  return {
    head: HEAD,
    target: TARGET,
    mergeBase: MERGE_BASE,
    complete: options.complete ?? true,
    changes,
  };
}

function plan(
  previewManifest: PreviewManifest,
  options: {
    aliases?: string[];
    source?: PreviewSource;
    localConfig?: DevrouterConfig;
  } = {},
) {
  return buildPreviewPlan({
    repoPath: "/repo",
    config: options.localConfig ?? config(),
    manifest: previewManifest,
    manifestDigest: "manifest-digest",
    localConfigDigest: "local-config-digest",
    ...(options.aliases ? { aliases: options.aliases } : {}),
    ...(options.source ? { source: options.source } : {}),
  });
}

describe("preview plan", () => {
  it("returns sorted alias names and delegates profile closure exactly once", () => {
    const previewManifest = manifest();

    expect(listPreviewAliases(previewManifest)).toEqual(["ai", "chat", "data", "full"]);

    const report = plan(previewManifest, { aliases: ["chat"] });
    expect(report.status).toBe("planned");
    expect(report.aliases).toEqual(["chat"]);
    expect(report.profiles).toEqual(["chat"]);
    expect(report.resources.map((resource) => resource.id)).toEqual([
      "cache",
      "assets",
      "db",
      "api",
      "worker",
    ]);
    expect(report.omissions).toEqual(["bindings.processes.cleanup", "bindings.services.postgres"]);
  });

  it("maps existing dotted and underscored profile members through the local resolver", () => {
    const local = config();
    local.managedRuntime!.devcontainer.profileServices = ["my_db", "mailhog"];
    local.managedRuntime!.processes = ["worker.queue", "cleanup"];
    local.profiles!.chat.devcontainerServices = ["my_db"];
    local.profiles!.chat.processes = ["worker.queue", "cleanup"];
    const preview = parsePreviewManifest(
      manifestSource()
        .replace("    redis: [cache]", "    my_db: [cache]")
        .replace("    worker: [worker]", "    worker.queue: [worker]"),
    );
    const result = plan(preview, { aliases: ["chat"], localConfig: local });
    expect(result.status).toBe("planned");
    expect(result.resources.map(({ id }) => id)).toContain("worker");
  });

  it("fails when a selected profile member has no explicit binding", () => {
    const previewManifest = manifest();
    delete previewManifest.bindings.processes.worker;

    expect(() => plan(previewManifest, { aliases: ["chat"] })).toThrow();
  });

  it("plans a cloud-only resource alias without a profile", () => {
    const report = plan(manifest(), {
      aliases: ["data"],
      localConfig: { version: 1, apps: [] },
    });

    expect(report.status).toBe("planned");
    expect(report.profiles).toBeUndefined();
    expect(report.resources.map((resource) => resource.id)).toEqual(["assets", "db"]);
  });

  it("treats ignored-only changes as having no runtime", () => {
    const previewManifest = manifest();
    previewManifest.selection.ignorePaths = ["docs/**"];

    const report = plan(previewManifest, {
      source: source([{ status: "M", path: "docs/guide.md" }]),
    });

    expect(report.status).toBe("no-runtime");
    expect(report.aliases).toEqual([]);
  });

  it("collects both rename ends and deleted paths into an allowed union", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [
      { paths: ["src/api/**"], aliases: ["chat"] },
      { paths: ["src/data/**"], aliases: ["data"] },
    ];
    previewManifest.selection.allowedUnions = [["data", "chat"]];

    const report = plan(previewManifest, {
      source: source([
        { status: "R", path: "src/api/new.ts", oldPath: "src/data/old.ts" },
        { status: "D", path: "src/api/deleted.ts" },
      ]),
    });

    expect(report.status).toBe("planned");
    expect(report.aliases).toEqual(["chat", "data"]);
  });

  it("uses a dominating alias only when it is part of the matched union", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [
      { paths: ["src/api/**"], aliases: ["chat"] },
      { paths: ["src/data/**"], aliases: ["data"] },
      { paths: ["src/full/**"], aliases: ["full"] },
    ];
    previewManifest.selection.allowedUnions = [["chat", "data", "full"]];
    previewManifest.selection.dominating = "full";

    const dominated = plan(previewManifest, {
      source: source([
        { status: "M", path: "src/api/index.ts" },
        { status: "M", path: "src/data/schema.sql" },
        { status: "M", path: "src/full/entry.ts" },
      ]),
    });
    expect(dominated.aliases).toEqual(["full"]);
  });

  it("keeps an allowed union when the configured dominating alias does not match", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [
      { paths: ["src/api/**"], aliases: ["chat"] },
      { paths: ["src/ai/**"], aliases: ["ai"] },
    ];
    previewManifest.selection.allowedUnions = [["ai", "chat"]];
    previewManifest.selection.dominating = "full";

    const report = plan(previewManifest, {
      source: source([
        { status: "M", path: "src/api/index.ts" },
        { status: "M", path: "src/ai/task.ts" },
      ]),
    });

    expect(report.status).toBe("planned");
    expect(report.aliases).toEqual(["ai", "chat"]);
  });

  it("unions a fallback with matched aliases", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [{ paths: ["src/api/**"], aliases: ["chat"] }];
    previewManifest.selection.allowedUnions = [["chat", "data"]];
    previewManifest.selection.dominating = "full";

    previewManifest.selection.fallback = "data";
    const fallback = plan(previewManifest, {
      source: source([
        { status: "M", path: "src/api/index.ts" },
        { status: "M", path: "other/file.ts" },
      ]),
    });
    expect(fallback.status).toBe("planned");
    expect(fallback.aliases).toEqual(["chat", "data"]);

    delete previewManifest.selection.fallback;
    const required = plan(previewManifest, {
      source: source([{ status: "M", path: "other/file.ts" }]),
    });
    expect(required.status).toBe("selection-required");
  });

  it("uses fallback only for unmatched paths", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [{ paths: ["src/api/**"], aliases: ["chat"] }];
    previewManifest.selection.fallback = "full";

    const report = plan(previewManifest, {
      source: source([{ status: "M", path: "src/api/index.ts" }]),
    });

    expect(report.status).toBe("planned");
    expect(report.aliases).toEqual(["chat"]);
  });

  it("rejects an unreviewed automatic alias union", () => {
    const previewManifest = manifest();
    previewManifest.selection.rules = [
      { paths: ["src/api/**"], aliases: ["chat"] },
      { paths: ["src/data/**"], aliases: ["data"] },
    ];

    expect(() =>
      plan(previewManifest, {
        source: source([
          { status: "M", path: "src/api/index.ts" },
          { status: "M", path: "src/data/schema.sql" },
        ]),
      }),
    ).toThrow();
  });

  it("blocks manual aliases on deployed control-file changes", () => {
    const github = plan(manifest(), {
      aliases: ["chat"],
      source: source([{ status: "M", path: ".github/workflows/ci.yml" }]),
    });
    const gitlab = plan(manifest(), {
      aliases: ["chat"],
      source: source([{ status: "M", path: ".gitlab-ci.yml" }]),
    });

    expect(github.status).toBe("review-required");
    expect(gitlab.status).toBe("review-required");
    expect(github.resources).toEqual([]);
    expect(gitlab.resources).toEqual([]);
  });

  it("returns unknown for truncated source in automatic and manual modes", () => {
    const truncated = source([{ status: "M", path: "src/api/index.ts" }], { complete: false });

    expect(plan(manifest(), { source: truncated }).status).toBe("unknown");
    expect(plan(manifest(), { aliases: ["chat"], source: truncated }).status).toBe("unknown");
  });

  it("rejects invalid source identity", () => {
    expect(() =>
      plan(manifest(), {
        aliases: ["chat"],
        source: {
          ...source([{ status: "M", path: "src/api/index.ts" }]),
          head: "not-a-sha",
        },
      }),
    ).toThrow();
  });
});
