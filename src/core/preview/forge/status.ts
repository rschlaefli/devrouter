import type { PreviewAdmission, PreviewIdentity } from "../engine";
import { readPreviewResponse } from "../http";
import type { PreviewPoolEntry } from "../state";
import type { PreviewSource } from "../types";

export type ForgeComment = {
  id: string;
  createdAt: number;
  command: import("../command").PreviewCommand;
};
export type ForgeSnapshot = {
  identity: PreviewIdentity;
  open: boolean;
  sameProject: boolean;
  source: PreviewSource;
};
export interface PreviewForge {
  snapshot(change: number): Promise<ForgeSnapshot>;
  commands(change: number, since: number, until: number): Promise<ForgeComment[]>;
  admission(
    change: number,
    commentId: string,
  ): Promise<Omit<PreviewAdmission, "plan" | "hourlyCents"> | null>;
  changes(): Promise<number[]>;
  publish(change: number, body: string, previousId?: string): Promise<string>;
}

export function forgeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid forge object.");
  return value as Record<string, unknown>;
}
export function forgeId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id))
    throw new Error("Invalid forge numeric identity.");
  return id;
}
export function forgeSHA(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw new Error("Invalid forge revision.");
  return value;
}
export function forgeTime(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("Invalid forge time.");
  return time;
}

/** Both forge adapters share bounded requests; no candidate URL is ever followed. */
export class PreviewForgeHTTP {
  readonly base: URL;
  constructor(
    private readonly options: {
      apiUrl: string;
      token: () => Promise<string>;
      fetch?: typeof fetch;
      kind: "github" | "gitlab";
    },
  ) {
    this.base = new URL(options.apiUrl);
    if (
      this.base.protocol !== "https:" ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.port ||
      !this.base.pathname.endsWith("/")
    )
      throw new Error("Forge requires a trusted HTTPS API base.");
  }
  async request(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
    maxBytes?: number,
  ): Promise<{ data: unknown; headers: Headers }> {
    if (
      !path ||
      path.startsWith("/") ||
      path
        .split("?")[0]
        .split("/")
        .some((part) => [".", ".."].includes(decodeURIComponent(part))) ||
      path.includes("\\") ||
      path.includes("#")
    )
      throw new Error("Invalid forge API path.");
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname))
      throw new Error("Forge request escaped its configured API.");
    const token = await this.options.token();
    if (!token || /\s/.test(token)) throw new Error("Preview forge token is unavailable.");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(this.options.kind === "github" ? { "X-GitHub-Api-Version": "2026-03-10" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("Preview forge transport failed; reconcile writes before retrying.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Preview forge request failed (HTTP ${response.status}).`);
    }
    try {
      return {
        data: JSON.parse(await readPreviewResponse(response, "Preview forge", maxBytes)),
        headers: response.headers,
      };
    } catch {
      throw new Error("Preview forge response is unreadable or exceeds its bound.");
    }
  }
  async pages(
    path: string,
    options: { maxBytes?: number; project?: (row: unknown) => unknown } = {},
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const result = await this.request(
        "GET",
        `${path}${separator}per_page=100&page=${page}`,
        undefined,
        options.maxBytes,
      );
      if (!Array.isArray(result.data) || result.data.length > 100)
        throw new Error("Incomplete forge collection.");
      rows.push(...result.data.map(options.project ?? ((row) => row)));
      if (rows.length > 10_000) throw new Error("Forge collection exceeds its bound.");
      const link = result.headers.get("link");
      const next =
        this.options.kind === "github"
          ? !!link?.split(",").some((part) => /;\s*rel="next"/.test(part))
          : !!result.headers.get("x-next-page");
      if (!next) {
        if (
          result.data.length === 100 &&
          this.options.kind === "gitlab" &&
          !result.headers.has("x-next-page")
        )
          throw new Error("GitLab pagination proof is missing.");
        return rows;
      }
      if (result.data.length === 0) throw new Error("Forge cursor did not advance.");
    }
    throw new Error("Forge history exceeds its pagination bound.");
  }
}

export const PREVIEW_STATUS_MARKER = "<!-- devrouter-preview -->";

export function previewStatusBody(
  entry: PreviewPoolEntry | null,
  urls: Record<string, string> = {},
): string {
  if (!entry)
    return `${PREVIEW_STATUS_MARKER}\n\nDevrouter preview: no environment. Use \`/preview start\` or \`/preview profiles\`.`;
  const session = entry.session;
  const lines = [
    PREVIEW_STATUS_MARKER,
    `Devrouter preview: **${session.status}**${session.stale ? " (source changed; run /preview start to refresh)" : ""}.`,
    `Revision: \`${session.desiredRevision}\`. Profiles: ${session.desiredAliases.map((alias) => `\`${alias}\``).join(", ")}.`,
    `Expires: ${new Date(session.expiresAt).toISOString()}. Setup cutoff: ${new Date(session.setupDeadline).toISOString()}.`,
    `Estimated compute: ${(entry.hourlyCents / 100).toFixed(2)} USD/hour; allocation reservation ${(entry.reservedCents / 100).toFixed(2)} USD. Builds, storage and provider cleanup can add charges.`,
  ];
  if (session.status === "ready")
    for (const [name, value] of Object.entries(urls)) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^[a-z0-9:-]+$/.test(name)
      )
        throw new Error("Invalid public preview link.");
      lines.push(`[${name}](${url.href})`);
    }
  lines.push(
    "`/preview extend 1h` adds one hour (maximum twice). `/preview stop` deletes this disposable environment and its test data.",
  );
  return lines.join("\n\n");
}
