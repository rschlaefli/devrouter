import { PreviewAdmissionRefused, parsePreviewCommand } from "../command";
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
  PreviewForgeRejected,
} from "./status";

/** GitLab.com and registered self-managed hosts use the same immutable project boundary. */
export class GitLabPreviewForge implements PreviewForge {
  private readonly http: PreviewForgeHTTP;
  private readonly project: string;
  private readonly graphql: PreviewForgeHTTP;
  constructor(
    private readonly options: {
      apiUrl: string;
      forgeHost: string;
      repository: string;
      projectId: string;
      botId: string;
      controllerProjectId?: string;
      token: () => Promise<string>;
      fetch?: typeof fetch;
    },
  ) {
    forgeId(options.projectId);
    forgeId(options.botId);
    if (options.controllerProjectId !== undefined) forgeId(options.controllerProjectId);
    const api = new URL(options.apiUrl);
    if (
      api.hostname !== options.forgeHost ||
      api.pathname !== "/api/v4/" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(options.repository) ||
      options.repository.includes("..")
    )
      throw new Error("Invalid trusted GitLab project.");
    this.http = new PreviewForgeHTTP({ ...options, kind: "gitlab" });
    this.project = `projects/${options.projectId}`;
    this.graphql = new PreviewForgeHTTP({
      ...options,
      apiUrl: `${api.origin}/api/`,
      kind: "gitlab",
    });
  }
  /** Run externally before enabling triggers; an in-job check cannot undo variable injection. */
  async verifyControllerSafe(expectedProjectId?: string): Promise<void> {
    const id = this.options.controllerProjectId;
    if (!id)
      throw new PreviewAdmissionRefused(
        "forge-unqualified",
        "GitLab controller project is not registered.",
      );
    if (expectedProjectId !== undefined && expectedProjectId !== id)
      throw new PreviewAdmissionRefused(
        "forge-unqualified",
        "GitLab controller identity differs from installed policy.",
      );
    let raw: unknown;
    try {
      raw = (await this.http.request("GET", `projects/${id}`)).data;
    } catch (error) {
      if (error instanceof PreviewForgeRejected && [403, 404].includes(error.status))
        throw new PreviewAdmissionRefused(
          "forge-unqualified",
          "GitLab controller settings cannot be verified.",
        );
      throw error;
    }
    const row = object(raw);
    if (
      forgeId(row.id) !== id ||
      row.ci_pipeline_variables_minimum_override_role !== "no_one_allowed"
    )
      throw new PreviewAdmissionRefused(
        "forge-unqualified",
        "GitLab controller must disable pipeline variable overrides before activation.",
      );
  }
  private async registered() {
    const row = object((await this.http.request("GET", this.project)).data);
    if (
      forgeId(row.id) !== this.options.projectId ||
      row.path_with_namespace !== this.options.repository
    )
      throw new Error("GitLab immutable project identity changed.");
  }
  private path(change: number) {
    return `${this.project}/merge_requests/${forgeId(change)}`;
  }
  private async merge(change: number) {
    const row = object((await this.http.request("GET", this.path(change))).data);
    if (forgeId(row.target_project_id) !== this.options.projectId || row.iid !== change)
      throw new Error("GitLab merge request belongs to another project.");
    return {
      row,
      head: forgeSHA(row.sha),
      open: row.state === "opened",
      sameProject: forgeId(row.source_project_id) === this.options.projectId,
    };
  }
  async file(revision: string, filename: string): Promise<string> {
    forgeSHA(revision);
    assertRepoRelativePath(filename, "reviewed control file");
    await this.registered();
    const raw = (
      await this.http.request(
        "GET",
        `${this.project}/repository/files/${encodeURIComponent(filename)}?ref=${revision}`,
        undefined,
        2 * 1024 * 1024,
      )
    ).data;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new PreviewControlUnavailable();
    const row = object(raw);
    if (
      row.file_path !== filename ||
      row.encoding !== "base64" ||
      typeof row.content !== "string" ||
      !Number.isSafeInteger(row.size) ||
      (row.size as number) > 1024 * 1024
    )
      throw new PreviewControlUnavailable();
    const bytes = Buffer.from(row.content, "base64");
    if (bytes.length !== row.size) throw new Error("Incomplete GitLab control file.");
    return bytes.toString("utf8");
  }
  async snapshot(change: number, withSource = true): Promise<ForgeSnapshot> {
    await this.registered();
    const initial = await this.merge(change),
      head = initial.head;
    const events = initial.open
      ? await this.http.pages(`${this.path(change)}/resource_state_events`)
      : [];
    const commandAfter = events
      .map(object)
      .filter((row) => ["closed", "reopened", "opened", "merged"].includes(row.state as string))
      .reduce((last, row) => Math.max(last, forgeTime(row.created_at)), 0);
    const targetHead = async () => {
      if (typeof initial.row.target_branch !== "string")
        throw new Error("GitLab target branch is unavailable.");
      return forgeSHA(
        object(
          object(
            (
              await this.http.request(
                "GET",
                `${this.project}/repository/branches/${encodeURIComponent(initial.row.target_branch)}`,
              )
            ).data,
          ).commit,
        ).id,
      );
    };
    const target = initial.open && initial.sameProject ? await targetHead() : head;
    const snapshot: ForgeSnapshot = {
      identity: { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change },
      open: initial.open,
      sameProject: initial.sameProject,
      commandAfter,
      source: { head, target, mergeBase: head, complete: false, changes: [] },
    };
    if (!withSource || !initial.open || !initial.sameProject) return snapshot;
    const refs = object(initial.row.diff_refs),
      mergeBase = forgeSHA(refs.base_sha);
    if (forgeSHA(refs.head_sha) !== head) throw new Error("GitLab diff revision is not current.");
    const ancestor = object(
      (
        await this.http.request(
          "GET",
          `${this.project}/repository/merge_base?refs[]=${target}&refs[]=${head}`,
        )
      ).data,
    );
    if (forgeSHA(ancestor.id) !== mergeBase)
      throw new Error("GitLab cumulative diff merge base is stale.");
    const count = initial.row.changes_count;
    if (typeof count !== "string" || !/^\d+$/.test(count) || Number(count) > 10_000)
      throw new Error("GitLab cumulative diff count is incomplete.");
    const rows = await this.http.pages(`${this.path(change)}/diffs`, {
      maxBytes: 16 * 1024 * 1024,
      project: (raw) => {
        const row = object(raw);
        return Object.fromEntries(
          [
            "old_path",
            "new_path",
            "a_mode",
            "b_mode",
            "new_file",
            "deleted_file",
            "renamed_file",
            "collapsed",
            "too_large",
          ].map((key) => [key, row[key]]),
        );
      },
    });
    if (rows.length !== Number(count)) throw new Error("GitLab cumulative diff is truncated.");
    const changes: PreviewSource["changes"] = rows.map((raw) => {
      const row = object(raw);
      if (
        row.collapsed !== false ||
        row.too_large !== false ||
        ["new_file", "deleted_file", "renamed_file"].some((key) => typeof row[key] !== "boolean")
      )
        throw new Error("GitLab file diff is incomplete.");
      const path = assertRepoRelativePath(row.new_path, "GitLab changed file"),
        oldPath = assertRepoRelativePath(row.old_path, "GitLab old file");
      if (row.renamed_file) return { status: "R", path, oldPath };
      return {
        status: row.new_file ? "A" : row.deleted_file ? "D" : row.a_mode !== row.b_mode ? "T" : "M",
        path,
      };
    });
    const current = await this.merge(change);
    if (
      !current.open ||
      !current.sameProject ||
      current.head !== head ||
      JSON.stringify(current.row.diff_refs) !== JSON.stringify(initial.row.diff_refs) ||
      (await targetHead()) !== target
    )
      throw new Error("GitLab source changed during snapshot.");
    return { ...snapshot, source: { head, target, mergeBase, complete: true, changes } };
  }
  private parse(raw: unknown, change: number): ForgeComment | null {
    const row = object(raw);
    if (
      row.system !== false ||
      row.type !== null ||
      row.imported !== false ||
      row.noteable_type !== "MergeRequest" ||
      forgeId(row.project_id) !== this.options.projectId ||
      row.noteable_iid !== change ||
      row.resolvable !== false ||
      row.created_at !== row.updated_at ||
      typeof row.body !== "string" ||
      row.internal === true ||
      row.confidential === true
    )
      return null;
    const command = parsePreviewCommand(row.body);
    return command ? { id: forgeId(row.id), createdAt: forgeTime(row.created_at), command } : null;
  }
  async commands(change: number, since: number, until: number): Promise<ForgeComment[]> {
    const [notes, members] = await Promise.all([
      this.http.pages(`${this.path(change)}/notes?sort=asc&order_by=created_at`),
      this.http.pages(`${this.project}/members/all`),
    ]);
    const writers = new Set(
      members
        .map(object)
        .filter(
          (row) =>
            typeof row.access_level === "number" &&
            row.access_level >= 30 &&
            row.membership_state !== "awaiting",
        )
        .map((row) => forgeId(row.id)),
    );
    return notes
      .filter((raw) => {
        const id = forgeId(object(object(raw).author).id);
        return id !== this.options.botId && writers.has(id);
      })
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
    await this.registered();
    try {
      const notePath = `${this.path(change)}/notes/${forgeId(commentId)}`,
        raw = object((await this.http.request("GET", notePath)).data),
        comment = this.parse(raw, change);
      if (!comment) return null;
      const actorId = forgeId(object(raw.author).id),
        user = object((await this.http.request("GET", `users/${actorId}`)).data);
      if (forgeId(user.id) !== actorId || user.bot !== false || user.state !== "active")
        return null;
      const member = object(
        (await this.http.request("GET", `${this.project}/members/all/${actorId}`)).data,
      );
      if (
        forgeId(member.id) !== actorId ||
        typeof member.access_level !== "number" ||
        member.access_level < 30 ||
        member.membership_state === "awaiting"
      )
        return null;
      const proof = object(
        (
          await this.graphql.request("POST", "graphql", {
            query: "query($id:NoteID!){note(id:$id){id body createdAt lastEditedAt author{id}}}",
            variables: { id: `gid://gitlab/Note/${commentId}` },
          })
        ).data,
      );
      if (proof.errors !== undefined) throw new Error("GitLab edit proof is unavailable.");
      const original = object(object(proof.data).note);
      if (
        original.id !== `gid://gitlab/Note/${commentId}` ||
        original.body !== raw.body ||
        Math.floor(forgeTime(original.createdAt) / 1000) !== Math.floor(comment.createdAt / 1000) ||
        original.lastEditedAt !== null ||
        object(original.author).id !== `gid://gitlab/User/${actorId}`
      )
        return null;
      const current = await this.merge(change),
        again = object((await this.http.request("GET", notePath)).data);
      if (
        JSON.stringify(this.parse(again, change)) !== JSON.stringify(comment) ||
        forgeId(object(again.author).id) !== actorId
      )
        throw new Error("GitLab command changed during admission.");
      return {
        identity: { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change },
        commandId: comment.id,
        createdAt: comment.createdAt,
        actorCanWrite: true,
        originalHumanRoot: true,
        open: current.open,
        sameProject: current.sameProject,
        command: comment.command,
      };
    } catch (error) {
      if (error instanceof PreviewForgeRejected && error.status === 404) return null;
      throw error;
    }
  }
  async changes(since: number): Promise<number[]> {
    await this.registered();
    if (!Number.isSafeInteger(since) || since < 0)
      throw new Error("Invalid GitLab recovery window.");
    const rows = await this.http.pages(
      `${this.project}/merge_requests?scope=all&state=opened&updated_after=${encodeURIComponent(new Date(since).toISOString())}`,
    );
    if (rows.length > 128) throw new Error("GitLab recovery exceeds its registered change bound.");
    return rows.map((raw) => {
      const row = object(raw);
      if (forgeId(row.target_project_id) !== this.options.projectId)
        throw new Error("GitLab discovered a foreign change.");
      return Number(forgeId(row.iid));
    });
  }
  async findStatus(change: number, marker: string): Promise<string | null> {
    const rows = (await this.http.pages(`${this.path(change)}/notes`))
      .map(object)
      .filter(
        (row) =>
          forgeId(object(row.author).id) === this.options.botId &&
          row.noteable_iid === change &&
          forgeId(row.project_id) === this.options.projectId &&
          typeof row.body === "string" &&
          row.body.startsWith(PREVIEW_STATUS_MARKER) &&
          row.body.includes(marker),
      );
    if (rows.length > 1) throw new Error("GitLab preview status ownership is ambiguous.");
    return rows.length ? forgeId(rows[0].id) : null;
  }
  async publish(change: number, body: string, previousId?: string): Promise<string> {
    try {
      await this.registered();
    } catch {
      throw new PreviewForgeNotSent();
    }
    if (!body.startsWith(PREVIEW_STATUS_MARKER) || Buffer.byteLength(body) > 32 * 1024)
      throw new Error("Invalid preview status body.");
    if (previousId) {
      const notePath = `${this.path(change)}/notes/${forgeId(previousId)}`,
        previous = object((await this.http.request("GET", notePath)).data);
      if (
        forgeId(object(previous.author).id) !== this.options.botId ||
        forgeId(previous.project_id) !== this.options.projectId ||
        previous.noteable_iid !== change ||
        typeof previous.body !== "string" ||
        !previous.body.startsWith(PREVIEW_STATUS_MARKER)
      )
        throw new Error("GitLab preview status ownership differs.");
      await this.http.request("PUT", notePath, { body });
      return previousId;
    }
    const posted = object(
      (await this.http.request("POST", `${this.path(change)}/notes`, { body })).data,
    );
    if (
      forgeId(object(posted.author).id) !== this.options.botId ||
      forgeId(posted.project_id) !== this.options.projectId ||
      posted.noteable_iid !== change
    )
      throw new Error("GitLab status creation outcome is uncertain.");
    return forgeId(posted.id);
  }
}
