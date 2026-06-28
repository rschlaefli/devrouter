import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return path.resolve(__dirname, "../../../");
}

describe("routing example configuration alignment", () => {
  it("uses postgres defaults expected by injected dependency urls", () => {
    const composePath = path.join(repoRoot(), "examples", "routing", "docker-compose.yml");
    const raw = fs.readFileSync(composePath, "utf-8");
    const parsed = YAML.parse(raw) as {
      services?: {
        db?: {
          environment?: Record<string, string>;
          healthcheck?: {
            test?: string[];
          };
        };
        app?: {
          environment?: Record<string, string>;
        };
      };
    };

    const dbEnv = parsed.services?.db?.environment ?? {};
    expect(dbEnv.POSTGRES_USER).toBe("prisma");
    expect(dbEnv.POSTGRES_PASSWORD).toBe("prisma");
    expect(dbEnv.POSTGRES_DB).toBe("prisma");

    const healthcheckTest = parsed.services?.db?.healthcheck?.test ?? [];
    expect(healthcheckTest.join(" ")).toContain("pg_isready -U prisma -d prisma");

    const appEnv = parsed.services?.app?.environment ?? {};
    expect(appEnv.DATABASE_URL).toBe("postgres://prisma:prisma@db:5432/prisma");
  });

  it("does not hardcode DATABASE_URL in routing host command", () => {
    const configPath = path.join(repoRoot(), "examples", "routing", ".devrouter.yml");
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as {
      apps?: Array<{
        name?: string;
        hostRun?: {
          command?: string;
        };
      }>;
    };

    const hostApp = (parsed.apps ?? []).find((app) => app.name === "web-host");
    const command = hostApp?.hostRun?.command ?? "";
    expect(command).toBe("APP_INSTANCE=host node app/server.js");
    expect(command).not.toContain("DATABASE_URL=");
  });
});
