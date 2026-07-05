import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  CERT_FILE,
  CERT_KEY_FILE,
  ensureRouterFiles,
  isTLSEnabled,
  setTLSEnabled,
  startRouterStack
} from "./router";
import { isContainerRunning, findContainerByName } from "./docker";
import { refreshHostRoutesDynamicFile } from "./host-routes";

export const DEFAULT_TLS_CERT_HOSTS = ["localhost", "*.localhost"] as const;

function runOrThrow(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: "utf-8"
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${details || "unknown error"}`);
  }
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf-8" });
  return result.status === 0;
}

function ensureMkcert(): void {
  if (!commandExists("mkcert")) {
    throw new Error(
      "mkcert is not installed. Please install it to use TLS features (e.g., 'brew install mkcert' or via your package manager)."
    );
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizeUniqueHosts(hosts: string[]): string[] {
  const set = new Set<string>();
  for (const host of hosts) {
    const normalized = normalizeHost(host);
    if (normalized.length === 0) {
      continue;
    }
    set.add(normalized);
  }

  return Array.from(set.values()).sort();
}

export function parseDnsHostsFromSubjectAltName(subjectAltName: string): string[] {
  const names: string[] = [];
  const matches = subjectAltName.matchAll(/DNS:([^,\n]+)/g);
  for (const match of matches) {
    const host = normalizeHost(match[1] ?? "");
    if (host.length > 0) {
      names.push(host);
    }
  }
  return normalizeUniqueHosts(names);
}

export function parseCertificateDnsHosts(pem: string): string[] {
  const certificate = new X509Certificate(pem);
  const subjectAltName = certificate.subjectAltName ?? "";
  if (subjectAltName.length === 0) {
    return [];
  }
  return parseDnsHostsFromSubjectAltName(subjectAltName);
}

export function isHostCoveredByCertificateHost(host: string, certificateHost: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedCertificateHost = normalizeHost(certificateHost);

  if (normalizedCertificateHost.startsWith("*.")) {
    const suffix = normalizedCertificateHost.slice(1);
    if (!normalizedHost.endsWith(suffix)) {
      return false;
    }

    const wildcardPart = normalizedHost.slice(0, normalizedHost.length - suffix.length);
    return wildcardPart.length > 0 && !wildcardPart.includes(".");
  }

  return normalizedHost === normalizedCertificateHost;
}

export function findUncoveredCertificateHosts(
  requiredHosts: string[],
  certificateHosts: string[]
): string[] {
  const normalizedRequired = normalizeUniqueHosts(requiredHosts);
  const normalizedCertificateHosts = normalizeUniqueHosts(certificateHosts);

  return normalizedRequired.filter(
    (requiredHost) =>
      !normalizedCertificateHosts.some((certificateHost) =>
        isHostCoveredByCertificateHost(requiredHost, certificateHost)
      )
  );
}

function readCurrentCertificateHosts(): string[] {
  if (!fs.existsSync(CERT_FILE)) {
    return [];
  }

  const pem = fs.readFileSync(CERT_FILE, "utf-8");
  return parseCertificateDnsHosts(pem);
}

function currentCertificateHostsOrEmpty(): string[] {
  try {
    return readCurrentCertificateHosts();
  } catch {
    return [];
  }
}

export function buildDesiredTLSCertificateHosts(
  requestedHosts: string[],
  existingCertificateHosts: string[]
): string[] {
  return normalizeUniqueHosts([
    ...DEFAULT_TLS_CERT_HOSTS,
    ...existingCertificateHosts,
    ...requestedHosts
  ]);
}

export function getTLSHostCoverage(hosts: string[]): {
  requiredHosts: string[];
  certificateHosts: string[];
  uncoveredHosts: string[];
} {
  const requiredHosts = normalizeUniqueHosts([...DEFAULT_TLS_CERT_HOSTS, ...hosts]);
  const certificateHosts = readCurrentCertificateHosts();
  const uncoveredHosts = findUncoveredCertificateHosts(requiredHosts, certificateHosts);

  return {
    requiredHosts,
    certificateHosts,
    uncoveredHosts
  };
}

export async function installTLS(options: { hosts?: string[] } = {}): Promise<{ alreadyEnabled: boolean; hosts: string[] }> {
  ensureRouterFiles();
  const alreadyEnabled = isTLSEnabled();
  const desiredHosts = buildDesiredTLSCertificateHosts(
    options.hosts ?? [],
    currentCertificateHostsOrEmpty()
  );

  ensureMkcert();
  runOrThrow("mkcert", ["-install"]);
  runOrThrow("mkcert", [
    "-cert-file",
    CERT_FILE,
    "-key-file",
    CERT_KEY_FILE,
    ...desiredHosts
  ]);

  setTLSEnabled(true);
  refreshHostRoutesDynamicFile();

  const routerContainer = await findContainerByName("devrouter-traefik");
  if (routerContainer && (await isContainerRunning("devrouter-traefik"))) {
    startRouterStack();
  }

  return { alreadyEnabled, hosts: desiredHosts };
}

export async function ensureTLSHostsCovered(hosts: string[]): Promise<{
  refreshed: boolean;
  uncoveredHosts: string[];
  certificateHosts: string[];
}> {
  if (!isTLSEnabled()) {
    return {
      refreshed: false,
      uncoveredHosts: [],
      certificateHosts: []
    };
  }

  const coverage = getTLSHostCoverage(hosts);
  if (coverage.uncoveredHosts.length === 0) {
    return {
      refreshed: false,
      uncoveredHosts: [],
      certificateHosts: coverage.certificateHosts
    };
  }

  try {
    const refreshed = await installTLS({ hosts: coverage.requiredHosts });
    return {
      refreshed: true,
      uncoveredHosts: coverage.uncoveredHosts,
      certificateHosts: refreshed.hosts
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TLS cert does not currently cover host(s): ${coverage.uncoveredHosts.join(", ")}. ` +
        `Automatic refresh failed: ${message}\n` +
        "Run: dev tls install"
    );
  }
}
