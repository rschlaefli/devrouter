import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostRouteState } from "../types";
import { createStderrWaitReporter, withFileLock } from "./file-lock";
import type { HostRouteInput } from "./host-routes";
import { buildHostRouteId, buildHostRouteRouterName, buildHostRoutesDocument } from "./host-routes";
import { DEVROUTER_HOME, restartRouterStack } from "./router";

const ROUTER_API_BASE = "http://127.0.0.1:8080/api";
const ROUTER_RELOAD_LOCK_FILE = path.join(DEVROUTER_HOME, "router-reload.lock");
const ROUTER_API_REQUEST_TIMEOUT_SECONDS = "2";
const DEFAULT_INITIAL_TIMEOUT_MS = 3_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const ROUTER_API_PAGE_SIZE = 1_000;

type RouteProtocol = "http" | "tcp";
type RouteExpectation = "loaded" | "removed";
type TraefikRouteReference = Pick<HostRouteInput, "name" | "protocol" | "repoPath">;

type RouterApiResult =
  | { ok: true; names: Set<string>; reachedPageLimit: boolean }
  | { ok: false; details: string };
type NamedRouterApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; details: string };

type RouteHealthResult = { ok: true } | { ok: false; routes: string[]; details: string };

type ExpectedRouteMatch = {
  protocol: RouteProtocol;
  routerName: string;
  serviceKey: string;
  serviceName: string;
  rule: string;
  serverField: "url" | "address";
  server: string;
};

export type TraefikRouteLoadOptions = {
  initialTimeoutMs?: number;
  recoveryTimeoutMs?: number;
  pollIntervalMs?: number;
  allowRestart?: boolean;
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
      ROUTER_API_REQUEST_TIMEOUT_SECONDS,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectNamedRouterApi(
  protocol: RouteProtocol,
  resource: "routers" | "services",
  name: string,
): NamedRouterApiResult {
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      ROUTER_API_REQUEST_TIMEOUT_SECONDS,
      `${ROUTER_API_BASE}/${protocol}/${resource}/${encodeURIComponent(name)}`,
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
    return {
      ok: false,
      details: `${protocol.toUpperCase()} ${resource.slice(0, -1)} API returned invalid JSON`,
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      details: `${protocol.toUpperCase()} ${resource.slice(0, -1)} API returned a non-object`,
    };
  }

  return { ok: true, value };
}

function renderExpectedRoute(route: HostRouteInput): ExpectedRouteMatch | undefined {
  const protocol = route.protocol ?? "http";
  const routerName = buildHostRouteRouterName(route.repoPath, route.name);
  const routeState: HostRouteState = {
    id: buildHostRouteId(route.repoPath, route.name),
    name: route.name,
    host: route.host,
    protocol,
    tcpProtocol: route.tcpProtocol,
    repoPath: route.repoPath,
    port: route.port,
    mode: route.mode,
    upstreamHost: route.upstreamHost,
    pid: route.pid,
    command: route.command,
    workspace: route.workspace,
    createdAt: "",
    updatedAt: "",
  };
  const document = buildHostRoutesDocument([routeState], false);
  const protocolDocument = document[protocol];
  if (!isRecord(protocolDocument)) return undefined;
  const routers = protocolDocument.routers;
  const services = protocolDocument.services;
  if (!isRecord(routers) || !isRecord(services)) return undefined;

  const routerKey = routerName.slice(0, routerName.lastIndexOf("@"));
  const router = routers[routerKey];
  const service = services[routerKey];
  if (!isRecord(router) || !isRecord(service)) return undefined;

  const rule = router.rule;
  const serviceReference = router.service;
  const loadBalancer = service.loadBalancer;
  const servers = isRecord(loadBalancer) ? loadBalancer.servers : undefined;
  if (
    typeof rule !== "string" ||
    serviceReference !== routerKey ||
    !isRecord(loadBalancer) ||
    !Array.isArray(servers) ||
    servers.length !== 1 ||
    !isRecord(servers[0])
  ) {
    return undefined;
  }

  const serverField = protocol === "http" ? "url" : "address";
  const server = servers[0][serverField];
  if (typeof server !== "string") return undefined;

  const provider = routerName.slice(routerName.lastIndexOf("@")).trim();
  if (!provider.startsWith("@")) return undefined;

  return {
    protocol,
    routerName,
    serviceKey: routerKey,
    serviceName: `${routerKey}${provider}`,
    rule,
    serverField,
    server,
  };
}

function inspectExpectedRouteMatch(route: HostRouteInput): RouteHealthResult {
  const expected = renderExpectedRoute(route);
  const routeName = buildHostRouteRouterName(route.repoPath, route.name);
  if (!expected) {
    return {
      ok: false,
      routes: [routeName],
      details: "host-route renderer returned an incomplete route configuration",
    };
  }

  const routerResult = inspectNamedRouterApi(expected.protocol, "routers", expected.routerName);
  if (!routerResult.ok) {
    return { ok: false, routes: [routeName], details: routerResult.details };
  }
  if (
    routerResult.value.status !== "enabled" ||
    routerResult.value.name !== expected.routerName ||
    routerResult.value.rule !== expected.rule ||
    (routerResult.value.service !== expected.serviceKey &&
      routerResult.value.service !== expected.serviceName)
  ) {
    return {
      ok: false,
      routes: [routeName],
      details: "active Traefik router does not match the rendered route",
    };
  }

  const serviceResult = inspectNamedRouterApi(expected.protocol, "services", expected.serviceName);
  if (!serviceResult.ok) {
    return { ok: false, routes: [routeName], details: serviceResult.details };
  }
  const loadBalancer = serviceResult.value.loadBalancer;
  const servers = isRecord(loadBalancer) ? loadBalancer.servers : undefined;
  const server = Array.isArray(servers) && servers.length === 1 ? servers[0] : undefined;
  if (
    serviceResult.value.status !== "enabled" ||
    serviceResult.value.name !== expected.serviceName ||
    !isRecord(loadBalancer) ||
    !Array.isArray(servers) ||
    servers.length !== 1 ||
    !isRecord(server) ||
    server[expected.serverField] !== expected.server
  ) {
    return {
      ok: false,
      routes: [routeName],
      details: "active Traefik service does not match the rendered route",
    };
  }

  return { ok: true };
}

function inspectExpectedRouteMatches(routes: HostRouteInput[]): RouteHealthResult {
  const mismatched: string[] = [];
  const failures: string[] = [];
  for (const route of routes) {
    const result = inspectExpectedRouteMatch(route);
    if (!result.ok) {
      mismatched.push(...result.routes);
      failures.push(result.details);
    }
  }
  return mismatched.length === 0
    ? { ok: true }
    : {
        ok: false,
        routes: mismatched,
        details: failures.join("; "),
      };
}

async function waitForExpectedRouteMatches(
  routes: HostRouteInput[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<RouteHealthResult> {
  const deadline = Date.now() + timeoutMs;
  let result: RouteHealthResult;
  do {
    result = inspectExpectedRouteMatches(routes);
    if (result.ok) return result;
    if (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  return result;
}

function inspectExpectedRoutes(
  routes: TraefikRouteReference[],
  expectation: RouteExpectation,
): RouteHealthResult {
  const mismatched: string[] = [];
  const failures: string[] = [];

  for (const protocol of ["http", "tcp"] as const) {
    const expected = routes
      .filter((route) => (route.protocol ?? "http") === protocol)
      .map((route) => buildHostRouteRouterName(route.repoPath, route.name));
    if (expected.length === 0) continue;

    const result = inspectRouterApi(protocol);
    if (!result.ok) {
      failures.push(result.details);
      mismatched.push(...expected);
      continue;
    }
    const unexpected = expected.filter((name) =>
      expectation === "loaded" ? !result.names.has(name) : result.names.has(name),
    );
    const boundedAbsenceIsUncertain =
      result.reachedPageLimit &&
      (expectation === "loaded" ? unexpected.length > 0 : unexpected.length === 0);
    if (boundedAbsenceIsUncertain) {
      failures.push(
        `${protocol.toUpperCase()} router API reached the ${ROUTER_API_PAGE_SIZE}-entry safety limit`,
      );
    }
    mismatched.push(...unexpected);
    if (expectation === "removed" && unexpected.length === 0 && result.reachedPageLimit) {
      mismatched.push(...expected);
    }
  }

  return mismatched.length === 0
    ? { ok: true }
    : {
        ok: false,
        routes: mismatched,
        details:
          failures.length > 0
            ? failures.join("; ")
            : expectation === "loaded"
              ? "router names are absent"
              : "router names are still present",
      };
}

async function waitForExpectedRoutes(
  routes: TraefikRouteReference[],
  expectation: RouteExpectation,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<RouteHealthResult> {
  const deadline = Date.now() + timeoutMs;
  let result: RouteHealthResult;
  do {
    result = inspectExpectedRoutes(routes, expectation);
    if (result.ok) return result;
    if (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  return result;
}

async function ensureTraefikRouteExpectation(
  routes: TraefikRouteReference[],
  expectation: RouteExpectation,
  options: TraefikRouteLoadOptions,
): Promise<{ restarted: boolean }> {
  if (routes.length === 0) return { restarted: false };

  const initialTimeoutMs = options.initialTimeoutMs ?? DEFAULT_INITIAL_TIMEOUT_MS;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initial = await waitForExpectedRoutes(
    routes,
    expectation,
    initialTimeoutMs,
    pollIntervalMs,
  );
  if (initial.ok) return { restarted: false };
  if (options.allowRestart === false)
    throw new Error(
      "Traefik routes did not reload; shared router restart is disabled for this operation.",
    );

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
      const recheck = await waitForExpectedRoutes(routes, expectation, 0, pollIntervalMs);
      if (recheck.ok) return { restarted: false };

      restartRouterStack();
      const recovered = await waitForExpectedRoutes(
        routes,
        expectation,
        recoveryTimeoutMs,
        pollIntervalMs,
      );
      if (recovered.ok) return { restarted: true };

      const action = expectation === "loaded" ? "load" : "remove";
      throw new Error(
        `Traefik did not ${action} file-provider routes after one restart: ${recovered.routes.join(", ")} (${recovered.details}). Inspect: devrouter logs --tail 100`,
      );
    },
  );
}

/**
 * Prove that Traefik loaded the just-published file-provider routers. A normal
 * application may legitimately return HTTP 404, so route readiness alone
 * cannot distinguish it from Traefik's unmatched-route response. If the
 * dashboard API still lacks an expected router after a short grace period,
 * restart only the Devrouter-owned Traefik service once and prove it again.
 */
export async function ensureTraefikRoutesLoaded(
  routes: TraefikRouteReference[],
  options: TraefikRouteLoadOptions = {},
): Promise<{ restarted: boolean }> {
  return ensureTraefikRouteExpectation(routes, "loaded", options);
}

/**
 * Prove that active Traefik routers and services still match the just-rendered
 * host routes. This is deliberately read-only: mismatches fail closed after a
 * bounded poll and never trigger shared router recovery.
 */
export async function ensureTraefikRoutesMatch(
  routes: HostRouteInput[],
  options: TraefikRouteLoadOptions = {},
): Promise<void> {
  if (routes.length === 0) return;

  const timeoutMs =
    options.initialTimeoutMs ?? options.recoveryTimeoutMs ?? DEFAULT_INITIAL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const result = await waitForExpectedRouteMatches(routes, timeoutMs, pollIntervalMs);
  if (!result.ok) {
    throw new Error(
      `Traefik route configuration did not match rendered routes: ${result.routes.join(", ")} (${result.details})`,
    );
  }
}

/**
 * Prove that Traefik unloaded file-provider routers removed from the canonical
 * route generation. Absence is accepted only from a complete bounded API
 * result. A stale router gets the same serialized restart-once recovery used
 * for route publication.
 */
export async function ensureTraefikRoutesRemoved(
  routes: TraefikRouteReference[],
  options: TraefikRouteLoadOptions = {},
): Promise<{ restarted: boolean }> {
  return ensureTraefikRouteExpectation(routes, "removed", options);
}
