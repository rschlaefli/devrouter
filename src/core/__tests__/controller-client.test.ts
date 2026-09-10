import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  controllerRequest,
  followControllerOperation,
  submitControllerOperation,
} from "../controller-client";

const binding = { session: "session-1", store: "store-1", epoch: 1, generation: "generation-1" };
const queued = {
  operationId: "operation-1",
  phase: "queued",
  outcome: null,
  reason: null,
  exitCode: null,
};
const completed = { ...queued, phase: "terminal", outcome: "COMPLETED", exitCode: 7 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  handler: (request: any, send: (result: unknown) => void, socket: net.Socket) => void,
) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-client-")));
  const sockets = new Set<net.Socket>();
  const requests: any[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const send = (result: unknown) =>
          socket.write(`${JSON.stringify({ version: 1, id: request.id, ok: true, result })}\n`);
        if (request.method === "handshake") send({ store: binding.store, epoch: binding.epoch });
        else {
          requests.push(request);
          handler(request, send, socket);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path.join(directory, "control.sock"), () => {
      fs.chmodSync(path.join(directory, "control.sock"), 0o600);
      resolve();
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  });
  return { directory, requests };
}

it("submits a named exec once and drains every bounded output page, including after completion", async () => {
  let page = 0;
  const pages: unknown[] = [];
  const { directory, requests } = await fixture((request, send) => {
    if (request.method === "operation-submit") return send({ operation: queued });
    page++;
    send({
      operation: completed,
      output: {
        encoding: "base64",
        gap: page === 1,
        sequence: { sequence: Math.min(page, 2), offset: 1 },
        chunks:
          page <= 2
            ? [
                {
                  stream: "stdout",
                  data: Buffer.from(String(page)).toString("base64"),
                  sequence: page,
                },
              ]
            : [],
      },
    });
  });
  const result = await submitControllerOperation(
    directory,
    {
      ...binding,
      requestId: "request-1",
      kind: "exec",
      operation: "build",
      command: ["tool", "literal arg"],
    },
    { waitSeconds: 2, onOutput: (page) => pages.push(page) },
  );
  expect(result).toMatchObject({
    status: "terminal",
    operationId: queued.operationId,
    operation: { exitCode: 7 },
    outputGap: true,
  });
  expect(pages).toHaveLength(3);
  expect(requests.filter((r) => r.method === "operation-submit")).toHaveLength(1);
  expect(requests[0]).toMatchObject({ operation: "build", command: ["tool", "literal arg"] });
  expect(requests.slice(1).every((r) => !Object.hasOwn(r, "command"))).toBe(true);
  expect(requests.at(-1).output).toEqual({ sequence: 2, offset: 1 });
});

it("returns pending at the caller deadline and resumes the same operation without submission", async () => {
  let respond = false;
  const { directory, requests } = await fixture((request, send) => {
    if (request.method === "operation-submit") send({ operation: queued });
    else if (respond) send({ operation: completed, output: null });
  });
  const started = performance.now();
  const pending = await submitControllerOperation(
    directory,
    { ...binding, requestId: "request-2", kind: "ensure" },
    { waitSeconds: 1 },
  );
  expect(pending).toMatchObject({ status: "pending", operationId: queued.operationId });
  expect(performance.now() - started).toBeLessThan(2500);
  respond = true;
  const resumed = await followControllerOperation(
    directory,
    { ...binding, operationId: pending.operationId, output: pending.outputCursor },
    { waitSeconds: 1 },
  );
  expect(resumed).toMatchObject({ status: "terminal", operationId: pending.operationId });
  expect(requests.filter((r) => r.method === "operation-submit")).toHaveLength(1);
  expect(requests.filter((r) => r.method === "operation-watch")).toHaveLength(2);
});

it("retains acknowledged identity across disconnection, without replay or cancellation", async () => {
  let disconnected = false;
  const { directory, requests } = await fixture((request, send, socket) => {
    if (request.method === "operation-submit") send({ operation: queued });
    else if (!disconnected) {
      disconnected = true;
      socket.destroy();
    } else send({ operation: completed, output: null });
  });
  const unknown = await submitControllerOperation(directory, {
    ...binding,
    requestId: "request-3",
    kind: "ensure",
  });
  expect(unknown).toMatchObject({ status: "unknown", operationId: queued.operationId });
  expect(
    await followControllerOperation(directory, { ...binding, operationId: unknown.operationId }),
  ).toMatchObject({ status: "terminal" });
  expect(requests.map((r) => r.method)).toEqual([
    "operation-submit",
    "operation-watch",
    "operation-watch",
  ]);
});

it.each([
  { operation: { ...completed, operationId: "foreign" }, output: null },
  { operation: { ...completed, outcome: null }, output: null },
  {
    operation: completed,
    output: { encoding: "base64", gap: "yes", sequence: { sequence: 0, offset: 0 }, chunks: [] },
  },
])("does not report success for an invalid operation response", async (response) => {
  const { directory } = await fixture((_request, send) => send(response));
  expect(
    await followControllerOperation(directory, { ...binding, operationId: queued.operationId }),
  ).toMatchObject({ status: "unknown", operationId: queued.operationId });
});

it("keeps initial acknowledgement loss uncertain under its original request ID", async () => {
  const { directory, requests } = await fixture((_request, _send, socket) => socket.destroy());
  await expect(
    submitControllerOperation(directory, { ...binding, requestId: "request-4", kind: "ensure" }),
  ).rejects.toMatchObject({ requestId: "request-4", acknowledged: false });
  expect(requests).toHaveLength(1);
});

it("validates caller wait before sending an operation", async () => {
  const { directory, requests } = await fixture((_request, send) => send({ operation: queued }));
  await expect(
    submitControllerOperation(
      directory,
      { ...binding, requestId: "request-5", kind: "ensure" },
      { waitSeconds: -1 },
    ),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

it("ends generic observation watches on their end frame", async () => {
  const { directory } = await fixture((_request, send) => send({ kind: "end" }));
  const frames: unknown[] = [];
  await controllerRequest(directory, { ...binding, method: "watch", timeout: 1 }, (frame) =>
    frames.push(frame),
  );
  expect(frames).toHaveLength(1);
});
