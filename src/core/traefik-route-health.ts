import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import type { HostRouteInput } from "./host-routes";
import { buildHostRouteRouterName } from "./host-routes";
import { DEVROUTER_HOME, restartRouterStack } from "./router";

const ROUTER_API_BASE = "http://127.0.0.1:8080/api";
const ROUTER_RELOAD_LOCK_FILE = path.join(DEVROUTER_HOME, "router-reload.lock");
const DEFAULT_INITIAL_TIMEOUT_MS = 3_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const ROUTER_API_PAGE_SIZE = 1_000;

type RouteProtocol = "http" | "tcp";

type RouterApiResult =
  | { ok: true; names: Set<string>; reachedPageLimit: boolean }
  | { ok: false; details: string };

type RouteLoadResult = { ok: true } | { ok: false; missing: string[]; details: string };

export type TraefikRouteLoadOptions = {
  initialTimeoutMs?: number;
  recoveryTimeoutMs?: number;
  pollIntervalMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inspectRouterApi(protocol: RouteProtocol): RouterApiResult {
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "2",
      `${ROUTER_API_BASE}/${protocol}/routers?per_page=${ROUTER_API_PAGE_SIZE}`,
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      details: result.stderr?.trim() || `curl exited with status ${result.status ?? "unknown"}`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return { ok: false, details: `${protocol.toUpperCase()} router API returned invalid JSON` };
  }
  if (!Array.isArray(value)) {
    return { ok: false, details: `${protocol.toUpperCase()} router API returned a non-array` };
  }

  return {
    ok: true,
    reachedPageLimit: value.length >= ROUTER_API_PAGE_SIZE,
    names: new Set(
      value.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const name = (item as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      }),
    ),
  };
}

function inspectExpectedRoutes(routes: HostRouteInput[]): RouteLoadResult {
  const missing: string[] = [];
  const failures: string[] = [];

  for (const protocol of ["http", "tcp"] as const) {
    const expected = routes
      .filter((route) => (route.protocol ?? "http") === protocol)
      .map((route) => buildHostRouteRouterName(route.repoPath, route.name));
    if (expected.length === 0) continue;

    const result = inspectRouterApi(protocol);
    if (!result.ok) {
      failures.push(result.details);
      missing.push(...expected);
      continue;
    }
    const absent = expected.filter((name) => !result.names.has(name));
    if (absent.length > 0 && result.reachedPageLimit) {
      failures.push(
        `${protocol.toUpperCase()} router API reached the ${ROUTER_API_PAGE_SIZE}-entry safety limit`,
      );
    }
    missing.push(...absent);
  }

  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        missing,
        details: failures.length > 0 ? failures.join("; ") : "router names are absent",
      };
}

async function waitForExpectedRoutes(
  routes: HostRouteInput[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<RouteLoadResult> {
  const deadline = Date.now() + timeoutMs;
  let result: RouteLoadResult;
  do {
    result = inspectExpectedRoutes(routes);
    if (result.ok) return result;
    if (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  return result;
}

/**
 * Prove that Traefik loaded the just-published file-provider routers. A normal
 * application may legitimately return HTTP 404, so route readiness alone
 * cannot distinguish it from Traefik's unmatched-route response. If the
 * dashboard API still lacks an expected router after a short grace period,
 * restart only the Devrouter-owned Traefik service once and prove it again.
 */
export async function ensureTraefikRoutesLoaded(
  routes: HostRouteInput[],
  options: TraefikRouteLoadOptions = {},
): Promise<{ restarted: boolean }> {
  if (routes.length === 0) return { restarted: false };

  const initialTimeoutMs = options.initialTimeoutMs ?? DEFAULT_INITIAL_TIMEOUT_MS;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initial = await waitForExpectedRoutes(routes, initialTimeoutMs, pollIntervalMs);
  if (initial.ok) return { restarted: false };

  fs.mkdirSync(DEVROUTER_HOME, { recursive: true });
  return withFileLock(
    ROUTER_RELOAD_LOCK_FILE,
    {
      activity: "Traefik route reload recovery",
      waitMs: initialTimeoutMs + recoveryTimeoutMs + 10_000,
      fair: true,
      onWait: createStderrWaitReporter("Traefik route reload recovery", "shared router"),
    },
    async () => {
      const recheck = await waitForExpectedRoutes(routes, 0, pollIntervalMs);
      if (recheck.ok) return { restarted: false };

      restartRouterStack();
      const recovered = await waitForExpectedRoutes(routes, recoveryTimeoutMs, pollIntervalMs);
      if (recovered.ok) return { restarted: true };

      throw new Error(
        `Traefik did not load file-provider routes after one restart: ${recovered.missing.join(", ")} (${recovered.details}). Inspect: devrouter logs --tail 100`,
      );
    },
  );
}
