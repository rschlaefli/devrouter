import { parsePreviewCommand } from "../command";
import type { PreviewAdmission } from "../engine";
import { assertRepoRelativePath } from "../manifest";
import type { PreviewSource } from "../types";
import {
  type ForgeComment,
  type ForgeSnapshot,
  forgeId,
  forgeSHA,
  forgeTime,
  forgeObject as object,
  PREVIEW_STATUS_MARKER,
  PreviewControlUnavailable,
  type PreviewForge,
  PreviewForgeHTTP,
  PreviewForgeNotSent,
} from "./status";

export class GitHubPreviewForge implements PreviewForge {
  private readonly http: PreviewForgeHTTP;
  private readonly repo: string;
  private readonly graphql: PreviewForgeHTTP;
  private readonly issues: string;
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
    this.graphql = new PreviewForgeHTTP({
      ...options,
      apiUrl: options.forgeHost === "github.com" ? options.apiUrl : `${api.origin}/api/`,
      kind: "github",
    });
    this.repo = `repos/${options.repository}`;
    this.issues = `${this.http.base.origin}${this.http.base.pathname}${this.repo}/issues/`;
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
  async file(revision: string, filename: string): Promise<string> {
    forgeSHA(revision);
    assertRepoRelativePath(filename, "reviewed control file");
    await this.repository();
    const data = (
      await this.http.request(
        "GET",
        `${this.repo}/contents/${filename.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`,
        undefined,
        2 * 1024 * 1024,
      )
    ).data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new PreviewControlUnavailable();
    const row = object(data);
    if (
      row.type !== "file" ||
      row.path !== filename ||
      row.encoding !== "base64" ||
      typeof row.content !== "string" ||
      !Number.isSafeInteger(row.size) ||
      (row.size as number) > 1024 * 1024
    )
      throw new PreviewControlUnavailable();
    const bytes = Buffer.from(row.content, "base64");
    if (bytes.length !== row.size) throw new Error("Incomplete GitHub control file.");
    return bytes.toString("utf8");
  }
  async snapshot(change: number, withSource = true): Promise<ForgeSnapshot> {
    await this.repository();
    const initial = await this.pull(change);
    const events = initial.open
      ? await this.http.pages(`${this.repo}/issues/${forgeId(change)}/events`)
      : [];
    const commandAfter = events
      .map(object)
      .filter((row) => row.event === "closed" || row.event === "reopened")
      .reduce((time, row) => Math.max(time, forgeTime(row.created_at)), 0);
    if (!withSource)
      return {
        identity: { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change },
        open: initial.open,
        sameProject: initial.sameProject,
        commandAfter,
        source: {
          head: initial.head,
          target: initial.target,
          mergeBase: initial.target,
          complete: false,
          changes: [],
        },
      };
    if (
      !Number.isSafeInteger(initial.row.changed_files) ||
      (initial.row.changed_files as number) < 0 ||
      (initial.row.changed_files as number) >= 3000
    )
      throw new Error("GitHub cumulative diff exceeds its qualified bound.");
    const files = await this.http.pages(`${this.path(change)}/files`, {
      maxBytes: 16 * 1024 * 1024,
      project: (raw) => {
        const file = object(raw);
        return {
          filename: file.filename,
          previous_filename: file.previous_filename,
          status: file.status,
        };
      },
    });
    if (
      !Number.isSafeInteger(initial.row.changed_files) ||
      files.length !== initial.row.changed_files ||
      files.length >= 3000
    )
      throw new Error("GitHub cumulative diff is incomplete or exceeds its qualified bound.");
    const comparison = object(
      (
        await this.http.request(
          "GET",
          `${this.repo}/compare/${initial.target}...${initial.head}?per_page=1`,
          undefined,
          16 * 1024 * 1024,
        )
      ).data,
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
      if (
        !status ||
        ((status === "R" || status === "C") && typeof file.previous_filename !== "string")
      )
        throw new Error("Unsupported GitHub diff status.");
      return {
        status,
        path: file.filename,
        ...(status === "R" || status === "C" ? { oldPath: file.previous_filename as string } : {}),
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
      commandAfter,
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
    const expected = `${this.issues}${change}`;
    if (
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(row.author_association as string) ||
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
    if (!(await this.original(raw))) return null;
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
  private async original(row: Record<string, unknown>): Promise<boolean> {
    if (typeof row.node_id !== "string" || !row.node_id || row.node_id.length > 256)
      throw new Error("GitHub comment has no global identity.");
    const reply = object(
      (
        await this.graphql.request("POST", "graphql", {
          query:
            "query($id:ID!){node(id:$id){...on IssueComment{id lastEditedAt body createdAt author{__typename login}}}}",
          variables: { id: row.node_id },
        })
      ).data,
    );
    if (reply.errors !== undefined) throw new Error("GitHub comment edit proof is unavailable.");
    const node = object(object(reply.data).node),
      author = object(node.author);
    return (
      node.id === row.node_id &&
      node.lastEditedAt === null &&
      node.body === row.body &&
      forgeTime(node.createdAt) === forgeTime(row.created_at) &&
      author.__typename === "User" &&
      author.login === object(row.user).login
    );
  }
  async changes(since: number): Promise<number[]> {
    await this.repository();
    if (!Number.isSafeInteger(since) || since < 0)
      throw new Error("Invalid GitHub recovery window.");
    const rows = await this.http.pages(
      `${this.repo}/issues/comments?since=${encodeURIComponent(new Date(since).toISOString())}&sort=created&direction=asc`,
    );
    const changes = new Set<number>();
    for (const raw of rows) {
      const row = object(raw);
      if (
        typeof row.body !== "string" ||
        !parsePreviewCommand(row.body) ||
        !["OWNER", "MEMBER", "COLLABORATOR"].includes(row.author_association as string) ||
        object(row.user).type !== "User" ||
        typeof row.issue_url !== "string"
      )
        continue;
      const prefix = this.issues;
      if (!row.issue_url.startsWith(prefix))
        throw new Error("GitHub recovered comment is outside the project.");
      if (row.created_at !== row.updated_at || forgeTime(row.created_at) < since) continue;
      const number = Number(forgeId(row.issue_url.slice(prefix.length)));
      if (!Number.isSafeInteger(number)) throw new Error("Invalid recovered GitHub change number.");
      changes.add(number);
    }
    if (changes.size > 128)
      throw new Error("GitHub command recovery exceeds its distinct issue bound.");
    const pulls: number[] = [];
    for (const change of changes) {
      const issue = object((await this.http.request("GET", `${this.repo}/issues/${change}`)).data);
      if (issue.number !== change) throw new Error("GitHub issue identity changed.");
      if (issue.pull_request) {
        pulls.push(change);
        if (pulls.length > 128)
          throw new Error("GitHub command recovery exceeds its pull request bound.");
      }
    }
    return pulls;
  }
  async findStatus(change: number, marker: string): Promise<string | null> {
    await this.repository();
    const comments = await this.http.pages(`${this.repo}/issues/${forgeId(change)}/comments`);
    const matches = comments
      .map(object)
      .filter(
        (row) =>
          object(row.user).id === Number(this.options.botId) &&
          row.issue_url === `${this.issues}${change}` &&
          typeof row.body === "string" &&
          row.body.startsWith(PREVIEW_STATUS_MARKER) &&
          row.body.includes(marker),
      );
    if (matches.length > 1) throw new Error("Preview status comment identity is ambiguous.");
    return matches.length ? forgeId(matches[0].id) : null;
  }
  async publish(change: number, body: string, previousId?: string): Promise<string> {
    try {
      await this.repository();
    } catch {
      throw new PreviewForgeNotSent();
    }
    if (!body.startsWith(PREVIEW_STATUS_MARKER))
      throw new Error("Preview status has no ownership marker.");
    if (Buffer.byteLength(body) > 32 * 1024) throw new Error("Preview status exceeds its bound.");
    if (previousId) {
      const path = `${this.repo}/issues/comments/${forgeId(previousId)}`;
      const comment = object((await this.http.request("GET", path)).data);
      if (
        forgeId(object(comment.user).id) !== this.options.botId ||
        typeof comment.body !== "string" ||
        !comment.body.startsWith(PREVIEW_STATUS_MARKER) ||
        comment.issue_url !== `${this.issues}${forgeId(change)}`
      )
        throw new Error("Preview status comment ownership differs.");
      await this.http.request("PATCH", path, { body });
      return previousId;
    }
    const created = object(
      (await this.http.request("POST", `${this.repo}/issues/${forgeId(change)}/comments`, { body }))
        .data,
    );
    if (forgeId(object(created.user).id) !== this.options.botId)
      throw new Error("Preview status author differs from the configured bot.");
    return forgeId(created.id);
  }
}
