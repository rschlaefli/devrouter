import { AsyncLocalStorage } from "node:async_hooks";
import { readPreviewResponse } from "../http";
import { MAX_PREVIEW_DEADLINE_EARLINESS_MS } from "../lifecycle";

type NorthflankMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const MAX_BYTES = 1024 * 1024;
const MAX_COMMAND_ARGUMENTS = 32;
const MAX_COMMAND_ARGUMENT_BYTES = 4096;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_FRAME_BYTES = 16 * 1024;
const MAX_COMMAND_PROTOCOL_OVERHEAD_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 8192;
const MAX_COMMAND_TIMEOUT_MS = 20_000;
const COMMAND_FAILED_MESSAGE = "Northflank service command failed.";
const INVALID_COMMAND_MESSAGE = "Invalid Northflank service command request.";

const commandFailure = () => new Error(COMMAND_FAILED_MESSAGE);
const invalidCommand = () => new Error(INVALID_COMMAND_MESSAGE);

function validateCommandArguments(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_COMMAND_ARGUMENTS)
    throw invalidCommand();
  if (argv[0] === "") throw invalidCommand();
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== "string" || argument.includes("\0")) throw invalidCommand();
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_COMMAND_ARGUMENT_BYTES) throw invalidCommand();
    totalBytes += bytes;
  }
  if (totalBytes > MAX_COMMAND_BYTES) throw invalidCommand();
}

function commandMessageBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw commandFailure();
}

function commandMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (ArrayBuffer.isView(data))
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  throw commandFailure();
}

export function northflankIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value))
    throw new Error("Invalid Northflank resource identifier.");
  return value;
}

export function northflankRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Northflank response object.");
  return value as Record<string, unknown>;
}

export class NorthflankRejected extends Error {
  constructor(readonly status: number) {
    super(`Northflank rejected the request (HTTP ${status}).`);
  }
}

export class NorthflankOutcomeUncertain extends Error {
  constructor() {
    super("Northflank mutation outcome is uncertain and must be reconciled.");
    this.name = "NorthflankOutcomeUncertain";
  }
}

export class NorthflankRateLimited extends NorthflankOutcomeUncertain {
  constructor(
    readonly until: number,
    readonly exhausted: boolean,
  ) {
    super();
    this.name = "NorthflankRateLimited";
  }
}

/** Project-scoped transport. It never retries mutations or exposes response bodies in errors. */
export class NorthflankPreviewAPI {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly websocketFactory: (url: string) => WebSocket;
  private readonly deadlineMarginMs: number;
  private readonly cleanup = new AsyncLocalStorage<boolean>();
  private quota?: { remaining: number; resetAt: number };
  private exhaustedUntil = 0;
  private readonly now: () => number;
  readonly projectId: string;
  readonly domain?: string;

  constructor(
    private readonly options: {
      projectId: string;
      accessToken: () => Promise<string>;
      fetch?: typeof fetch;
      websocketFactory?: (url: string) => WebSocket;
      deadlineMarginMs?: number;
      domain?: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.projectId = northflankIdentifier(options.projectId);
    if (
      options.domain &&
      (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(options.domain) ||
        options.domain.length > 253)
    )
      throw new Error("Invalid Northflank domain read scope.");
    this.domain = options.domain;
    this.base = `https://api.northflank.com/v1/projects/${this.projectId}/`;
    this.fetch = options.fetch ?? fetch;
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url));
    const margin = options.deadlineMarginMs ?? 15_000;
    if (!Number.isSafeInteger(margin) || margin < 1 || margin > 15_000)
      throw new Error("Invalid Northflank deadline delay allowance.");
    this.deadlineMarginMs = margin;
  }

  withCleanup<T>(cleanup: boolean, action: () => Promise<T>): Promise<T> {
    return this.cleanup.run(cleanup, action);
  }

  private checkQuota() {
    const now = this.now();
    if (this.exhaustedUntil > now) throw new NorthflankRateLimited(this.exhaustedUntil, true);
    if (this.quota && this.quota.resetAt <= now) this.quota = undefined;
    if (this.quota) {
      if (this.quota.remaining <= (this.cleanup.getStore() ? 0 : 100))
        throw new NorthflankRateLimited(this.quota.resetAt, this.quota.remaining === 0);
      this.quota.remaining -= 1;
    }
  }

  private observeQuota(response: Response) {
    const now = this.now();
    const number = (name: string, max: number) => {
      const value = response.headers.get(name);
      return value !== null && /^\d{1,9}$/.test(value) && Number(value) <= max
        ? Number(value)
        : undefined;
    };
    const remaining = number("x-ratelimit-remaining", 1_000_000);
    const reset = number("x-ratelimit-reset", 86_400);
    if (remaining !== undefined) {
      const resetAt = now + Math.max(1, reset ?? 3600) * 1000;
      if (!this.quota || this.quota.resetAt <= now) this.quota = { remaining, resetAt };
      else {
        // An older concurrent response cannot restore consumed request capacity.
        this.quota.remaining = Math.min(this.quota.remaining, remaining);
        this.quota.resetAt = Math.max(this.quota.resetAt, resetAt);
      }
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = number("retry-after", 86_400);
      const date =
        retry &&
        seconds === undefined &&
        /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)
          ? Date.parse(retry)
          : NaN;
      const retryMs =
        seconds !== undefined
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.min(86_400_000, Math.max(1000, date - now))
            : 0;
      this.exhaustedUntil = Math.max(
        this.exhaustedUntil,
        now + Math.max(1000, retryMs, (reset ?? (retryMs ? 0 : 3600)) * 1000),
      );
      throw new NorthflankRateLimited(this.exhaustedUntil, true);
    }
  }

  async execServiceCommand(
    serviceId: string,
    argv: string[],
    bounds: { maxBytes: number; timeoutMs: number },
  ): Promise<string> {
    let service: string;
    try {
      service = northflankIdentifier(serviceId);
    } catch {
      throw invalidCommand();
    }
    validateCommandArguments(argv);
    this.checkQuota();
    if (
      !bounds ||
      !Number.isSafeInteger(bounds.maxBytes) ||
      bounds.maxBytes < 1 ||
      bounds.maxBytes > MAX_COMMAND_OUTPUT_BYTES ||
      !Number.isSafeInteger(bounds.timeoutMs) ||
      bounds.timeoutMs < 1 ||
      bounds.timeoutMs > MAX_COMMAND_TIMEOUT_MS
    )
      throw invalidCommand();
    const command = [...argv];

    let token: string;
    try {
      token = await this.options.accessToken();
    } catch {
      throw commandFailure();
    }
    if (!token || /\s/.test(token)) throw commandFailure();

    const url = `wss://api.northflank.com/v1/command-exec/projects/${this.projectId}/services/${service}`;
    let socket: WebSocket | undefined;
    try {
      socket = this.websocketFactory(url);
      socket.binaryType = "arraybuffer";
    } catch {
      try {
        socket?.close();
      } catch {
        // A failed socket setup cannot be repaired or retried.
      }
      throw commandFailure();
    }

    return new Promise<string>((resolve, reject) => {
      let authenticated = false;
      let completed = false;
      let terminal = false;
      let payloadBytes = 0;
      let inboundBytes = 0;
      const stdout: string[] = [];

      const removeListeners = () => {
        try {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
        } catch {
          // Listener cleanup is best effort after a socket has failed.
        }
      };

      const fail = (shouldClose: boolean) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        removeListeners();
        if (shouldClose) {
          try {
            if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED)
              socket.close();
          } catch {
            // A failed command remains failed if the socket cannot close.
          }
        }
        reject(commandFailure());
      };

      const consumePayload = (value: string): boolean => {
        const bytes = Buffer.byteLength(value, "utf8");
        if (payloadBytes + bytes > bounds.maxBytes) return false;
        payloadBytes += bytes;
        return true;
      };

      const onOpen = () => {
        if (terminal) return;
        try {
          socket.send(
            JSON.stringify({
              type: "init",
              data: {
                auth: { type: "apiToken", apiToken: token },
                context: { command, shell: "none", tty: false },
              },
            }),
          );
        } catch {
          fail(true);
        }
      };

      const onMessage = (event: MessageEvent) => {
        if (terminal) return;
        let bytes: number;
        try {
          bytes = commandMessageBytes(event.data);
        } catch {
          fail(true);
          return;
        }
        if (
          bytes > MAX_COMMAND_FRAME_BYTES ||
          inboundBytes + bytes > bounds.maxBytes + MAX_COMMAND_PROTOCOL_OVERHEAD_BYTES
        ) {
          fail(true);
          return;
        }
        inboundBytes += bytes;
        let text: string;
        try {
          text = commandMessageText(event.data);
        } catch {
          fail(true);
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          fail(true);
          return;
        }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          fail(true);
          return;
        }
        const { type, data } = frame as { type?: unknown; data?: unknown };
        const record =
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : undefined;
        if (type === "init") {
          if (authenticated || record?.auth !== "successful") {
            fail(true);
            return;
          }
          authenticated = true;
          return;
        }
        if (type === "stdOut") {
          if (!authenticated || typeof data !== "string") {
            fail(true);
            return;
          }
          if (!consumePayload(data)) {
            fail(true);
            return;
          }
          stdout.push(data);
          return;
        }
        if (type === "stdErr") {
          if (!authenticated || typeof data !== "string") {
            fail(true);
            return;
          }
          if (!consumePayload(data)) fail(true);
          return;
        }
        if (type === "completion") {
          if (
            !authenticated ||
            completed ||
            !record ||
            record.exitCode !== 0 ||
            record.status !== "Success"
          ) {
            fail(true);
            return;
          }
          completed = true;
          return;
        }
        fail(true);
      };

      const onError = () => fail(true);

      const onClose = (event: Event) => {
        if (terminal) return;
        const code = (event as Event & { code?: unknown }).code;
        if ((code !== 1000 && code !== 1005) || !authenticated || !completed) {
          fail(false);
          return;
        }
        terminal = true;
        clearTimeout(timer);
        removeListeners();
        resolve(stdout.join(""));
      };

      const timer = setTimeout(() => fail(true), bounds.timeoutMs);
      try {
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      } catch {
        fail(true);
      }
    });
  }

  async request(
    method: NorthflankMethod,
    segments: string[],
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown> | null> {
    if (
      !["preview-blueprints", "services", "jobs", "addons", "volumes", "secrets"].includes(
        segments[0],
      ) ||
      segments.length > 6
    )
      throw new Error("Northflank preview transport refuses an unrelated resource path.");
    const url = new URL(this.base + segments.map(northflankIdentifier).join("/"));
    for (const [key, value] of Object.entries(query)) {
      if (!["per_page", "cursor"].includes(key) || value.length > 128)
        throw new Error("Invalid Northflank preview query.");
      url.searchParams.set(key, value);
    }
    return this.send(method, url, body);
  }

  async subdomain(method: "GET" | "DELETE", name: string): Promise<Record<string, unknown> | null> {
    if (!this.domain || name.length > 63)
      throw new Error("Northflank domain read is outside its configured scope.");
    const url = new URL(
      `https://api.northflank.com/v1/domains/${this.domain}/subdomains/${northflankIdentifier(name)}`,
    );
    return this.send(method, url);
  }

  private async send(
    method: NorthflankMethod,
    url: URL,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    const content = body === undefined ? undefined : JSON.stringify(body);
    if (content !== undefined && Buffer.byteLength(content) > MAX_BYTES)
      throw new Error("Northflank request exceeds its size bound.");
    this.checkQuota();
    const token = await this.options.accessToken();
    if (!token || /\s/.test(token)) throw new Error("Northflank preview token is unavailable.");
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: content,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      if (method !== "GET") throw new NorthflankOutcomeUncertain();
      throw new Error("Northflank read transport failed.");
    }
    try {
      this.observeQuota(response);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (method === "GET" && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method !== "GET") {
        if ([400, 401, 403, 404, 422].includes(response.status))
          throw new NorthflankRejected(response.status);
        throw new NorthflankOutcomeUncertain();
      }
      throw new Error(`Northflank preview request failed (HTTP ${response.status}).`);
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return {};
    }
    let contentText: string;
    try {
      contentText = await readPreviewResponse(response, "Northflank");
    } catch {
      if (method !== "GET") throw new NorthflankOutcomeUncertain();
      throw new Error("Northflank response is unreadable or exceeds its size bound.");
    }
    try {
      return northflankRecord(JSON.parse(contentText));
    } catch {
      if (method !== "GET") throw new NorthflankOutcomeUncertain();
      throw new Error("Northflank response is not a valid JSON object.");
    }
  }

  async list(segments: string[], member?: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const result = await this.request("GET", segments, undefined, {
        per_page: "100",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result) throw new Error("Northflank collection is unavailable.");
      const items = member === undefined ? result.data : northflankRecord(result.data)[member];
      if (member === undefined && !result.pagination) {
        if (!Array.isArray(items) || items.length > 4096)
          throw new Error("Invalid Northflank resource collection.");
        return items.map(northflankRecord);
      }
      const pagination = northflankRecord(result.pagination);
      if (
        !Array.isArray(items) ||
        items.length > 100 ||
        typeof pagination.hasNextPage !== "boolean" ||
        pagination.count !== items.length
      )
        throw new Error("Incomplete Northflank collection response.");
      rows.push(...items.map(northflankRecord));
      if (!pagination.hasNextPage) return rows;
      if (
        typeof pagination.cursor !== "string" ||
        !pagination.cursor ||
        cursors.has(pagination.cursor)
      )
        throw new Error("Northflank collection cursor did not advance.");
      cursor = pagination.cursor;
      cursors.add(cursor);
    }
    throw new Error("Northflank collection exceeds its pagination bound.");
  }

  deadlineLifetime(target: number, now: number): number {
    if (!Number.isSafeInteger(target) || !Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid Northflank deadline target.");
    // This provisional allowance must be qualified with server clock/latency evidence
    // before an adapter may use native expiry as its independent backstop.
    const lifetime = Math.floor((target - now - this.deadlineMarginMs) / 60_000);
    if (lifetime < 1 || lifetime > 260)
      throw new Error("Northflank deadline falls outside the supported request bounds.");
    return lifetime;
  }

  async resetDeadline(
    blueprintId: string,
    previewId: string,
    target: number,
    now: number,
  ): Promise<number> {
    const lifetime = this.deadlineLifetime(target, now);
    const result = await this.request(
      "POST",
      ["preview-blueprints", blueprintId, "previews", previewId, "reset"],
      { lifetime },
    );
    const data = result?.data;
    const expiryTime =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).expiryTime
        : undefined;
    const expiry = typeof expiryTime === "string" ? Date.parse(expiryTime) : Number.NaN;
    if (
      !Number.isSafeInteger(expiry) ||
      expiry > target ||
      expiry < target - MAX_PREVIEW_DEADLINE_EARLINESS_MS
    )
      throw new NorthflankOutcomeUncertain();
    return expiry;
  }
}
