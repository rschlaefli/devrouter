import { readPreviewResponse } from "../http";
import { MAX_PREVIEW_DEADLINE_EARLINESS_MS } from "../lifecycle";

type NorthflankMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const MAX_BYTES = 1024 * 1024;

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

export class NorthflankOutcomeUncertain extends Error {
  constructor() {
    super("Northflank mutation outcome is uncertain and must be reconciled.");
    this.name = "NorthflankOutcomeUncertain";
  }
}

/** Project-scoped transport. It never retries mutations or exposes response bodies in errors. */
export class NorthflankPreviewAPI {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly deadlineMarginMs: number;
  readonly projectId: string;
  readonly domain?: string;

  constructor(
    private readonly options: {
      projectId: string;
      accessToken: () => Promise<string>;
      fetch?: typeof fetch;
      deadlineMarginMs?: number;
      domain?: string;
    },
  ) {
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
    const margin = options.deadlineMarginMs ?? 15_000;
    if (!Number.isSafeInteger(margin) || margin < 1 || margin > 15_000)
      throw new Error("Invalid Northflank deadline delay allowance.");
    this.deadlineMarginMs = margin;
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
    if (method === "GET" && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method !== "GET") throw new NorthflankOutcomeUncertain();
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
