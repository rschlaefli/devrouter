import { readPreviewResponse } from "../http";
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
    return {
      version,
      value: validate(JSON.parse(await readPreviewResponse(response, "Preview state"))),
    };
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

/** Exchange a runner-issued workload assertion for a short-lived storage token. */
export function azureFederatedPreviewToken(options: {
  tenantId: () => Promise<string>;
  clientId: () => Promise<string>;
  assertion: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}): () => Promise<string> {
  let cached: { token: string; until: number } | undefined;
  return async () => {
    const now = options.now?.() ?? Date.now();
    if (cached && cached.until > now + 30_000) return cached.token;
    const tenant = await options.tenantId(),
      client = await options.clientId(),
      assertion = await options.assertion();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tenant) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(client) ||
      !assertion ||
      /\s/.test(assertion)
    )
      throw new Error("Invalid preview workload identity input.");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: client,
            scope: "https://storage.azure.com/.default",
            grant_type: "client_credentials",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion,
          }),
        },
      );
    } catch {
      throw new Error("Preview workload identity exchange failed.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Preview workload identity exchange failed (HTTP ${response.status}).`);
    }
    let token: unknown;
    try {
      token = JSON.parse(await readPreviewResponse(response, "Preview identity"));
    } catch {
      throw new Error("Preview workload identity reply is invalid.");
    }
    if (
      !token ||
      typeof token !== "object" ||
      !("access_token" in token) ||
      typeof token.access_token !== "string" ||
      !token.access_token ||
      /\s/.test(token.access_token) ||
      !("expires_in" in token) ||
      !Number.isSafeInteger(token.expires_in) ||
      (token.expires_in as number) < 60 ||
      (token.expires_in as number) > 86400
    )
      throw new Error("Preview workload identity reply is invalid.");
    cached = { token: token.access_token, until: now + (token.expires_in as number) * 1000 };
    return cached.token;
  };
}
