export type PreviewResourceKind = "service" | "job" | "postgres" | "redis" | "volume";

type PreviewBuild = {
  context: string;
  dockerfile: string;
  target?: string;
};

type PreviewPort = {
  name: string;
  port: number;
  public: boolean;
};

type PreviewResource = {
  kind: PreviewResourceKind;
  dependsOn?: string[];
  image?: string;
  build?: PreviewBuild;
  ports?: PreviewPort[];
  command?: string[];
};

type PreviewAlias =
  | {
      profiles: string[];
    }
  | {
      resources: string[];
    };

type PreviewSelectionRule = {
  paths: string[];
  aliases: string[];
};

export type PreviewManifest = {
  version: 1;
  aliases: Record<string, PreviewAlias>;
  bindings: {
    apps: Record<string, string[]>;
    dependencies: Record<string, string[]>;
    services: Record<string, string[]>;
    processes: Record<string, string[]>;
  };
  resources: Record<string, PreviewResource>;
  selection: {
    rules: PreviewSelectionRule[];
    ignorePaths: string[];
    controlPaths: string[];
    fallback?: string;
    dominating?: string;
    allowedUnions: string[][];
  };
};

export type PreviewSource = {
  head: string;
  target: string;
  mergeBase: string;
  complete: boolean;
  changes: Array<{
    status: "A" | "M" | "D" | "R" | "C" | "T";
    path: string;
    oldPath?: string;
  }>;
};

export type PreviewPlanReport = {
  schemaVersion: 1;
  status: "planned" | "no-runtime" | "selection-required" | "review-required" | "unknown";
  aliases: string[];
  profiles?: string[];
  resources: Array<PreviewResource & { id: string }>;
  reasons: string[];
  manifestDigest: string;
  localConfigDigest: string;
  source?: PreviewSource;
  omissions: string[];
};
