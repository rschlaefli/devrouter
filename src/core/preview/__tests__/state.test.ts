import { describe, expect, it, vi } from "vitest";
import { PreviewStateConflict, updatePreviewState } from "../state";
import { AzureBlobPreviewState } from "../state/azure-blob";

function validate(value: unknown): { count: number } {
  if (
    !value ||
    typeof value !== "object" ||
    !("count" in value) ||
    !Number.isSafeInteger(value.count)
  ) {
    throw new Error("Invalid state.");
  }
  return value as { count: number };
}

function fixture() {
  let bytes: string | undefined;
  let revision = 0;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "GET")
      return bytes === undefined
        ? new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } })
        : new Response(bytes, { status: 200, headers: { etag: `"${revision}"` } });
    const expected = headers.get("If-Match");
    if (expected !== null ? expected !== `"${revision}"` : bytes !== undefined) {
      return new Response(null, { status: 412 });
    }
    bytes = String(init?.body);
    revision += 1;
    return new Response(null, { status: 201, headers: { etag: `"${revision}"` } });
  });
  const store = new AzureBlobPreviewState({
    containerUrl: "https://examplestore.blob.core.windows.net/previews",
    accessToken: async () => "synthetic-token",
    fetch: request,
  });
  return { store, request };
}

describe("conditional preview state", () => {
  it("creates conditionally and rejects stale writes without overwriting newer state", async () => {
    const { store, request } = fixture();
    expect(await store.read("pool/test", validate)).toBeNull();
    const version = await store.compareAndSwap("pool/test", null, { count: 1 });
    await expect(store.compareAndSwap("pool/test", null, { count: 9 })).rejects.toBeInstanceOf(
      PreviewStateConflict,
    );
    const outcomes = await Promise.allSettled([
      store.compareAndSwap("pool/test", version, { count: 2 }),
      store.compareAndSwap("pool/test", version, { count: 3 }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.read("pool/test", validate))?.value).toEqual({ count: 2 });
    const headers = new Headers(request.mock.calls[1]?.[1]?.headers);
    expect(headers.get("If-None-Match")).toBe("*");
    expect(headers.get("x-ms-blob-type")).toBe("BlockBlob");
  });

  it("re-evaluates pure updates against the latest conditional version", async () => {
    const { store } = fixture();
    await store.compareAndSwap("pool/test", null, { count: 0 });
    await Promise.all(
      [1, 2].map(() =>
        updatePreviewState({
          store,
          key: "pool/test",
          validate,
          update: (current) => ({ count: (current?.count ?? 0) + 1 }),
        }),
      ),
    );
    expect((await store.read("pool/test", validate))?.value.count).toBe(2);
    await expect(
      updatePreviewState({
        store: fixture().store,
        key: "missing",
        validate,
        update: () => ({ count: 0 }),
      }),
    ).rejects.toThrow();
  });

  it("never treats forbidden, missing-container or invalid state as an absent store", async () => {
    const { store, request } = fixture();
    for (const status of [401, 403, 404, 500]) {
      request.mockResolvedValueOnce(new Response(null, { status }));
      await expect(store.read("pool/test", validate)).rejects.toThrow();
    }
    request.mockResolvedValueOnce(
      new Response('{"count":"invalid"}', { headers: { etag: '"1"' } }),
    );
    await expect(store.read("pool/test", validate)).rejects.toThrow();
    request.mockResolvedValueOnce(new Response("{}"));
    await expect(store.read("pool/test", validate)).rejects.toThrow();
  });

  it("rejects credentials in endpoints, escaping keys, oversized state and redirects", async () => {
    for (const url of [
      "http://example.org/data",
      "https://user:password@example.org/data",
      "https://examplestore.blob.core.windows.net/previews?sig=secret",
    ]) {
      expect(
        () => new AzureBlobPreviewState({ containerUrl: url, accessToken: async () => "x" }),
      ).toThrow();
    }
    const { store, request } = fixture();
    await expect(store.read("../other", validate)).rejects.toThrow();
    await expect(
      store.compareAndSwap("pool/test", null, { data: "x".repeat(1024 * 1024) }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(store.read("pool/test", validate)).rejects.toThrow();
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
