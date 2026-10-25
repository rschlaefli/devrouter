import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureNetwork,
  findContainerByName,
  isContainerRunning,
  listContainers,
  networkExists,
} from "../docker";
import { withNetworkEffectGuard } from "../network-effect-scope";

type Request = { method: string; path: string; all: string | null; body: unknown };
type Transport = "unix" | "http" | "tcp";

// Exercise the installed Dockerode and its modem, rather than replacing either
// with a mock. These endpoints belong only to this test; no Docker daemon,
// context, container, network, or global Devrouter state is accessed.
describe.each<Transport>(["unix", "http", "tcp"])("Dockerode %s transport", (transport) => {
  let server: Server;
  let endpoint: string;
  let directory: string | undefined;
  let requests: Request[];
  let networks: Set<string>;
  let listStatus: number;
  let createStatus: number;

  const scoped = <T>(operation: () => T): T =>
    withNetworkEffectGuard(() => {}, operation, endpoint);

  beforeEach(async () => {
    requests = [];
    networks = new Set(["existing"]);
    listStatus = 200;
    createStatus = 201;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const url = new URL(request.url ?? "/", "http://fixture");
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method ?? "", path, all: url.searchParams.get("all"), body });
      response.setHeader("content-type", "application/json");

      if (request.method === "GET" && path === "/containers/json") {
        response.statusCode = listStatus;
        response.end(
          JSON.stringify(
            listStatus === 200
              ? [
                  { Id: "running-id", Names: ["/running"], State: "running" },
                  ...(url.searchParams.get("all") === "true"
                    ? [{ Id: "stopped-id", Names: ["/stopped"], State: "exited" }]
                    : []),
                ]
              : { message: "container listing denied" },
          ),
        );
        return;
      }

      if (request.method === "GET" && path.startsWith("/networks/")) {
        const name = decodeURIComponent(path.slice("/networks/".length));
        response.statusCode = networks.has(name) ? 200 : 404;
        response.end(
          JSON.stringify(
            networks.has(name) ? { Name: name, Id: `${name}-id` } : { message: "no such network" },
          ),
        );
        return;
      }

      if (request.method === "POST" && path === "/networks/create") {
        response.statusCode = createStatus;
        if (createStatus === 201) networks.add(body.Name);
        response.end(
          JSON.stringify(
            createStatus === 201
              ? { Id: `${body.Name}-id`, Warning: "" }
              : { message: "network creation denied" },
          ),
        );
        return;
      }

      response.statusCode = 500;
      response.end(
        JSON.stringify({ message: `unexpected Docker API request: ${request.method} ${path}` }),
      );
    });

    if (transport === "unix") {
      // Keep the pathname below macOS's short Unix-domain socket limit.
      directory = await mkdtemp("/tmp/dr-dockerode-");
      const socket = join(directory, "api.sock");
      server.listen(socket);
      await once(server, "listening");
      endpoint = `unix://${socket}`;
    } else {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture has no TCP address.");
      endpoint = `${transport}://127.0.0.1:${address.port}`;
    }
  });

  afterEach(async () => {
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("loads the real CommonJS client and preserves the all-containers query", async () => {
    await expect(scoped(() => listContainers())).resolves.toMatchObject([
      { Id: "running-id" },
      { Id: "stopped-id" },
    ]);
    await expect(scoped(() => listContainers(false))).resolves.toMatchObject([
      { Id: "running-id" },
    ]);
    expect(requests.map(({ method, path, all }) => ({ method, path, all }))).toEqual([
      { method: "GET", path: "/containers/json", all: "true" },
      { method: "GET", path: "/containers/json", all: "false" },
    ]);
  });

  it("looks up exact names and distinguishes stopped and absent containers", async () => {
    await expect(scoped(() => findContainerByName("running"))).resolves.toMatchObject({
      Id: "running-id",
    });
    await expect(scoped(() => findContainerByName("run"))).resolves.toBeUndefined();
    await expect(scoped(() => isContainerRunning("running"))).resolves.toBe(true);
    await expect(scoped(() => isContainerRunning("stopped"))).resolves.toBe(false);
    await expect(scoped(() => isContainerRunning("absent"))).resolves.toBe(false);
    expect(requests.every(({ all }) => all === "true")).toBe(true);
  });

  it("inspects existing networks without creating them", async () => {
    await expect(scoped(() => networkExists("existing"))).resolves.toBe(true);
    await expect(scoped(() => ensureNetwork("existing"))).resolves.toBeUndefined();
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/networks/existing" },
      { method: "GET", path: "/networks/existing" },
    ]);
  });

  it("recognizes a missing network and creates the requested bridge network", async () => {
    await expect(scoped(() => networkExists("new-network"))).resolves.toBe(false);
    await expect(scoped(() => ensureNetwork("new-network"))).resolves.toBeUndefined();
    await expect(scoped(() => networkExists("new-network"))).resolves.toBe(true);
    expect(requests.filter(({ method }) => method === "POST")).toEqual([
      {
        method: "POST",
        path: "/networks/create",
        all: null,
        body: { Name: "new-network", Driver: "bridge", Attachable: true },
      },
    ]);
  });

  it("preserves Docker API failures from container listing", async () => {
    listStatus = 503;
    await expect(scoped(() => listContainers())).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("container listing denied"),
    });
  });

  it("does not report success when Docker rejects network creation", async () => {
    createStatus = 403;
    await expect(scoped(() => ensureNetwork("new-network"))).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("network creation denied"),
    });
    expect(networks.has("new-network")).toBe(false);
  });
});
