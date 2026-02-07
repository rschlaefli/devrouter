import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AddOptions, AddResult } from "../types";

function parseLabelArray(labels: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(labels)) {
    return result;
  }

  for (const item of labels) {
    if (typeof item !== "string") {
      continue;
    }
    const equalsIndex = item.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = item.slice(0, equalsIndex);
    const value = item.slice(equalsIndex + 1);
    result[key] = value;
  }

  return result;
}

function normalizeLabels(labels: unknown): Record<string, string> {
  if (!labels) {
    return {};
  }

  if (Array.isArray(labels)) {
    return parseLabelArray(labels);
  }

  if (typeof labels === "object") {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
      result[key] = String(value);
    }
    return result;
  }

  return {};
}

function normalizeServiceNetworks(networks: unknown): string[] | Record<string, null> {
  if (Array.isArray(networks)) {
    const values = networks.map((value) => String(value));
    if (!values.includes("devnet")) {
      values.push("devnet");
    }
    return values;
  }

  if (networks && typeof networks === "object") {
    const copy: Record<string, null> = {};
    for (const key of Object.keys(networks as Record<string, unknown>)) {
      copy[key] = null;
    }
    copy.devnet = null;
    return copy;
  }

  return ["devnet"];
}

export function addOrUpdateAppConfig(options: AddOptions): AddResult {
  const cwd = process.cwd();
  const fileName = options.file ?? "docker-compose.devrouter.yml";
  const filePath = path.isAbsolute(fileName) ? fileName : path.join(cwd, fileName);

  const service = options.service.trim();
  if (!service) {
    throw new Error("--service is required");
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer");
  }

  const router = (options.router?.trim() || service).replace(/[^a-zA-Z0-9_-]/g, "-");
  const host = (options.host?.trim() || `${service}.localhost`).toLowerCase();

  if (!host.endsWith(".localhost") && !options.force) {
    throw new Error("Host must end with .localhost. Use --force to override.");
  }

  let doc: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf-8");
    doc = (YAML.parse(raw) as Record<string, unknown>) ?? {};
  }

  if (!doc.services || typeof doc.services !== "object") {
    doc.services = {};
  }

  const services = doc.services as Record<string, Record<string, unknown>>;
  const serviceDef: Record<string, unknown> = services[service] ?? {};

  serviceDef.networks = normalizeServiceNetworks(serviceDef.networks);

  const labels = normalizeLabels(serviceDef.labels);
  labels["traefik.enable"] = "true";
  labels["traefik.docker.network"] = "devnet";
  labels[`traefik.http.routers.${router}.rule`] = `Host(\`${host}\`)`;
  labels[`traefik.http.routers.${router}.entrypoints`] = "web,websecure";
  labels[`traefik.http.routers.${router}.tls`] = "true";
  labels[`traefik.http.services.${router}.loadbalancer.server.port`] = String(options.port);

  serviceDef.labels = labels;
  services[service] = serviceDef;

  if (!doc.networks || typeof doc.networks !== "object") {
    doc.networks = {};
  }

  const networks = doc.networks as Record<string, Record<string, unknown>>;
  networks.devnet = {
    ...(networks.devnet ?? {}),
    external: true
  };

  const yaml = YAML.stringify(doc, {
    lineWidth: 0
  });

  fs.writeFileSync(filePath, yaml, "utf-8");

  return {
    filePath,
    host,
    router
  };
}
