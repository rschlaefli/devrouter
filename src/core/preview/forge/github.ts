import { parsePreviewCommand } from "../command";
import type { PreviewAdmission } from "../engine";
import type { PreviewSource } from "../types";
import {
  type ForgeComment,
  type ForgeSnapshot,
  forgeId,
  forgeSHA,
  forgeTime,
  forgeObject as object,
  type PreviewForge,
  PreviewForgeHTTP,
} from "./status";

export class GitHubPreviewForge implements PreviewForge {
  private readonly http: PreviewForgeHTTP;
  private readonly repo: string;
  constructor(
    private readonly options: {
      apiUrl: string;
      forgeHost: string;
      repository: string;
      projectId: string;
      botId: string;
      token: () => Promise<string>;
      fetch?: typeof fetch;
    },
  ) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) ||
      options.repository.includes("..") ||
      !/^[a-z0-9.-]+$/.test(options.forgeHost)
    )
      throw new Error("Invalid trusted GitHub repository.");
    forgeId(options.projectId);
    forgeId(options.botId);
    const api = new URL(options.apiUrl);
    if (
      options.forgeHost === "github.com"
        ? api.hostname !== "api.github.com" || api.pathname !== "/"
        : api.hostname !== options.forgeHost || api.pathname !== "/api/v3/"
    )
      throw new Error("GitHub API must match its trusted forge host.");
    this.http = new PreviewForgeHTTP({ ...options, kind: "github" });
    this.repo = `repos/${options.repository}`;
  }
  private path(change: number): string {
    forgeId(change);
    return `${this.repo}/pulls/${change}`;
  }
  private async repository() {
    const repo = object((await this.http.request("GET", this.repo)).data);
    if (forgeId(repo.id) !== this.options.projectId || repo.full_name !== this.options.repository)
      throw new Error("GitHub immutable repository identity changed.");
  }
  private async pull(change: number) {
    const row = object((await this.http.request("GET", this.path(change))).data);
    const base = object(row.base),
      head = object(row.head);
    const baseRepo = object(base.repo),
      headRepo = object(head.repo);
    if (forgeId(baseRepo.id) !== this.options.projectId || row.number !== change)
      throw new Error("GitHub change belongs to another project.");
    return {
      row,
      head: forgeSHA(head.sha),
      target: forgeSHA(base.sha),
      sameProject: forgeId(headRepo.id) === this.options.projectId,
      open: row.state === "open" && row.merged !== true,
    };
  }
  async snapshot(change: number): Promise<ForgeSnapshot> {
    await this.repository();
    const initial = await this.pull(change);
    const files = await this.http.pages(`${this.path(change)}/files`);
    if (
      !Number.isSafeInteger(initial.row.changed_files) ||
      files.length !== initial.row.changed_files ||
      files.length >= 3000
    )
      throw new Error("GitHub cumulative diff is incomplete or exceeds its qualified bound.");
    const comparison = object(
      (await this.http.request("GET", `${this.repo}/compare/${initial.target}...${initial.head}`))
        .data,
    );
    const changes: PreviewSource["changes"] = files.map((raw) => {
      const file = object(raw);
      if (typeof file.filename !== "string") throw new Error("GitHub diff has no path.");
      const statuses: Record<string, PreviewSource["changes"][number]["status"]> = {
        added: "A",
        modified: "M",
        removed: "D",
        renamed: "R",
        copied: "C",
        changed: "T",
        unchanged: "M",
      };
      const status = typeof file.status === "string" ? statuses[file.status] : undefined;
      if (!status || (status === "R" && typeof file.previous_filename !== "string"))
        throw new Error("Unsupported GitHub diff status.");
      return {
        status,
        path: file.filename,
        ...(status === "R" ? { oldPath: file.previous_filename as string } : {}),
      };
    });
    const current = await this.pull(change);
    if (
      current.head !== initial.head ||
      current.target !== initial.target ||
      current.open !== initial.open ||
      current.sameProject !== initial.sameProject
    )
      throw new Error("GitHub source changed while resolving the cumulative diff.");
    return {
      identity: { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change },
      open: current.open,
      sameProject: current.sameProject,
      source: {
        head: initial.head,
        target: initial.target,
        mergeBase: forgeSHA(object(comparison.merge_base_commit).sha),
        complete: true,
        changes,
      },
    };
  }
  private parse(raw: unknown, change: number): ForgeComment | null {
    const row = object(raw),
      author = object(row.user);
    const expected = `${this.http.base.origin}${this.http.base.pathname}${this.repo}/issues/${change}`;
    if (
      author.type !== "User" ||
      row.created_at !== row.updated_at ||
      row.issue_url !== expected ||
      typeof row.body !== "string"
    )
      return null;
    const command = parsePreviewCommand(row.body);
    return command ? { id: forgeId(row.id), createdAt: forgeTime(row.created_at), command } : null;
  }
  async commands(change: number, since: number, until: number): Promise<ForgeComment[]> {
    const rows = await this.http.pages(`${this.repo}/issues/${forgeId(change)}/comments`);
    return rows
      .flatMap((raw) => {
        const row = this.parse(raw, change);
        return row && row.createdAt >= since && row.createdAt <= until ? [row] : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }
  async admission(
    change: number,
    commentId: string,
  ): Promise<Omit<PreviewAdmission, "plan" | "hourlyCents"> | null> {
    await this.repository();
    const raw = object(
      (await this.http.request("GET", `${this.repo}/issues/comments/${forgeId(commentId)}`)).data,
    );
    const comment = this.parse(raw, change);
    if (!comment) return null;
    const author = object(raw.user);
    if (typeof author.login !== "string" || !/^[A-Za-z0-9-]+$/.test(author.login))
      throw new Error("Invalid GitHub actor.");
    const permission = object(
      (await this.http.request("GET", `${this.repo}/collaborators/${author.login}/permission`))
        .data,
    );
    if (forgeId(object(permission.user).id) !== forgeId(author.id))
      throw new Error("GitHub actor identity changed.");
    const pull = await this.pull(change);
    const confirmed = this.parse(
      (await this.http.request("GET", `${this.repo}/issues/comments/${commentId}`)).data,
      change,
    );
    if (
      !confirmed ||
      confirmed.createdAt !== comment.createdAt ||
      JSON.stringify(confirmed.command) !== JSON.stringify(comment.command)
    )
      return null;
    return {
      identity: { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change },
      commandId: comment.id,
      createdAt: comment.createdAt,
      actorCanWrite: permission.permission === "write" || permission.permission === "admin",
      originalHumanRoot: true,
      open: pull.open,
      sameProject: pull.sameProject,
      command: comment.command,
    };
  }
  async changes(): Promise<number[]> {
    await this.repository();
    return (await this.http.pages(`${this.repo}/pulls?state=open&sort=created&direction=asc`)).map(
      (raw) => Number(forgeId(object(raw).number)),
    );
  }
  async publish(change: number, body: string, previousId?: string): Promise<string> {
    await this.repository();
    if (Buffer.byteLength(body) > 32 * 1024) throw new Error("Preview status exceeds its bound.");
    if (previousId) {
      const path = `${this.repo}/issues/comments/${forgeId(previousId)}`;
      const comment = object((await this.http.request("GET", path)).data);
      if (
        forgeId(object(comment.user).id) !== this.options.botId ||
        typeof comment.body !== "string" ||
        !comment.body.startsWith("<!-- devrouter-preview -->") ||
        comment.issue_url !==
          `${this.http.base.origin}${this.http.base.pathname}${this.repo}/issues/${forgeId(change)}`
      )
        throw new Error("Preview status comment ownership differs.");
      await this.http.request("PATCH", path, { body });
      return previousId;
    }
    return forgeId(
      object(
        (
          await this.http.request("POST", `${this.repo}/issues/${forgeId(change)}/comments`, {
            body,
          })
        ).data,
      ).id,
    );
  }
}
