import assert from "node:assert/strict";
import { parsePreviewCommand } from "../src/core/preview/command";
import { createPreviewSession, transitionPreviewSession } from "../src/core/preview/lifecycle";
import { updatePreviewState } from "../src/core/preview/state";
import { AzureBlobPreviewState } from "../src/core/preview/state/azure-blob";

const now = 1_700_000_000_000;
const revision = "a".repeat(40);
assert.equal(parsePreviewCommand("/preview start chat")?.kind, "start");
let session = createPreviewSession({
  generation: "synthetic",
  now,
  revision,
  aliases: ["chat"],
  commandId: "start-1",
});
session = transitionPreviewSession(session, {
  kind: "effect-started",
  now,
  generation: session.generation,
  operationVersion: session.operationVersion,
  operationId: "create-1",
});
session = transitionPreviewSession(session, { kind: "stop", now: now + 1, commandId: "stop-1" });
session = transitionPreviewSession(session, {
  kind: "cleanup-observed",
  ownershipVersion: session.ownershipVersion,
  now: now + 2,
  generation: session.generation,
  absent: true,
});
assert.equal(session.reservationHeld, true);
session = transitionPreviewSession(session, {
  kind: "effect-settled",
  now: now + 3,
  generation: session.generation,
  operationId: "create-1",
  resources: ["late-db"],
});
assert.deepEqual(session.ownedResources, ["late-db"]);
session = transitionPreviewSession(session, {
  kind: "cleanup-observed",
  ownershipVersion: session.ownershipVersion,
  now: now + 4,
  generation: session.generation,
  absent: false,
});
assert.equal(session.reservationHeld, true);
session = transitionPreviewSession(session, {
  kind: "cleanup-observed",
  ownershipVersion: session.ownershipVersion,
  now: now + 5,
  generation: session.generation,
  absent: true,
});
assert.equal(session.reservationHeld, false);
assert.equal(session.status, "stopped");

let bytes: string | undefined;
let version = 0;
const store = new AzureBlobPreviewState({
  containerUrl: "https://examplestore.blob.core.windows.net/previews",
  accessToken: async () => "synthetic-only",
  fetch: async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "GET")
      return bytes === undefined
        ? new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } })
        : new Response(bytes, { headers: { etag: `"${version}"` } });
    if (bytes !== undefined && headers.get("If-Match") !== `"${version}"`)
      return new Response(null, { status: 412 });
    bytes = String(init?.body);
    version += 1;
    return new Response(null, { status: 201, headers: { etag: `"${version}"` } });
  },
});
function validate(value: unknown): { count: number } {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      "count" in value &&
      Number.isSafeInteger(value.count),
  );
  return value as { count: number };
}

async function main() {
  await store.compareAndSwap("synthetic/pool", null, { count: 0 });
  await Promise.all(
    [1, 2].map(() =>
      updatePreviewState({
        store,
        key: "synthetic/pool",
        validate,
        update: (current) => ({ count: current.count + 1 }),
      }),
    ),
  );
  assert.equal((await store.read("synthetic/pool", validate))?.value.count, 2);
  process.stdout.write(
    `${JSON.stringify({
      previewControlQualification: "passed",
      transport: "simulated",
      liveProvider: false,
      lateAllocationHeld: true,
      conditionalWrites: true,
      finalState: session.status,
    })}\n`,
  );
}
main().catch(() => {
  process.stderr.write("Synthetic preview control qualification failed.\n");
  process.exitCode = 1;
});
