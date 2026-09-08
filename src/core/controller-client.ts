import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { CONTROLLER_FRAME_BYTES, parseControllerRequest } from "./controller-protocol";

export async function controllerRequest(
  directory: string,
  input: object,
  emit: (value: unknown) => void,
): Promise<void> {
  const request = parseControllerRequest({ ...input, version: 1, id: randomUUID() });
  const socketPath = path.join(directory, "control.sock");
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Controller socket is not private.");
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let handshake = false;
    let completed = false;
    const handshakeId = randomUUID();
    const timeout =
      request.method === "watch" || request.method === "operation-watch"
        ? Math.min(request.timeout + 5, 2_147_483) * 1000
        : 5000;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Controller response deadline exceeded."));
    }, timeout);
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, id: handshakeId, method: "handshake" })}\n`),
    );
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Controller unavailable."));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!completed) reject(new Error("Controller continuity lost."));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > CONTROLLER_FRAME_BYTES) socket.destroy();
          return;
        }
        if (newline > CONTROLLER_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const response = JSON.parse(frame.toString("utf8"));
          if (
            response?.version !== 1 ||
            response.id !== (handshake ? request.id : handshakeId) ||
            response.ok !== true
          )
            throw new Error("Controller rejected request.");
          if (!handshake) {
            handshake = true;
            socket.write(`${JSON.stringify(request)}\n`);
          } else {
            emit(response);
            if (request.method !== "watch" || response.result?.kind === "end") {
              completed = true;
              clearTimeout(timer);
              socket.end();
              resolve();
            }
          }
        } catch {
          socket.destroy();
          reject(new Error("Controller response unavailable or invalid."));
          return;
        }
      }
    });
  });
}
