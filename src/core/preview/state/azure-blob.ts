import {
  PreviewStateConflict,
  type PreviewStateStore,
  type StateRecord,
  validateStateKey,
} from "../state";

const MAX_STATE_BYTES = 1024 * 1024;

function requireETag(value: string | null): string {
  if (!value || !/^"[^"\r\n]+"$/.test(value) || value.length > 256) {
    throw new Error("Preview state response has no strong ETag.");
  }
  return value;
}

async function readBounded(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_STATE_BYTES)) {
    await response.body?.cancel();
    throw new Error("Preview state response exceeds its size bound.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Preview state response is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STATE_BYTES) throw new Error("Preview state response exceeds its size bound.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class AzureBlobPreviewState implements PreviewStateStore {
  private readonly container: URL;
  private readonly request: typeof fetch;

  constructor(
    private readonly options: {
      containerUrl: string;
      accessToken: () => Promise<string>;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.containerUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
      !/^\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(url.pathname)
    )
      throw new Error(
        "Preview state requires an Azure public-cloud HTTPS container URL without credentials.",
      );
    this.container = url;
    this.request = options.fetch ?? fetch;
  }

  private async call(
    key: string,
    method: "GET" | "PUT",
    extra: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    validateStateKey(key);
    const token = await this.options.accessToken();
    if (!token || /\s/.test(token)) throw new Error("Preview state access token is unavailable.");
    const url = new URL(this.container.toString());
    url.pathname += `/${key}`;
    try {
      return await this.request(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-ms-version": "2023-11-03",
          "x-ms-date": new Date().toUTCString(),
          ...extra,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Preview state transport failed; write outcome may be uncertain.");
    }
  }

  async read<T>(key: string, validate: (value: unknown) => T): Promise<StateRecord<T> | null> {
    const response = await this.call(key, "GET", { "Cache-Control": "no-cache" });
    if (response.status === 404 && response.headers.get("x-ms-error-code") === "BlobNotFound") {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Preview state read failed (HTTP ${response.status}).`);
    }
    const version = requireETag(response.headers.get("etag"));
    return { version, value: validate(JSON.parse(await readBounded(response))) };
  }

  async compareAndSwap<T>(key: string, expectedVersion: string | null, value: T): Promise<string> {
    const body = JSON.stringify(value);
    if (!body || Buffer.byteLength(body) > MAX_STATE_BYTES)
      throw new Error("Preview state exceeds its size bound.");
    const response = await this.call(
      key,
      "PUT",
      {
        "Content-Type": "application/json",
        "x-ms-blob-type": "BlockBlob",
        ...(expectedVersion === null
          ? { "If-None-Match": "*" }
          : { "If-Match": requireETag(expectedVersion) }),
      },
      body,
    );
    await response.body?.cancel();
    if (response.status === 412) throw new PreviewStateConflict();
    if (response.status !== 201)
      throw new Error(
        `Preview state write failed (HTTP ${response.status}); outcome must be reconciled.`,
      );
    return requireETag(response.headers.get("etag"));
  }
}
