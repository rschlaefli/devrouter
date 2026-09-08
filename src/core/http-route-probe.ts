import { spawnSync } from "node:child_process";
import type { DevrouterHttpReadiness } from "../types";
import { CERT_FILE, isTLSEnabled } from "./router";
import { getMkcertRootCAPath } from "./tls";

export type HttpRouteProbeClassification = "application-contract" | "transport";

export type HttpRouteProbeResult = {
  ok: boolean;
  status?: number;
  details: string;
  classification?: HttpRouteProbeClassification;
};

export type HttpRouteProbeOptions = {
  maxTimeSeconds?: number;
  repoPath?: string;
  readiness?: DevrouterHttpReadiness;
};

export type HttpRouteProbeRunner = (
  command: string,
  args: string[],
  signal: AbortSignal,
) => Promise<string>;

const DEFAULT_MAX_TIME_SECONDS = 5;
const CONTROLLER_CURL_MAX_TIME_SECONDS = 2;
const PARENT_TIMEOUT_PADDING_MS = 250;
const CONTRACT_MAX_BUFFER = 1024;
const MIME_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function httpRouteUrl(host: string): string {
  return `${isTLSEnabled() ? "https" : "http"}://${host}`;
}

export function probeHttpRoute(
  host: string,
  options: HttpRouteProbeOptions = {},
): HttpRouteProbeResult {
  const maxTimeSeconds = options.maxTimeSeconds ?? DEFAULT_MAX_TIME_SECONDS;
  if (!Number.isFinite(maxTimeSeconds) || maxTimeSeconds <= 0) {
    throw new Error("maxTimeSeconds must be a positive finite number.");
  }

  if (options.readiness !== undefined) {
    return probeHttpReadinessSync(host, options.readiness, maxTimeSeconds, options.repoPath);
  }

  const tlsEnabled = isTLSEnabled();
  const url = `${tlsEnabled ? "https" : "http"}://${host}`;
  const args = [
    "--silent",
    "--show-error",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--max-time",
    String(maxTimeSeconds),
  ];
  if (tlsEnabled) {
    // Validate mkcert setup for actionable first-time guidance, then pin the
    // probe to the exact certificate Traefik serves for this local route.
    getMkcertRootCAPath({ repoPath: options.repoPath });
    args.push("--cacert", CERT_FILE);
  }
  args.push(url);

  const result = spawnSync("curl", args, { encoding: "utf-8" });
  const stdout = result.stdout?.trim() ?? "";
  const status = /^\d{3}$/.test(stdout) ? Number(stdout) : undefined;
  const ok = result.status === 0 && status !== undefined && status >= 100 && status < 500;
  const details = ok
    ? `HTTP ${status}`
    : [status === undefined ? undefined : `HTTP ${status}`, result.stderr?.trim()]
        .filter(Boolean)
        .join(": ") || `curl exited with status ${result.status ?? "unknown"}`;

  return { ok, status, details };
}

export async function probeHttpReadiness(
  host: string,
  readiness: DevrouterHttpReadiness,
  signal: AbortSignal,
  runner: HttpRouteProbeRunner,
  tlsEnabled = isTLSEnabled(),
): Promise<HttpRouteProbeResult> {
  const args = buildHttpReadinessCurlArgs(
    host,
    readiness,
    CONTROLLER_CURL_MAX_TIME_SECONDS,
    tlsEnabled,
  );

  try {
    const metadata = await runner("curl", args, signal);
    if (signal.aborted) throw new Error("HTTP route probe cancelled.");
    return parseHttpReadinessMetadata(metadata, readiness);
  } catch (error) {
    if (signal.aborted) throw error;
    return transportFailure();
  }
}

function probeHttpReadinessSync(
  host: string,
  readiness: DevrouterHttpReadiness,
  maxTimeSeconds: number,
  repoPath: string | undefined,
): HttpRouteProbeResult {
  const parentTimeoutMs = maxTimeSeconds * 1000 + PARENT_TIMEOUT_PADDING_MS;
  if (!Number.isFinite(parentTimeoutMs)) {
    throw new Error("maxTimeSeconds is too large for a bounded probe timeout.");
  }

  const tlsEnabled = isTLSEnabled();
  const args = buildHttpReadinessCurlArgs(host, readiness, maxTimeSeconds, tlsEnabled);
  if (tlsEnabled) {
    getMkcertRootCAPath({ repoPath });
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: CONTRACT_MAX_BUFFER,
      timeout: Math.ceil(parentTimeoutMs),
    });
  } catch {
    return transportFailure();
  }

  if (result.status !== 0 || result.error) {
    return transportFailure();
  }

  const metadata = typeof result.stdout === "string" ? result.stdout : "";
  return parseHttpReadinessMetadata(metadata, readiness);
}

function buildHttpReadinessCurlArgs(
  host: string,
  readiness: DevrouterHttpReadiness,
  maxTimeSeconds: number,
  tlsEnabled: boolean,
): string[] {
  const url = `${tlsEnabled ? "https" : "http"}://${host}${readiness.path}`;
  const args = [
    "--disable",
    "--globoff",
    "--silent",
    "--show-error",
    "--no-location",
    "--noproxy",
    "*",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}\t%{content_type}",
    "--max-time",
    String(maxTimeSeconds),
  ];
  if (tlsEnabled) args.push("--cacert", CERT_FILE);
  args.push(url);
  return args;
}

function parseHttpReadinessMetadata(
  metadata: string,
  readiness: DevrouterHttpReadiness,
): HttpRouteProbeResult {
  if (metadata.length > CONTRACT_MAX_BUFFER) {
    return transportFailure();
  }

  const match = /^(\d{3})\t([^\r\n]*)$/.exec(metadata);
  if (!match) {
    return transportFailure();
  }

  const status = Number(match[1]);
  if (status < 100 || status > 599) {
    return transportFailure();
  }

  const statuses = readiness.statuses ?? [200];
  const statusAllowed = statuses.includes(status);
  const mediaFailure = readiness.contentType
    ? contentTypeFailure(match[2], readiness.contentType)
    : undefined;
  if (statusAllowed && mediaFailure === undefined) {
    return { ok: true, status, details: `HTTP ${status}` };
  }

  const reasons = [
    ...(statusAllowed ? [] : ["status not allowed"]),
    ...(mediaFailure ? [mediaFailure] : []),
  ];
  return {
    ok: false,
    status,
    details: `HTTP ${status}; ${reasons.join("; ")}`,
    classification: "application-contract",
  };
}

function contentTypeFailure(
  responseContentType: string,
  expectedContentType: string,
): string | undefined {
  const normalized = responseContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return "content type missing";
  }

  const separator = normalized.indexOf("/");
  if (
    separator <= 0 ||
    separator === normalized.length - 1 ||
    normalized.indexOf("/", separator + 1) !== -1 ||
    !MIME_TOKEN_RE.test(normalized.slice(0, separator)) ||
    !MIME_TOKEN_RE.test(normalized.slice(separator + 1))
  ) {
    return "content type invalid";
  }

  return normalized === expectedContentType.toLowerCase() ? undefined : "content type mismatch";
}

function transportFailure(): HttpRouteProbeResult {
  return {
    ok: false,
    details: "HTTP route probe transport failure",
    classification: "transport",
  };
}
