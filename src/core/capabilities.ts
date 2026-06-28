import { TCP_PROTOCOL_REGISTRY } from "./router";

export const SUPPORTED_RUNTIMES = ["host", "docker", "proxy"] as const;
export const SUPPORTED_PROTOCOLS = ["http", "tcp"] as const;
export const SUPPORTED_TCP_PROTOCOLS = Object.freeze(Object.keys(TCP_PROTOCOL_REGISTRY));
export const DEPENDENCY_ONLY_RUNTIME = "docker";
export const RUNTIME_PROTOCOL_COMPATIBILITY = {
  host: ["http"],
  docker: ["http", "tcp"],
  proxy: ["http", "tcp"]
} as const satisfies Record<(typeof SUPPORTED_RUNTIMES)[number], readonly (typeof SUPPORTED_PROTOCOLS)[number][]>;

export const WORKSPACE_PLACEHOLDER = "${WORKSPACE}";
export const SECRET_MANAGER_ENV_PLACEHOLDER = "{env}";
export const DEP_ENV_SUFFIXES = ["HOST", "PORT", "URL", "SHADOW_URL"] as const;
export const POSTGRES_DEPENDENCY_USER = "prisma";
export const POSTGRES_DEPENDENCY_PASSWORD = "prisma";
export const POSTGRES_DEPENDENCY_DATABASE = "prisma";
export const POSTGRES_DEPENDENCY_SHADOW_DATABASE = "shadow";
export const POSTGRES_DEPENDENCY_URL_TEMPLATE =
  `postgres://${POSTGRES_DEPENDENCY_USER}:${POSTGRES_DEPENDENCY_PASSWORD}@localhost:<port>/${POSTGRES_DEPENDENCY_DATABASE}`;
export const POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE =
  `postgres://${POSTGRES_DEPENDENCY_USER}:${POSTGRES_DEPENDENCY_PASSWORD}@localhost:<port>/${POSTGRES_DEPENDENCY_SHADOW_DATABASE}`;

export function formatSupportedTcpProtocols(): string {
  return SUPPORTED_TCP_PROTOCOLS.join(", ");
}

export function formatSupportedProtocolsForRuntime(
  runtime: (typeof SUPPORTED_RUNTIMES)[number]
): string {
  return RUNTIME_PROTOCOL_COMPATIBILITY[runtime].join(", ");
}

export function buildPostgresDependencyUrl(port: number): string {
  return POSTGRES_DEPENDENCY_URL_TEMPLATE.replace("<port>", String(port));
}

export function buildPostgresDependencyShadowUrl(port: number): string {
  return POSTGRES_DEPENDENCY_SHADOW_URL_TEMPLATE.replace("<port>", String(port));
}
