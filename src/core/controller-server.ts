import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  ControllerMonitor,
  type ControllerObservationCollector,
  type ControllerRecovery,
  controllerCapability,
} from "./controller-monitor";
import { type ControllerRequest, parseControllerRequest } from "./controller-protocol";
import { ControllerSessions } from "./controller-sessions";
import {
  type ControllerEnvironment,
  type ControllerSnapshot,
  ControllerStore,
} from "./controller-store";
import { withFileLock } from "./file-lock";
import { readLifecycleOperationStatus } from "./lifecycle-operation-status";
import type { ReliabilityConsumer } from "./reliability-contract";
import {
  readReliabilityOperation,
  setReliabilityHumanPin,
  withReliabilityObservationFence,
} from "./reliability-operation-store";

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
  capturePersisted?: (revalidate: () => boolean) => void,
) => Promise<ControllerEnvironment>;

/**
 * Synchronous liveness proof for one consumer binding. It ticks the controller
 * clocks, validates the exact store/epoch/generation binding against the
 * expected environment, and derives a bounded consumer identity from the
 * session identity plus requirements. It never awaits, so a caller that runs it
 * immediately before enqueue cannot be interleaved with a later release or
 * expiry, and watch or recovery never reuse it.
 */
export type ControllerSessionValidator = () => ReliabilityConsumer;

function sessionConsumer(input: {
  store: string;
  epoch: number;
  session: string;
  generation: string;
  requirements: string[];
}): ReliabilityConsumer {
  const { store, epoch, session, generation, requirements } = input;
  const requiredCapabilities = [...new Set(requirements)].sort().map(controllerCapability);
  // Hash only the session identity: every request from one session keeps the
  // same consumer, so a reconnect under the same generation stays idempotent.
  const id = `session-${createHash("sha256")
    .update(JSON.stringify([store, epoch, session, generation]))
    .digest("hex")}`;
  return { id, requiredCapabilities, pinned: false };
}

export type ControllerOperations = {
  tick?: () => Promise<void>;
  close?: () => void;
  recover?: ControllerRecovery;
  submit: (
    request: Extract<ControllerRequest, { method: "operation-submit" }>,
    environment: ControllerEnvironment,
    signal: AbortSignal,
    validate: ControllerSessionValidator,
  ) => Promise<unknown>;
  watch: (
    request: Extract<ControllerRequest, { method: "operation-watch" }>,
    environment: ControllerEnvironment,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export type ControllerStartup = {
  directory: string;
  store: string;
  epoch: number;
  consumeStartup: (directory: string) => void;
};
export async function runController(options: {
  directory: string;
  signal: AbortSignal;
  resolve: ControllerResolver;
  collect?: ControllerObservationCollector;
  onListening?: () => void;
  operations?: ControllerOperations;
  createOperations?: (controller: ControllerStartup) => ControllerOperations | undefined;
}): Promise<void> {
  if (options.operations && options.createOperations)
    throw new Error("Controller operations have multiple owners.");
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
  const store = new ControllerStore(options.directory, undefined, true);
  store.assertStartup();
  await withFileLock(lockPath, { activity: "controller ownership", waitMs: 0 }, async () => {
    const staleSocket = validateOwnedFile(socketPath, true);
    const sessions = new ControllerSessions(store);
    if (staleSocket) fs.unlinkSync(socketPath);
    const incarnation = sessions.read();
    let startupAvailable = true;
    let operations: ControllerOperations | undefined;
    try {
      operations =
        options.createOperations?.({
          directory: options.directory,
          store: incarnation.store,
          epoch: incarnation.epoch,
          consumeStartup: (directory) => {
            if (!startupAvailable || directory !== options.directory)
              throw new Error("Controller startup authority is unavailable.");
            startupAvailable = false;
          },
        }) ?? options.operations;
    } finally {
      startupAvailable = false;
    }
    const sockets = new Set<net.Socket>();
    let serial = Promise.resolve();
    const monotonic = () => Math.floor(performance.now());
    let fatal: Error | undefined;
    const monitor = options.collect
      ? new ControllerMonitor(
          sessions,
          options.collect,
          (operation) => {
            const pending = serial.then(operation);
            serial = pending.catch(() => {});
            return pending;
          },
          undefined,
          undefined,
          operations?.recover,
        )
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
        const events = snapshot.events.filter(
          (event) =>
            event.sequence > sequence &&
            event.session === request.session &&
            event.generation === request.generation,
        );
        for (const event of events)
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
        return events.length;
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
            const oldest = snapshot.events[0]?.sequence ?? snapshot.nextSequence;
            const gap = subscription.sequence < oldest - 1;
            if (gap || replay(snapshot, subscription.request, subscription.sequence)) {
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
                  kind: gap ? "gap" : "snapshot",
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
        if (request.method === "protection-status" || request.method === "protection-pin") {
          const protectionRequest = request;
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          const expiresAt = monotonic() + 3000;
          const deadline = setTimeout(cancel, 3000);
          socket.once("close", cancel);
          options.signal.addEventListener("abort", cancel, { once: true });
          const assertActive = () => {
            if (
              cancellation.signal.aborted ||
              options.signal.aborted ||
              socket.destroyed ||
              monotonic() >= expiresAt
            )
              throw new Error("Protection request expired or cancelled.");
          };
          const initial = serial.then(() => {
            assertActive();
            sessions.tick(monotonic(), Date.now());
            const session = sessions.validate(protectionRequest);
            const environment = sessions
              .read()
              .environments.find((entry) => entry.id === session.environmentId);
            if (!environment) throw new Error("Protection environment unavailable.");
            const identity = {
              repoPath: environment.repoPath,
              workspace: environment.workspace || null,
              provider: environment.provider,
            };
            const journal = readReliabilityOperation(identity);
            if (!journal) throw new Error("Protection journal unavailable.");
            return {
              environment,
              identity,
              revision: journal.revision,
              requirements: session.requirements,
            };
          });
          serial = initial.then(
            () => {},
            () => {},
          );
          void initial
            .then(async ({ environment, identity, revision, requirements }) => {
              let persisted: (() => boolean) | undefined;
              const resolved = await options.resolve(
                {
                  path: environment.repoPath,
                  profile: environment.profile,
                  require: requirements,
                },
                cancellation.signal,
                (validator) => {
                  persisted = validator;
                },
              );
              assertActive();
              if (!persisted || JSON.stringify(resolved) !== JSON.stringify(environment))
                throw new Error("Protection ownership evidence unavailable or changed.");
              const proof = persisted;
              const finish = serial.then(() => {
                const revalidate = () => {
                  assertActive();
                  sessions.tick(monotonic(), Date.now());
                  const session = sessions.validate(protectionRequest);
                  const current = sessions
                    .read()
                    .environments.find((entry) => entry.id === session.environmentId);
                  if (JSON.stringify(current) !== JSON.stringify(environment) || !proof())
                    throw new Error("Protection persisted ownership changed.");
                };
                let demand: ReturnType<ControllerSessions["protection"]> | undefined;
                const validate = () => {
                  revalidate();
                  demand = sessions.protection(environment, monotonic(), Date.now());
                };
                const receipt =
                  protectionRequest.method === "protection-pin"
                    ? setReliabilityHumanPin(
                        identity,
                        revision,
                        protectionRequest.expectedProtectionRevision,
                        protectionRequest.pinned,
                        validate,
                      )
                    : withReliabilityObservationFence(identity, revision, (journal) => {
                        validate();
                        return {
                          journalRevision: journal.revision,
                          parkingObservation:
                            monitor?.parkingObservation(environment, journal) ??
                            "observation-unavailable",
                          protection: journal.consumerProtection ?? {
                            version: 1,
                            revision: 0,
                            humanPinned: false,
                          },
                        };
                      });
                send({
                  version: 1,
                  id: protectionRequest.id,
                  ok: true,
                  result: { ...receipt, ...demand },
                });
              });
              serial = finish.catch(() => {});
              await finish;
            })
            .catch(() => {
              if (!socket.destroyed)
                send({
                  version: 1,
                  id: protectionRequest.id,
                  ok: false,
                  error: "request-unavailable",
                });
            })
            .finally(() => {
              clearTimeout(deadline);
              socket.removeListener("close", cancel);
              options.signal.removeEventListener("abort", cancel);
              pending = false;
            });
          return;
        }
        if (request.method === "operation-submit" || request.method === "operation-watch") {
          const operationRequest = request;
          const abort = new AbortController();
          const cancel = () => abort.abort();
          socket.once("close", cancel);
          options.signal.addEventListener("abort", cancel, { once: true });
          const timeout =
            operationRequest.method === "operation-watch"
              ? operationRequest.timeout * 1000 + 1000
              : 3000;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          let environment: ControllerEnvironment;
          const validate = serial.then(() => {
            if (!operations) throw new Error("Managed operations unavailable.");
            sessions.tick(monotonic(), Date.now());
            const session = sessions.validate(operationRequest);
            const bound = sessions
              .read()
              .environments.find((entry) => entry.id === session.environmentId);
            if (!bound) throw new Error("Session environment is unavailable.");
            environment = bound;
          });
          serial = validate.catch(() => {});
          void validate
            .then(async () => {
              if (abort.signal.aborted || socket.destroyed)
                throw new Error("Operation client detached.");
              if (!operations) throw new Error("Managed operations unavailable.");
              const handler =
                operationRequest.method === "operation-submit"
                  ? operations.submit(operationRequest, environment, abort.signal, () => {
                      // Revalidate the original binding immediately before submission.
                      if (abort.signal.aborted)
                        throw new Error("Session validation was cancelled.");
                      sessions.tick(monotonic(), Date.now());
                      const session = sessions.validate(operationRequest);
                      const bound = sessions
                        .read()
                        .environments.find((entry) => entry.id === session.environmentId);
                      if (!bound || JSON.stringify(bound) !== JSON.stringify(environment))
                        throw new Error("Session environment binding changed.");
                      return sessionConsumer({
                        store: operationRequest.store,
                        epoch: operationRequest.epoch,
                        session: operationRequest.session,
                        generation: operationRequest.generation,
                        requirements: session.requirements,
                      });
                    })
                  : operations.watch(operationRequest, environment, abort.signal);
              const result = await Promise.race([
                handler,
                new Promise<never>((_resolve, reject) => {
                  deadline = setTimeout(() => {
                    cancel();
                    reject(new Error("Operation response deadline exceeded."));
                  }, timeout);
                }),
              ]);
              if (!socket.destroyed)
                send({ version: 1, id: operationRequest.id, ok: true, result });
            })
            .catch((error: unknown) => {
              // Operators otherwise see only the generic refusal; mirror the
              // bounded single-line cause pattern used by controller commands.
              const cause = (error instanceof Error ? error.message : String(error))
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 300);
              if (cause) process.stderr.write(`controller operation failed: ${cause}\n`);
              if (!socket.destroyed)
                send({
                  version: 1,
                  id: operationRequest.id,
                  ok: false,
                  error: "request-unavailable",
                });
            })
            .finally(() => {
              clearTimeout(deadline);
              socket.removeListener("close", cancel);
              options.signal.removeEventListener("abort", cancel);
              pending = false;
            });
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
            const expiresAt = monotonic() + 3000;
            const deadline = setTimeout(() => {
              abort();
              rejectDeadline(new Error("Resolver deadline exceeded."));
            }, 3000);
            try {
              let persisted: (() => boolean) | undefined;
              const environment = await Promise.race([
                options.resolve(
                  request,
                  controller.signal,
                  request.reconnect
                    ? (proof) => {
                        persisted = proof;
                      }
                    : undefined,
                ),
                timedOut,
              ]);
              if (controller.signal.aborted || socket.destroyed)
                throw new Error("Observation binding unavailable.");
              if (request.reconnect) {
                if (
                  options.signal.aborted ||
                  monotonic() >= expiresAt ||
                  !persisted ||
                  !persisted()
                )
                  throw new Error("Reconnect ownership evidence unavailable or changed.");
                result = sessions.reconnect(
                  request.reconnect,
                  environment,
                  request.require,
                  monotonic(),
                  Date.now(),
                );
              } else {
                result = sessions.acquire(
                  request.session,
                  environment,
                  request.require,
                  monotonic(),
                  Date.now(),
                );
              }
            } finally {
              clearTimeout(deadline);
              socket.removeListener("close", abort);
            }
          } else if (request.method === "parking-consent") {
            result = sessions.setParkingConsent(
              request,
              request.expectedConsentRevision,
              request.parkingConsent,
              monotonic(),
              Date.now(),
            );
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
          } else if (request.method === "operation-status") {
            const session = sessions.validate(request);
            const environment = sessions
              .read()
              .environments.find((entry) => entry.id === session.environmentId);
            if (!environment) throw new Error("Session environment is unavailable.");
            result = {
              operation:
                readLifecycleOperationStatus(
                  {
                    repoPath: environment.repoPath,
                    workspace: environment.workspace || null,
                    provider: environment.provider,
                  },
                  request.operationId,
                ) ?? null,
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
    let shuttingDown = false;
    let operationTick: Promise<void> | undefined;
    let operationsClosed = false;
    const closeOperations = () => {
      if (operationsClosed) return;
      operationsClosed = true;
      try {
        operations?.close?.();
      } catch {
        fatal = new Error("Controller operation shutdown failed.");
      }
    };
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      monitor?.stop();
      closeOperations();
      for (const socket of sockets) socket.destroy();
      server.close(finish);
    };
    let tickQueued = false;
    const timer = setInterval(() => {
      if (tickQueued) return;
      tickQueued = true;
      serial = serial
        .then(() => {
          if (shuttingDown) return;
          sessions.tick(monotonic(), Date.now());
          monitor?.tick();
          if (operations?.tick && !operationTick) {
            operationTick = Promise.resolve()
              .then(() => operations.tick?.())
              .catch(() => {
                // Failed collection grants no renewed authority; observation remains available.
              })
              .finally(() => {
                operationTick = undefined;
              });
          }
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
      closeOperations();
      options.signal.removeEventListener("abort", shutdown);
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
