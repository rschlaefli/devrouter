import type { SetupAction, SetupActionStatus, SetupReport } from "../types";
import { ensureNetwork, isContainerRunning, networkExists } from "./docker";
import { buildDoctorReport } from "./doctor";
import { resolveRepoPath } from "./repo-config";
import {
  DEVNET_NAME,
  ensureRouterFiles,
  getRouterFileLayout,
  ROUTER_CONTAINER_NAME,
  startRouterStack,
} from "./router";
import { installTLS } from "./tls";
import { runTool } from "./tool-diagnostics";

type SetupOptions = {
  repo?: string;
  yes?: boolean;
};

function action(status: SetupActionStatus, entry: Omit<SetupAction, "status">): SetupAction {
  return { status, ...entry };
}

function actionStatusCounts(actions: SetupAction[]): Record<SetupActionStatus, number> {
  return actions.reduce<Record<SetupActionStatus, number>>(
    (acc, entry) => {
      acc[entry.status] += 1;
      return acc;
    },
    { performed: 0, skipped: 0, failed: 0 },
  );
}

function collectNextSteps(
  report: Pick<SetupReport, "actions" | "checks">,
  doctorNextSteps: string[],
): string[] {
  const steps = new Set<string>();

  for (const entry of report.actions) {
    if (entry.status === "failed" || entry.status === "skipped") {
      if (entry.suggestion) {
        steps.add(entry.suggestion);
      }
    }
  }

  for (const check of report.checks) {
    if (check.level !== "ok" && check.suggestion) {
      steps.add(check.suggestion);
    }
  }

  for (const step of doctorNextSteps) {
    steps.add(step);
  }

  return Array.from(steps.values());
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupReport> {
  const repoPath = resolveRepoPath(options.repo);
  const actions: SetupAction[] = [];

  if (!options.yes) {
    actions.push(
      action("failed", {
        id: "setup.confirmation",
        summary: "Setup requires --yes before mutating devrouter-owned machine state.",
        suggestion: "Run: devrouter setup --yes",
      }),
    );

    const doctor = await buildDoctorReport({ repo: options.repo });
    const partialReport = { actions, checks: doctor.checks };

    return {
      generatedAt: new Date().toISOString(),
      repoPath,
      actions,
      checks: doctor.checks,
      summary: {
        actions: actionStatusCounts(actions),
        checks: doctor.summary,
      },
      nextSteps: collectNextSteps(partialReport, doctor.nextSteps),
    };
  }

  try {
    const missingBefore = getRouterFileLayout().missing;
    ensureRouterFiles();
    actions.push(
      action(missingBefore.length === 0 ? "skipped" : "performed", {
        id: "global.router-files",
        summary:
          missingBefore.length === 0
            ? "Global router files were already present."
            : `Created missing global router file(s): ${missingBefore.join(", ")}`,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.push(
      action("failed", {
        id: "global.router-files",
        summary: "Failed to ensure global router files.",
        details: message,
        suggestion: "Check write access to ~/.config/devrouter, then run: devrouter setup --yes",
      }),
    );
  }

  try {
    const existed = await networkExists(DEVNET_NAME);
    await ensureNetwork(DEVNET_NAME);
    actions.push(
      action(existed ? "skipped" : "performed", {
        id: "global.devnet",
        summary: existed
          ? "Shared Docker network devnet already exists."
          : "Created shared Docker network devnet.",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.push(
      action("failed", {
        id: "global.devnet",
        summary: "Failed to ensure shared Docker network devnet.",
        details: message,
        suggestion: "Start Docker and verify Docker context, then run: devrouter setup --yes",
      }),
    );
  }

  try {
    const wasRunning = await isContainerRunning(ROUTER_CONTAINER_NAME);
    startRouterStack();
    actions.push(
      action(wasRunning ? "skipped" : "performed", {
        id: "global.router-stack",
        summary: wasRunning
          ? "Shared Traefik router was already running."
          : "Started shared Traefik router.",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.push(
      action("failed", {
        id: "global.router-stack",
        summary: "Failed to start shared Traefik router.",
        details: message,
        suggestion:
          "Resolve Docker/port conflicts on 80, 443, or 5432, then run: devrouter setup --yes",
      }),
    );
  }

  const mkcert = runTool("mkcert", ["-version"]);
  if (!mkcert.ok) {
    actions.push(
      action("skipped", {
        id: "global.tls",
        summary: "Skipped TLS setup because mkcert is not installed.",
        details: mkcert.error,
        suggestion: "Install mkcert, then run: devrouter setup --yes",
      }),
    );
  } else {
    try {
      const tls = await installTLS();
      actions.push(
        action(tls.alreadyEnabled ? "skipped" : "performed", {
          id: "global.tls",
          summary: tls.alreadyEnabled
            ? "TLS was already enabled; certificates were refreshed."
            : "Installed local TLS certificates and enabled TLS routing.",
          details: `hosts=${tls.hosts.join(", ")}`,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actions.push(
        action("failed", {
          id: "global.tls",
          summary: "Failed to install local TLS certificates.",
          details: message,
          suggestion: "Run: devrouter tls install",
        }),
      );
    }
  }

  const doctor = await buildDoctorReport({ repo: options.repo });
  const partialReport = { actions, checks: doctor.checks };

  return {
    generatedAt: new Date().toISOString(),
    repoPath,
    actions,
    checks: doctor.checks,
    summary: {
      actions: actionStatusCounts(actions),
      checks: doctor.summary,
    },
    nextSteps: collectNextSteps(partialReport, doctor.nextSteps),
  };
}
