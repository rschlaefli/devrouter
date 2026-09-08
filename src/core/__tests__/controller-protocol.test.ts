import { describe, expect, it } from "vitest";
import {
  CONTROLLER_FRAME_BYTES,
  type ControllerRequest,
  parseControllerRequest,
} from "../controller-protocol";

const BASE_IDS = {
  id: "request-1",
  session: "session-1",
  store: "store-1",
  generation: "generation-1",
};

function request(method: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, id: BASE_IDS.id, method, ...fields };
}

function expectInvalid(value: unknown): void {
  expect(() => parseControllerRequest(value)).toThrow();
}

describe("parseControllerRequest", () => {
  it("requires a bounded operation ID and complete session binding for operation status", () => {
    const valid = request("operation-status", {
      session: BASE_IDS.session,
      store: BASE_IDS.store,
      epoch: 1,
      generation: BASE_IDS.generation,
      operationId: "operation-1",
    });
    expect(parseControllerRequest(valid)).toEqual(valid);
    for (const field of ["session", "store", "epoch", "generation", "operationId"]) {
      const missing = { ...valid };
      delete missing[field];
      expectInvalid(missing);
    }
    expectInvalid({ ...valid, operationId: "../other" });
    expectInvalid({ ...valid, operationId: "x".repeat(129) });
    expectInvalid({ ...valid, path: "/another/checkout" });
  });

  it("parses every protocol method into its discriminated shape", () => {
    const requests: unknown[] = [
      request("handshake"),
      request("observe", {
        path: "/workspaces/example",
        session: BASE_IDS.session,
        profile: "manage,pwa",
        require: ["runtime", "app:web"],
      }),
      request("renew", {
        session: BASE_IDS.session,
        store: BASE_IDS.store,
        epoch: 4,
        generation: BASE_IDS.generation,
      }),
      request("release", {
        session: BASE_IDS.session,
        store: BASE_IDS.store,
        epoch: 4,
        generation: BASE_IDS.generation,
      }),
      request("status", { session: BASE_IDS.session, cursor: "4:12" }),
      request("watch", {
        session: BASE_IDS.session,
        store: BASE_IDS.store,
        epoch: 4,
        generation: BASE_IDS.generation,
        after: "4:11",
        afterStore: BASE_IDS.store,
        timeout: 5,
      }),
    ];

    const parsed = requests.map((value) => parseControllerRequest(value));
    expect(parsed.map((value) => value.method)).toEqual([
      "handshake",
      "observe",
      "renew",
      "release",
      "status",
      "watch",
    ]);

    const observe = parsed[1] as Extract<ControllerRequest, { method: "observe" }>;
    expect(observe.require).toEqual(["runtime", "app:web"]);
    expect(observe.profile).toBe("manage,pwa");
  });

  it("rejects unsupported versions, methods, and fields without reflecting input", () => {
    expectInvalid(request("handshake", { extra: "secret-value" }));
    expectInvalid({ ...request("handshake"), version: 2 });
    expectInvalid(request("unknown-method"));

    try {
      parseControllerRequest(request("handshake", { extra: "secret-value" }));
      throw new Error("expected parser to reject the request");
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
      expect(String(error).length).toBeLessThan(200);
    }
  });

  it("requires the handshake to contain no method-specific arguments", () => {
    expectInvalid(request("handshake", { session: BASE_IDS.session }));
    expectInvalid({ version: 1, id: BASE_IDS.id });
    expectInvalid({ version: 1, id: BASE_IDS.id, method: "handshake", extra: undefined });
  });

  it("enforces the frame bound before accepting a request", () => {
    const oversized = request("status", { cursor: "x".repeat(CONTROLLER_FRAME_BYTES) });
    expect(() => parseControllerRequest(oversized)).toThrow(
      "Controller request frame exceeds the maximum size.",
    );
  });

  it("accepts unique runtime and app selectors up to the limit", () => {
    const requirements = [
      "runtime",
      ...Array.from({ length: 15 }, (_, index) => `app:app-${index}`),
    ];
    const parsed = parseControllerRequest(
      request("observe", {
        path: "/workspaces/example",
        session: BASE_IDS.session,
        profile: "full",
        require: requirements,
      }),
    );

    expect(parsed).toMatchObject({ method: "observe", require: requirements });
    expectInvalid(
      request("observe", {
        path: "/workspaces/example",
        session: BASE_IDS.session,
        profile: "full",
        require: [...requirements, "app:too-many"],
      }),
    );
  });

  it("rejects duplicate and malformed selectors", () => {
    const fields = {
      path: "/workspaces/example",
      session: BASE_IDS.session,
      profile: "full",
    };
    expectInvalid(request("observe", { ...fields, require: ["runtime", "runtime"] }));
    expectInvalid(request("observe", { ...fields, require: ["app:bad.name"] }));
    expectInvalid(request("observe", { ...fields, require: ["process:web"] }));
    expectInvalid(request("observe", { ...fields, require: [] }));
  });

  it("requires bounded safe IDs, positive safe epochs, and valid paths", () => {
    const common = {
      session: BASE_IDS.session,
      store: BASE_IDS.store,
      epoch: 1,
      generation: BASE_IDS.generation,
    };
    expectInvalid(request("renew", { ...common, generation: "bad generation" }));
    expectInvalid(request("renew", { ...common, epoch: 0 }));
    expectInvalid(request("renew", { ...common, epoch: Number.MAX_SAFE_INTEGER + 1 }));
    expectInvalid(request("renew", { ...common, session: "x".repeat(129) }));
    expectInvalid(
      request("observe", {
        path: "relative/path",
        session: BASE_IDS.session,
        profile: "full",
        require: ["runtime"],
      }),
    );
    expectInvalid(
      request("observe", {
        path: "/workspaces/example\u0000/child",
        session: BASE_IDS.session,
        profile: "full",
        require: ["runtime"],
      }),
    );
  });

  it("keeps optional status and watch fields optional while validating present values", () => {
    expect(parseControllerRequest(request("status"))).toEqual({
      version: 1,
      id: BASE_IDS.id,
      method: "status",
    });
    expectInvalid(request("status", { cursor: "\u0000" }));
    expectInvalid(
      request("watch", {
        session: BASE_IDS.session,
        store: BASE_IDS.store,
        epoch: 1,
        generation: "bad generation",
        timeout: 0,
      }),
    );
    expectInvalid(
      request("watch", {
        session: BASE_IDS.session,
        store: BASE_IDS.store,
        epoch: 1,
        generation: BASE_IDS.generation,
        timeout: -1,
      }),
    );
  });
});
