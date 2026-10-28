import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type {
  PreviewImageBackend,
  PreviewImagePlatform,
  PreviewImageProducerIdentity,
} from "./images";
import { preparePreviewImageRequest, resolvePreviewImages } from "./images";
import { object, type PreviewPoolEntry } from "./state";

/** Operator-installed JSON adapter; candidate source cannot choose its executable or environment. */
export function commandImageBackend(options: {
  command: string[];
  files: Array<{ path: string; sha256: string }>;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  producer: PreviewImageProducerIdentity;
  platform: PreviewImagePlatform;
  context: (entry: PreviewPoolEntry) => Record<string, Record<string, string>>;
}): PreviewImageBackend {
  if (
    !options.command.length ||
    options.command.length > 32 ||
    !options.files.length ||
    options.command.some((arg) => !arg || arg.length > 4096 || arg.includes("\0"))
  )
    throw new Error("Invalid installed image resolver command.");
  const verify = () => {
    for (const file of options.files) {
      const stat = fs.lstatSync(file.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 1024 * 1024 ||
        createHash("sha256").update(fs.readFileSync(file.path)).digest("hex") !== file.sha256
      )
        throw new Error("Installed image resolver fingerprint differs.");
    }
  };
  verify();
  return {
    async prepare(entry, gate) {
      const prepared = preparePreviewImageRequest(entry.plan, {
        revision: entry.session.desiredRevision,
        platform: options.platform,
        configurations: options.context(entry),
      });
      const correlation = createHash("sha256")
        .update(
          JSON.stringify([
            entry.identity,
            entry.session.generation,
            entry.session.operationVersion,
            prepared.request,
          ]),
        )
        .digest("hex");
      const invoke = (action: "resolve" | "dispatch", missing: string[] = []) => {
        verify();
        const input = JSON.stringify({
          action,
          correlation,
          request: prepared.request,
          producer: options.producer,
          missing,
          pinnedImages: [
            ...new Set(
              entry.plan.resources.flatMap((resource) => (resource.image ? [resource.image] : [])),
            ),
          ],
        });
        if (Buffer.byteLength(input) > 1024 * 1024)
          throw new Error("Image request exceeds its bound.");
        const result = spawnSync(options.command[0], options.command.slice(1), {
          shell: false,
          cwd: options.cwd,
          encoding: "utf8",
          input,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: options.environment,
        });
        if (result.error || result.status !== 0)
          throw new Error("Installed image resolver failed; output suppressed.");
        return JSON.parse(result.stdout) as unknown;
      };
      const resolved = object(invoke("resolve"), ["receipts"], ["pending"]);
      const outcome = resolvePreviewImages(entry.plan, prepared, options.producer, {
        receipts: resolved.receipts,
      });
      if (outcome.status === "ready") return { phase: "ready", plan: outcome.plan };
      if (resolved.pending !== undefined && typeof resolved.pending !== "boolean")
        throw new Error("Invalid image resolver pending status.");
      // Recording intent precedes dispatch. Once uncertain, an empty search is observation only.
      const step = await gate.begin("ci-images", "once", correlation);
      if (step === "fenced") return { phase: "pending" };
      if (step === "write") {
        try {
          if (!resolved.pending)
            invoke("dispatch", [
              ...new Set(outcome.missing.map((id) => prepared.resources[id].target)),
            ]);
          await gate.record("ci-images", "accepted", correlation);
        } catch {
          await gate.record("ci-images", "uncertain", correlation);
          throw new Error("CI dispatch outcome is uncertain; automatic redispatch is disabled.");
        }
      }
      return { phase: "pending" };
    },
  };
}
