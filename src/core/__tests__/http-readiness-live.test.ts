import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeHttpRoute } from "../http-route-probe";

vi.mock("../router", () => ({ CERT_FILE: "/unused", isTLSEnabled: () => false }));
vi.mock("../tls", () => ({ getMkcertRootCAPath: vi.fn() }));

let server: ChildProcess;
let host: string;

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      "-e",
      `const http = require('node:http');
const server = http.createServer((request, response) => {
  if (request.url === '/slow') return;
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/healthy' });
  } else {
    response.writeHead(200, {
      'content-type': request.url === '/html' ? 'text/html' : 'Application/JSON; charset=utf-8'
    });
  }
  response.end('{}');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await Promise.race([
    once(server.stdout!, "data").then(([data]) => String(data)),
    once(server, "exit").then(([code]) => {
      throw new Error(`Synthetic HTTP server exited before listening (${code}).`);
    }),
  ]);
  host = `127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
});

describe("HTTP readiness with real curl", () => {
  it("requires the declared media type and does not follow redirects", () => {
    const probe = (path: string) =>
      probeHttpRoute(host, { readiness: { path, contentType: "application/json" } });
    expect(probe("/healthy")).toMatchObject({ ok: true, status: 200 });
    expect(probe("/{healthy,html}")).toMatchObject({ ok: true, status: 200 });
    expect(probe("/html")).toMatchObject({ ok: false, status: 200 });
    expect(probe("/redirect")).toMatchObject({ ok: false, status: 302 });
  });

  it("bounds a connected endpoint that never responds", () => {
    const started = Date.now();
    const result = probeHttpRoute(host, {
      readiness: { path: "/slow" },
      maxTimeSeconds: 0.1,
    });
    expect(result).toMatchObject({ ok: false, classification: "transport" });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
