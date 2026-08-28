import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findContainerByName, isContainerRunning } from "./docker";
import { withFileLockSync } from "./file-lock";
import { refreshHostRoutesDynamicFile } from "./host-routes";
import {
  CERT_FILE,
  CERT_KEY_FILE,
  DEVROUTER_HOME,
  ensureRouterFiles,
  isTLSEnabled,
  setTLSEnabled,
  startRouterStack,
} from "./router";

export const DEFAULT_TLS_CERT_HOSTS = ["localhost", "*.localhost"] as const;
const TLS_CERTIFICATE_LOCK_FILE = path.join(DEVROUTER_HOME, "tls-certificate.lock");
const TLS_CERTIFICATE_LOCK_WAIT_MS = 60_000;
const TLS_CERTIFICATE_WRITE_ATTEMPTS = 2;

function runOrThrow(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${details || "unknown error"}`);
  }

  return result.stdout.trim();
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf-8" });
  return result.status === 0;
}

function ensureMkcert(): void {
  if (!commandExists("mkcert")) {
    throw new Error(
      "mkcert is not installed. Please install it to use TLS features (e.g., 'brew install mkcert' or via your package manager).",
    );
  }
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function tlsSetupCommand(repoPath?: string): string {
  return `devrouter setup --repo ${repoPath ? quoteShellArgument(repoPath) : "."} --yes`;
}

export function getMkcertRootCAPath(options: { repoPath?: string } = {}): string {
  ensureMkcert();
  const rootCAPath = path.join(runOrThrow("mkcert", ["-CAROOT"]), "rootCA.pem");
  if (!fs.existsSync(rootCAPath)) {
    throw new Error(
      `mkcert root CA was not found at '${rootCAPath}'. Run: ${tlsSetupCommand(options.repoPath)}`,
    );
  }
  return rootCAPath;
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

  if (normalizedHost === normalizedCertificateHost) {
    return true;
  }

  if (normalizedCertificateHost.startsWith("*.")) {
    // OpenSSL-backed clients do not accept a wildcard directly beneath the
    // special-use .localhost suffix, so those hosts need explicit SANs.
    if (normalizedCertificateHost === "*.localhost") {
      return false;
    }

    const suffix = normalizedCertificateHost.slice(1);
    if (!normalizedHost.endsWith(suffix)) {
      return false;
    }

    const wildcardPart = normalizedHost.slice(0, normalizedHost.length - suffix.length);
    return wildcardPart.length > 0 && !wildcardPart.includes(".");
  }

  return false;
}

export function findUncoveredCertificateHosts(
  requiredHosts: string[],
  certificateHosts: string[],
): string[] {
  const normalizedRequired = normalizeUniqueHosts(requiredHosts);
  const normalizedCertificateHosts = normalizeUniqueHosts(certificateHosts);

  return normalizedRequired.filter(
    (requiredHost) =>
      !normalizedCertificateHosts.some((certificateHost) =>
        isHostCoveredByCertificateHost(requiredHost, certificateHost),
      ),
  );
}

export function compactTLSCertificateHosts(hosts: string[]): string[] {
  const normalizedHosts = normalizeUniqueHosts(hosts);
  const wildcardHosts = new Set(normalizedHosts.filter((host) => host.startsWith("*.")));
  const siblingGroups = new Map<string, string[]>();
  const compacted = new Set(wildcardHosts);

  for (const host of normalizedHosts) {
    if (host.startsWith("*.")) {
      continue;
    }

    const labels = host.split(".");
    if (labels.length < 3 || labels.at(-1) !== "localhost") {
      compacted.add(host);
      continue;
    }

    const suffix = labels.slice(1).join(".");
    const siblings = siblingGroups.get(suffix) ?? [];
    siblings.push(host);
    siblingGroups.set(suffix, siblings);
  }

  for (const [suffix, siblings] of siblingGroups) {
    const wildcard = `*.${suffix}`;
    if (siblings.length > 1 || wildcardHosts.has(wildcard)) {
      compacted.add(wildcard);
      continue;
    }
    compacted.add(siblings[0]);
  }

  const selectedWildcards = Array.from(compacted).filter((host) => host.startsWith("*."));
  return normalizeUniqueHosts(Array.from(compacted)).filter(
    (host) =>
      host.startsWith("*.") ||
      !selectedWildcards.some((wildcard) => isHostCoveredByCertificateHost(host, wildcard)),
  );
}

function readCurrentCertificateHosts(options: { replaceMalformed?: boolean } = {}): string[] {
  if (!fs.existsSync(CERT_FILE)) {
    return [];
  }

  try {
    const pem = fs.readFileSync(CERT_FILE, "utf-8");
    return parseCertificateDnsHosts(pem);
  } catch (error) {
    if (options.replaceMalformed) {
      return [];
    }
    throw error;
  }
}

export function buildDesiredTLSCertificateHosts(
  requestedHosts: string[],
  existingCertificateHosts: string[],
): string[] {
  return compactTLSCertificateHosts([
    ...DEFAULT_TLS_CERT_HOSTS,
    ...existingCertificateHosts,
    ...requestedHosts,
  ]);
}

export function getTLSHostCoverage(hosts: string[]): {
  requiredHosts: string[];
  certificateHosts: string[];
  uncoveredHosts: string[];
} {
  const requiredHosts = normalizeUniqueHosts([...DEFAULT_TLS_CERT_HOSTS, ...hosts]);
  return withFileLockSync(
    TLS_CERTIFICATE_LOCK_FILE,
    { activity: "TLS certificate inspection", waitMs: TLS_CERTIFICATE_LOCK_WAIT_MS },
    () => {
      const certificateHosts = readCurrentCertificateHosts();
      const uncoveredHosts = findUncoveredCertificateHosts(requiredHosts, certificateHosts);

      return {
        requiredHosts,
        certificateHosts,
        uncoveredHosts,
      };
    },
  );
}

async function applyTLSCertificate(
  options: { hosts?: string[]; repoPath?: string },
  installTrust: boolean,
): Promise<{ alreadyEnabled: boolean; hosts: string[] }> {
  ensureRouterFiles();
  const result = withFileLockSync(
    TLS_CERTIFICATE_LOCK_FILE,
    {
      activity: "TLS certificate refresh",
      target: options.repoPath,
      waitMs: TLS_CERTIFICATE_LOCK_WAIT_MS,
    },
    () => {
      const alreadyEnabled = isTLSEnabled();

      if (installTrust) {
        ensureMkcert();
        runOrThrow("mkcert", ["-install"]);
      } else {
        getMkcertRootCAPath({ repoPath: options.repoPath });
      }

      // Routine refresh must preserve readable existing coverage and fail
      // closed when it cannot. Explicit install/setup is the recovery path: it
      // replaces a malformed generated certificate while still holding the
      // same machine-global lock.
      const existingCertificateHosts = readCurrentCertificateHosts({
        replaceMalformed: installTrust,
      });
      const desiredHosts = buildDesiredTLSCertificateHosts(
        options.hosts ?? [],
        existingCertificateHosts,
      );
      let certificateHosts: string[] = [];
      let uncoveredHosts: string[] = [];

      for (let attempt = 1; attempt <= TLS_CERTIFICATE_WRITE_ATTEMPTS; attempt += 1) {
        runOrThrow("mkcert", [
          "-cert-file",
          CERT_FILE,
          "-key-file",
          CERT_KEY_FILE,
          ...desiredHosts,
        ]);

        certificateHosts = readCurrentCertificateHosts();
        uncoveredHosts = findUncoveredCertificateHosts(desiredHosts, certificateHosts);
        if (uncoveredHosts.length === 0) {
          break;
        }
      }

      if (uncoveredHosts.length > 0) {
        throw new Error(
          `mkcert did not produce certificate coverage for host(s): ${uncoveredHosts.join(", ")} after ${TLS_CERTIFICATE_WRITE_ATTEMPTS} attempts`,
        );
      }

      setTLSEnabled(true);
      refreshHostRoutesDynamicFile();

      return { alreadyEnabled, hosts: certificateHosts };
    },
  );

  const routerContainer = await findContainerByName("devrouter-traefik");
  if (routerContainer && (await isContainerRunning("devrouter-traefik"))) {
    startRouterStack();
  }

  return result;
}

export async function installTLS(
  options: { hosts?: string[]; repoPath?: string } = {},
): Promise<{ alreadyEnabled: boolean; hosts: string[] }> {
  return applyTLSCertificate(options, true);
}

export async function refreshTLSCertificate(
  options: { hosts?: string[]; repoPath?: string } = {},
): Promise<{ alreadyEnabled: boolean; hosts: string[] }> {
  return applyTLSCertificate(options, false);
}

export async function ensureTLSHostsCovered(
  hosts: string[],
  options: { repoPath?: string } = {},
): Promise<{
  refreshed: boolean;
  uncoveredHosts: string[];
  certificateHosts: string[];
}> {
  if (!isTLSEnabled()) {
    return {
      refreshed: false,
      uncoveredHosts: [],
      certificateHosts: [],
    };
  }

  const coverage = getTLSHostCoverage(hosts);
  if (coverage.uncoveredHosts.length === 0) {
    return {
      refreshed: false,
      uncoveredHosts: [],
      certificateHosts: coverage.certificateHosts,
    };
  }

  try {
    const refreshed = await refreshTLSCertificate({
      hosts: coverage.requiredHosts,
      repoPath: options.repoPath,
    });
    return {
      refreshed: true,
      uncoveredHosts: coverage.uncoveredHosts,
      certificateHosts: refreshed.hosts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TLS cert does not currently cover host(s): ${coverage.uncoveredHosts.join(", ")}. ` +
        `Automatic refresh failed: ${message}\n` +
        `Run: ${tlsSetupCommand(options.repoPath)}`,
    );
  }
}
