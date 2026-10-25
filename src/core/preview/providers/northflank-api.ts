const MAX_BYTES = 1024 * 1024;

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value))
    throw new Error("Invalid Northflank resource identifier.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Northflank response object.");
  return value as Record<string, unknown>;
}

async function boundedBody(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    await response.body?.cancel();
    throw new Error("Northflank response exceeds its size bound.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Northflank response is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Northflank response exceeds its size bound.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

/** Project-scoped transport. It never retries mutations or exposes response bodies in errors. */
export class NorthflankPreviewAPI {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly options: {
      projectId: string;
      accessToken: () => Promise<string>;
      fetch?: typeof fetch;
    },
  ) {
    this.base = `https://api.northflank.com/v1/projects/${identifier(options.projectId)}/`;
    this.fetch = options.fetch ?? fetch;
  }

  async request(
    method: "GET" | "POST" | "DELETE",
    segments: string[],
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown> | null> {
    if (segments[0] !== "preview-blueprints" || segments.length > 6)
      throw new Error("Northflank preview transport refuses an unrelated resource path.");
    const url = new URL(this.base + segments.map(identifier).join("/"));
    for (const [key, value] of Object.entries(query)) {
      if (!["per_page", "cursor"].includes(key) || value.length > 128)
        throw new Error("Invalid Northflank preview query.");
      url.searchParams.set(key, value);
    }
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
      throw new Error("Northflank transport failed; mutation outcome may be uncertain.");
    }
    if (method === "GET" && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Northflank preview request failed (HTTP ${response.status}).`);
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return {};
    }
    return record(await boundedBody(response));
  }

  async list(segments: string[], member: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const result = await this.request("GET", segments, undefined, {
        per_page: "100",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!result) throw new Error("Northflank collection is unavailable.");
      const data = record(result.data);
      const items = data[member];
      const pagination = record(result.pagination);
      if (
        !Array.isArray(items) ||
        items.length > 100 ||
        typeof pagination.hasNextPage !== "boolean" ||
        pagination.count !== items.length
      )
        throw new Error("Incomplete Northflank collection response.");
      rows.push(...items.map(record));
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

  async resetDeadline(
    blueprintId: string,
    previewId: string,
    target: number,
    now: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(target) || !Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid Northflank deadline target.");
    const lifetime = Math.floor((target - now) / 60_000);
    if (lifetime < 1 || lifetime > 260)
      throw new Error("Northflank deadline falls outside the qualified lifetime window.");
    const result = await this.request(
      "POST",
      ["preview-blueprints", blueprintId, "previews", previewId, "reset"],
      { lifetime },
    );
    const expiryTime = record(result?.data).expiryTime;
    const expiry = typeof expiryTime === "string" ? Date.parse(expiryTime) : Number.NaN;
    if (!Number.isSafeInteger(expiry) || expiry > target || expiry < target - 60_000)
      throw new Error("Northflank deadline response does not confirm the fixed target.");
    return expiry;
  }
}
