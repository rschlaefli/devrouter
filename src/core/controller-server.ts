import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ControllerMonitor, type ControllerObservationCollector } from "./controller-monitor";
import { parseControllerRequest } from "./controller-protocol";
import { ControllerSessions } from "./controller-sessions";
import {
  type ControllerEnvironment,
  type ControllerSnapshot,
  ControllerStore,
} from "./controller-store";
import { withFileLock } from "./file-lock";

const FRAME_BYTES = 65_536;
function privateDirectory(directory: string) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe controller directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const stat = fs.lstatSync(absolute);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Controller directory is not private.");
}
function validateOwnedFile(file: string, socket: boolean) {
  try {
    const stat = fs.lstatSync(file);
    if (
      stat.uid !== process.getuid?.() ||
      (socket ? !stat.isSocket() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Unsafe controller artifact.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolver must prove existing canonical ownership without claiming or starting it. */
export type ControllerResolver = (
  request: { path: string; profile: string; require: string[] },
  signal: AbortSignal,
) => Promise<ControllerEnvironment>;
export async function runController(options: {
  directory: string;
  signal: AbortSignal;
  resolve: ControllerResolver;
  collect?: ControllerObservationCollector;
  onListening?: () => void;
}): Promise<void> {
  const socketPath = path.join(options.directory, "control.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new Error("Controller socket path is too long.");
  privateDirectory(options.directory);
  const lockPath = path.join(options.directory, "owner.lock");
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.uid !== process.getuid?.())
      throw new Error("Unsafe controller owner lock.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await withFileLock(lockPath, { activity: "controller ownership", waitMs: 0 }, async () => {
    if (validateOwnedFile(socketPath, true)) fs.unlinkSync(socketPath);
    const sessions = new ControllerSessions(new ControllerStore(options.directory));
    const sockets = new Set<net.Socket>();
    let serial = Promise.resolve();
    const monotonic = () => Math.floor(performance.now());
    let fatal: Error | undefined;
    const monitor = options.collect
      ? new ControllerMonitor(sessions, options.collect, (operation) => {
          const pending = serial.then(operation);
          serial = pending.catch(() => {});
          return pending;
        })
      : undefined;
    const server = net.createServer((socket) => {
      if (sockets.size >= 32) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let handshake = false;
      let pending = false;
      let watch:
        | {
            request: Extract<ReturnType<typeof parseControllerRequest>, { method: "watch" }>;
            sequence: number;
            deadline: number;
          }
        | undefined;
      let queuedFrames = 0;
      socket.on("drain", () => {
        queuedFrames = 0;
      });
      const handshakeTimer = setTimeout(() => socket.destroy(), 5000);
      const send = (value: unknown) => {
        const frame = `${JSON.stringify(value)}\n`;
        if (
          Buffer.byteLength(frame) > FRAME_BYTES ||
          socket.writableLength + Buffer.byteLength(frame) > 262_144 ||
          queuedFrames >= 64
        ) {
          socket.destroy();
          return;
        }
        if (!socket.write(frame)) queuedFrames++;
      };
      const replay = (
        snapshot: ControllerSnapshot,
        request: Extract<ReturnType<typeof parseControllerRequest>, { method: "watch" }>,
        sequence: number,
      ) => {
        for (const event of snapshot.events.filter(
          (event) =>
            event.sequence > sequence &&
            event.session === request.session &&
            event.generation === request.generation,
        ))
          send({
            version: 1,
            id: request.id,
            ok: true,
            result: {
              kind: "event",
              store: snapshot.store,
              epoch: snapshot.epoch,
              event,
            },
          });
      };
      let watchQueued = false;
      const watchTimer = setInterval(() => {
        if (!watch || socket.destroyed || watchQueued) return;
        watchQueued = true;
        const subscription = watch;
        serial = serial
          .then(() => {
            if (socket.destroyed) return;
            sessions.tick(monotonic(), Date.now());
            const snapshot = sessions.read();
            replay(snapshot, subscription.request, subscription.sequence);
            if (
              snapshot.events.some(
                (event) =>
                  event.sequence > subscription.sequence &&
                  event.session === subscription.request.session &&
                  event.generation === subscription.request.generation,
              )
            ) {
              const current = snapshot.sessions.find(
                (session) =>
                  session.id === subscription.request.session &&
                  session.generation === subscription.request.generation,
              );
              send({
                version: 1,
                id: subscription.request.id,
                ok: true,
                result: {
                  kind: "snapshot",
                  store: snapshot.store,
                  epoch: snapshot.epoch,
                  sequence: snapshot.nextSequence - 1,
                  session: current ? sessions.projection(current, monotonic()) : null,
                  status: current ? sessions.projection(current, monotonic()).status : "UNKNOWN",
                },
              });
            }
            subscription.sequence = snapshot.nextSequence - 1;
            try {
              sessions.validate(subscription.request);
            } catch {
              socket.end();
              watch = undefined;
              return;
            }
            if (monotonic() >= subscription.deadline) {
              send({ version: 1, id: subscription.request.id, ok: true, result: { kind: "end" } });
              socket.end();
              watch = undefined;
            }
          })
          .catch(() => {
            socket.destroy();
          })
          .finally(() => {
            watchQueued = false;
          });
      }, 100);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        clearTimeout(handshakeTimer);
        clearInterval(watchTimer);
        sockets.delete(socket);
      });
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        if (pending || watch || newline !== buffer.length - 1) {
          socket.destroy();
          return;
        }
        const frame = buffer.subarray(0, newline).toString("utf8");
        buffer = Buffer.alloc(0);
        pending = true;
        let request: ReturnType<typeof parseControllerRequest>;
        try {
          request = parseControllerRequest(JSON.parse(frame));
        } catch {
          send({ version: 1, ok: false, error: "invalid-request" });
          socket.end();
          return;
        }
        if (!handshake && request.method !== "handshake") {
          socket.destroy();
          return;
        }
        if (handshake && request.method === "handshake") {
          socket.destroy();
          return;
        }
        const task = async () => {
          if (socket.destroyed) return;
          sessions.tick(monotonic(), Date.now());
          let result: unknown;
          if (request.method === "handshake") {
            handshake = true;
            clearTimeout(handshakeTimer);
            const snapshot = sessions.read();
            result = { store: snapshot.store, epoch: snapshot.epoch };
          } else if (request.method === "observe") {
            // Resolver cancellation includes disconnection and a fixed deadline.
            const controller = new AbortController();
            const abort = () => controller.abort();
            socket.once("close", abort);
            let rejectDeadline: (error: Error) => void = () => {};
            const timedOut = new Promise<never>((_resolve, reject) => {
              rejectDeadline = reject;
            });
            const deadline = setTimeout(() => {
              abort();
              rejectDeadline(new Error("Resolver deadline exceeded."));
            }, 3000);
            try {
              const environment = await Promise.race([
                options.resolve(request, controller.signal),
                timedOut,
              ]);
              if (controller.signal.aborted || socket.destroyed)
                throw new Error("Observation binding unavailable.");
              result = sessions.acquire(
                request.session,
                environment,
                request.require,
                monotonic(),
                Date.now(),
              );
            } finally {
              clearTimeout(deadline);
              socket.removeListener("close", abort);
            }
          } else if (request.method === "renew") {
            result = sessions.renew(request, monotonic(), Date.now());
          } else if (request.method === "release") {
            sessions.release(request, monotonic(), Date.now());
            result = { released: true };
          } else if (request.method === "status") {
            const snapshot = sessions.read();
            const offset = request.cursor === undefined ? 0 : Number(request.cursor);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.sessions.length)
              throw new Error("Invalid status cursor.");
            const selected = request.session
              ? snapshot.sessions.filter((s) => s.id === request.session)
              : snapshot.sessions.slice(offset, offset + 16);
            result = {
              store: snapshot.store,
              epoch: snapshot.epoch,
              revision: snapshot.revision,
              sessions: selected.map((s) => sessions.projection(s, monotonic())),
              cursor:
                !request.session && offset + 16 < snapshot.sessions.length
                  ? String(offset + 16)
                  : null,
            };
          } else {
            sessions.validate(request);
            const deadline = monotonic() + request.timeout * 1000;
            if (!Number.isSafeInteger(deadline) || request.timeout > 2_147_483)
              throw new Error("Watch deadline exceeds supported bounds.");
            const snapshot = sessions.read();
            const parts = request.after?.match(/^([0-9]+):([0-9]+)$/);
            const epoch = parts ? Number(parts[1]) : undefined;
            const sequence = parts ? Number(parts[2]) : undefined;
            const oldest = snapshot.events[0]?.sequence ?? snapshot.nextSequence;
            const gap =
              request.after !== undefined &&
              (!parts ||
                request.afterStore !== snapshot.store ||
                epoch !== snapshot.epoch ||
                !Number.isSafeInteger(sequence) ||
                Number(sequence) < oldest - 1 ||
                Number(sequence) >= snapshot.nextSequence);
            const current = snapshot.sessions.find((session) => session.id === request.session);
            send({
              version: 1,
              id: request.id,
              ok: true,
              result: {
                kind: gap ? "gap" : "snapshot",
                store: snapshot.store,
                epoch: snapshot.epoch,
                sequence: snapshot.nextSequence - 1,
                session: current ? sessions.projection(current, monotonic()) : null,
                status: current ? sessions.projection(current, monotonic()).status : "UNKNOWN",
              },
            });
            if (!gap && sequence !== undefined) {
              replay(snapshot, request, sequence);
            }
            watch = {
              request,
              sequence: snapshot.nextSequence - 1,
              deadline,
            };
            return;
          }
          send({ version: 1, id: request.id, ok: true, result });
        };
        serial = serial
          .then(task)
          .catch(() => {
            try {
              sessions.read();
            } catch {
              fatal = new Error("Controller durability is unknown.");
              shutdown();
            }
            send({ version: 1, id: request.id, ok: false, error: "request-unavailable" });
          })
          .finally(() => {
            pending = false;
          });
      });
    });
    let finish: () => void = () => {};
    const shutdown = () => {
      monitor?.stop();
      for (const socket of sockets) socket.destroy();
      server.close(finish);
    };
    let tickQueued = false;
    const timer = setInterval(() => {
      if (tickQueued) return;
      tickQueued = true;
      serial = serial
        .then(() => {
          sessions.tick(monotonic(), Date.now());
          monitor?.tick();
        })
        .catch(() => {
          fatal = new Error("Controller state unavailable.");
          shutdown();
        })
        .finally(() => {
          tickQueued = false;
        });
    }, 1000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      fs.chmodSync(socketPath, 0o600);
      await new Promise<void>((resolve) => {
        finish = resolve;
        options.signal.addEventListener("abort", shutdown, { once: true });
        if (options.signal.aborted) shutdown();
        else options.onListening?.();
      });
      await serial;
      if (fatal) throw fatal;
    } finally {
      clearInterval(timer);
      monitor?.stop();
      options.signal.removeEventListener("abort", shutdown);
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
