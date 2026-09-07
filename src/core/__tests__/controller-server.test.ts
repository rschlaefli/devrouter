import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CONTROLLER_FRAME_BYTES } from "../controller-protocol";
import { runController } from "../controller-server";

const directories: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-")));
  directories.push(directory);
  const abort = new AbortController();
  let listening: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const run = runController({
    directory,
    signal: abort.signal,
    onListening: listening,
    resolve: async () => ({
      id: "env",
      repoPath: "/fixture/checkout",
      workspace: "fixture",
      provider: "devsy",
      providerId: "provider",
      profile: "web",
      fingerprint: "a".repeat(64),
    }),
  });
  await Promise.race([ready, run]);
  stops.push(async () => {
    abort.abort();
    await run;
  });
  return { directory, run, abort };
}
function connect(directory: string) {
  const socket = net.createConnection(path.join(directory, "control.sock"));
  let pending: ((value: any) => void) | undefined;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const value = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending?.(value);
      pending = undefined;
    }
  });
  return {
    socket,
    request: (request: object) =>
      new Promise<any>((resolve) => {
        pending = resolve;
        socket.write(`${JSON.stringify({ version: 1, id: "request", ...request })}\n`);
      }),
  };
}
it("serves two durable consumer bindings and keeps the socket private", async () => {
  const { directory } = await fixture();
  const first = connect(directory);
  const second = connect(directory);
  expect((await first.request({ method: "handshake" })).ok).toBe(true);
  expect((await second.request({ method: "handshake" })).ok).toBe(true);
  const acquired = await first.request({
    method: "observe",
    path: "/fixture/checkout",
    session: "one",
    profile: "web",
    require: ["runtime"],
  });
  expect(acquired.ok).toBe(true);
  expect(
    (
      await second.request({
        method: "observe",
        path: "/fixture/checkout",
        session: "two",
        profile: "web",
        require: ["runtime"],
      })
    ).ok,
  ).toBe(true);
  expect((await first.request({ method: "status" })).result.sessions).toHaveLength(2);
  expect((await first.request({ method: "release", ...acquired.result })).ok).toBe(true);
  expect((await second.request({ method: "status" })).result.sessions).toHaveLength(1);
  expect(fs.statSync(path.join(directory, "control.sock")).mode & 0o777).toBe(0o600);
  first.socket.destroy();
  second.socket.destroy();
});
it("rejects a second live owner without changing its snapshot", async () => {
  const { directory } = await fixture();
  const snapshot = fs.readFileSync(path.join(directory, "snapshot.json"));
  await expect(
    runController({
      directory,
      signal: new AbortController().signal,
      resolve: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(path.join(directory, "snapshot.json"))).toEqual(snapshot);
});
it("disconnects a client that skips the protocol handshake", async () => {
  const { directory } = await fixture();
  const client = connect(directory);
  const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
  client.socket.write(`${JSON.stringify({ version: 1, id: "request", method: "status" })}\n`);
  await closed;
});
it("streams a gap for a replaced store and ends at the watch deadline", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: Record<string, unknown> = {};
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );
  const results: any[] = [];
  await controllerRequest(
    directory,
    { method: "watch", ...binding, after: "1:0", afterStore: "replaced", timeout: 0 },
    (value: any) => results.push(value.result),
  );
  expect(results[0].kind).toBe("gap");
  expect(results.at(-1).kind).toBe("end");
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "snapshot.json"), "utf8"));
  expect(snapshot.sessions).toHaveLength(1);
});
it("replays valid cursors, accepts the oldest retained boundary, and gaps future or mismatched cursors", async () => {
  const { controllerRequest } = await import("../controller-client");
  const { directory } = await fixture();
  let binding: Record<string, any> = {};
  await controllerRequest(
    directory,
    {
      method: "observe",
      path: "/fixture/checkout",
      session: "one",
      profile: "web",
      require: ["runtime"],
    },
    (value: any) => {
      binding = value.result;
    },
  );

  const initialResults: any[] = [];
  await controllerRequest(
    directory,
    {
      method: "watch",
      ...binding,
      after: `${binding.epoch}:0`,
      afterStore: binding.store,
      timeout: 0,
    },
    (value: any) => initialResults.push(value.result),
  );
  expect(initialResults.map((result) => result.kind)).toEqual(["snapshot", "event", "end"]);
  expect(initialResults[1].event.sequence).toBe(1);

  for (let index = 0; index < 256; index += 1) {
    await controllerRequest(directory, { method: "renew", ...binding }, (value: any) => {
      binding = value.result;
    });
  }

  const boundaryResults: any[] = [];
  await controllerRequest(
    directory,
    {
      method: "watch",
      ...binding,
      after: `${binding.epoch}:1`,
      afterStore: binding.store,
      timeout: 0,
    },
    (value: any) => boundaryResults.push(value.result),
  );
  const retainedEvents = boundaryResults
    .filter((result) => result.kind === "event")
    .map((result) => result.event.sequence);
  expect(boundaryResults[0].kind).toBe("snapshot");
  expect(retainedEvents[0]).toBe(2);
  expect(retainedEvents.at(-1)).toBe(257);

  const gapCases = [
    { after: `${binding.epoch}:258`, afterStore: binding.store },
    { after: `${binding.epoch + 1}:1`, afterStore: binding.store },
    { after: `${binding.epoch}:1`, afterStore: "other-store" },
  ];
  for (const cursor of gapCases) {
    const results: any[] = [];
    await controllerRequest(
      directory,
      { method: "watch", ...binding, ...cursor, timeout: 0 },
      (value: any) => results.push(value.result),
    );
    expect(results[0].kind).toBe("gap");
    expect(results.at(-1).kind).toBe("end");
  }
});
it("rejects connection 33 while 32 controller clients remain active", async () => {
  const { directory } = await fixture();
  const clients = Array.from({ length: 32 }, () => connect(directory));
  try {
    const handshakes = await Promise.all(
      clients.map((client) => client.request({ method: "handshake" })),
    );
    expect(handshakes.every((result) => result.ok)).toBe(true);

    const rejected = net.createConnection(path.join(directory, "control.sock"));
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        rejected.destroy();
        resolve();
      };
      rejected.once("error", finish);
      rejected.once("close", finish);
    });
  } finally {
    for (const client of clients) client.socket.destroy();
  }
});
it("disconnects a client that sends an oversized frame", async () => {
  const { directory } = await fixture();
  const socket = net.createConnection(path.join(directory, "control.sock"));
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve();
    };
    socket.once("error", finish);
    socket.once("close", finish);
    socket.write(Buffer.alloc(CONTROLLER_FRAME_BYTES + 1, 0x78));
  });
});
