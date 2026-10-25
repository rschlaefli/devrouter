import { describe, expect, it } from "vitest";
import { NorthflankOutcomeUncertain, NorthflankPreviewAPI } from "../providers/northflank-api";

const page = (rows: unknown[], next = false, cursor?: string) =>
  new Response(
    JSON.stringify({
      data: { runs: rows },
      pagination: { hasNextPage: next, count: rows.length, cursor },
    }),
  );

describe("Northflank preview transport", () => {
  it("scopes credentials to the configured project and refuses redirects/path traversal", async () => {
    let calls = 0;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async (url, init) => {
        calls += 1;
        expect(String(url)).toBe(
          "https://api.northflank.com/v1/projects/isolated/preview-blueprints/owned/runs?per_page=100",
        );
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic" });
        return page([]);
      },
    });
    expect(await api.list(["preview-blueprints", "owned", "runs"], "runs")).toEqual([]);
    await expect(api.request("GET", ["preview-blueprints", "../other"])).rejects.toThrow();
    await expect(api.request("GET", ["services"])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("detects repeated pagination cursors rather than proving partial absence", async () => {
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => page([], true, "a".repeat(24)),
    });
    await expect(api.list(["preview-blueprints", "owned", "runs"], "runs")).rejects.toThrow(
      "cursor",
    );
  });

  it("keeps uncertain mutation outcomes without retrying or returning secret response text", async () => {
    let calls = 0;
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => {
        calls += 1;
        throw new Error("private-response");
      },
    });
    await expect(api.request("POST", ["preview-blueprints", "owned", "runs"], {})).rejects.toThrow(
      "uncertain",
    );
    expect(calls).toBe(1);
  });

  it("suppresses malformed response content and marks all uncertain writes", async () => {
    for (const status of [200, 504]) {
      const api = new NorthflankPreviewAPI({
        projectId: "isolated",
        accessToken: async () => "synthetic",
        fetch: async () => new Response("private-response-sentinel", { status }),
      });
      try {
        await api.request("POST", ["preview-blueprints", "owned", "runs"], {});
        throw new Error("Expected uncertainty");
      } catch (error) {
        expect(error).toBeInstanceOf(NorthflankOutcomeUncertain);
        expect((error as Error).message).not.toContain("private-response-sentinel");
      }
    }
  });

  it("bounds chunked responses without trusting Content-Length", async () => {
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async () => new Response("a".repeat(1024 * 1024 + 1)),
    });
    await expect(api.request("GET", ["preview-blueprints", "owned"])).rejects.toThrow("size bound");
  });

  it("derives remaining minutes from a fixed target and refuses a later provider expiry", async () => {
    const target = 1_700_000_000_000;
    let returned = target - 10_000;
    const lifetimes: number[] = [];
    const api = new NorthflankPreviewAPI({
      projectId: "isolated",
      accessToken: async () => "synthetic",
      fetch: async (_url, init) => {
        lifetimes.push(JSON.parse(init!.body as string).lifetime);
        return new Response(
          JSON.stringify({ data: { expiryTime: new Date(returned).toISOString() } }),
        );
      },
    });
    expect(await api.resetDeadline("owned", "preview", target, target - 3_630_000)).toBe(returned);
    returned = target + 1;
    await expect(
      api.resetDeadline("owned", "preview", target, target - 3_570_000),
    ).rejects.toBeInstanceOf(NorthflankOutcomeUncertain);
    expect(lifetimes).toEqual([60, 59]);
  });
});
