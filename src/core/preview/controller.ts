import { createHash, randomUUID } from "node:crypto";
import { isPreviewAlias, type PreviewCommand } from "./command";
import {
  type PreviewAdmission,
  PreviewAdmissionSuperseded,
  type PreviewEngine,
  type PreviewIdentity,
  previewIdentityKey,
} from "./engine";
import type { ForgeComment, PreviewForge } from "./forge/status";
import { forgeId, PreviewForgeNotSent, previewStatusBody } from "./forge/status";
import { object, PreviewStateConflict, type PreviewStateStore, updatePreviewState } from "./state";
import type { PreviewPlanReport, PreviewSource } from "./types";

type Inbox = {
  schemaVersion: 1;
  identity: PreviewIdentity;
  scannedThrough: number;
  closedThrough: number;
  processed: Array<{ id: string; at: number }>;
  selection?: PreviewPlanReport["status"];
  needsStatus?: boolean;
  status?: {
    intentAt: number;
    intentId?: string;
    commentId?: string;
    bodyDigest?: string;
    publishedAt?: number;
  };
};
function decodeInbox(raw: unknown): Inbox {
  const row = object(
    raw,
    ["schemaVersion", "identity", "scannedThrough", "closedThrough", "processed"],
    ["status", "selection", "needsStatus"],
  );
  if (row.schemaVersion !== 1 || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024)
    throw new Error("Invalid preview inbox.");
  const identity = object(row.identity, ["forgeHost", "projectId", "change"]);
  previewIdentityKey(identity as PreviewIdentity);
  for (const key of ["scannedThrough", "closedThrough"])
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0)
      throw new Error("Invalid preview inbox boundary.");
  if (!Array.isArray(row.processed) || row.processed.length > 1024)
    throw new Error("Preview inbox exceeds its command bound.");
  const ids = new Set<string>();
  for (const item of row.processed) {
    const receipt = object(item, ["id", "at"]);
    forgeId(receipt.id);
    if (
      ids.has(receipt.id as string) ||
      !Number.isSafeInteger(receipt.at) ||
      (receipt.at as number) < 0
    )
      throw new Error("Invalid preview inbox receipt.");
    ids.add(receipt.id as string);
  }
  if (
    row.selection !== undefined &&
    !["no-runtime", "selection-required", "review-required", "unknown"].includes(
      row.selection as string,
    )
  )
    throw new Error("Invalid preview selection result.");
  if (row.needsStatus !== undefined && typeof row.needsStatus !== "boolean")
    throw new Error("Invalid preview status request.");
  if (row.status) {
    const status = object(
      row.status,
      ["intentAt"],
      ["commentId", "bodyDigest", "publishedAt", "intentId"],
    );
    if (!Number.isSafeInteger(status.intentAt) || (status.intentAt as number) < 0)
      throw new Error("Invalid preview status intent.");
    if (
      status.intentId !== undefined &&
      (typeof status.intentId !== "string" || !/^[a-f0-9-]{36}$/.test(status.intentId))
    )
      throw new Error("Invalid preview status intent identity.");
    if (status.commentId !== undefined) forgeId(status.commentId);
    if (
      status.bodyDigest !== undefined &&
      (typeof status.bodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(status.bodyDigest))
    )
      throw new Error("Invalid preview status fingerprint.");
    if (
      status.publishedAt !== undefined &&
      (!Number.isSafeInteger(status.publishedAt) || (status.publishedAt as number) < 0)
    )
      throw new Error("Invalid preview publication time.");
  }
  return structuredClone(row) as Inbox;
}

/** One finite scan is a recoverable inbox. Scheduling belongs to the installation. */
export class PreviewController {
  constructor(
    private readonly options: {
      installationId: string;
      forgeHost: string;
      projectId: string;
      forge: PreviewForge;
      engine: PreviewEngine;
      store: PreviewStateStore;
      now: () => number;
      maxCommandAgeMs: number;
      aliases?: string[];
      plan: (
        source: PreviewSource,
        command: Extract<PreviewCommand, { kind: "start" }>,
      ) => Promise<PreviewPlanReport>;
      hourlyCents: (plan: PreviewPlanReport) => number;
      urls: (
        entry: NonNullable<Awaited<ReturnType<PreviewEngine["status"]>>>,
      ) => Record<string, string>;
    },
  ) {
    if (
      !/^[a-z0-9-]{1,63}$/.test(options.installationId) ||
      !Number.isSafeInteger(options.maxCommandAgeMs) ||
      options.maxCommandAgeMs < 1
    )
      throw new Error("Invalid controller installation policy.");
    if (options.aliases?.some((alias) => !isPreviewAlias(alias)))
      throw new Error("Invalid installed preview aliases.");
  }
  private identity(change: number): PreviewIdentity {
    return { forgeHost: this.options.forgeHost, projectId: this.options.projectId, change };
  }
  private key(change: number): string {
    return `installations/${this.options.installationId}/inbox/${previewIdentityKey(this.identity(change))}`;
  }
  private async inbox(change: number): Promise<Inbox> {
    const key = this.key(change),
      store = this.options.store;
    const previous = await store.read(key, decodeInbox);
    if (previous) {
      if (previewIdentityKey(previous.value.identity) !== previewIdentityKey(this.identity(change)))
        throw new Error("Foreign preview inbox.");
      return previous.value;
    }
    // A lost inbox for an established environment needs operator recovery, never replay from zero.
    if (await this.options.engine.status(this.identity(change)))
      throw new Error("Established preview inbox is missing.");
    const value: Inbox = {
      schemaVersion: 1,
      identity: this.identity(change),
      scannedThrough: 0,
      closedThrough: 0,
      processed: [],
    };
    try {
      await store.compareAndSwap(key, null, value);
    } catch (error) {
      if (!(error instanceof PreviewStateConflict)) throw error;
    }
    const result = await store.read(key, decodeInbox);
    if (!result) throw new Error("Preview inbox initialization outcome is uncertain.");
    return result.value;
  }
  private async update(change: number, update: (row: Inbox) => Inbox): Promise<Inbox> {
    return (
      await updatePreviewState({
        store: this.options.store,
        key: this.key(change),
        validate: decodeInbox,
        update: (row) => {
          if (previewIdentityKey(row.identity) !== previewIdentityKey(this.identity(change)))
            throw new Error("Foreign preview inbox.");
          row.processed = row.processed.filter(
            (receipt) => this.options.now() - receipt.at <= this.options.maxCommandAgeMs,
          );
          return update(row);
        },
      })
    ).value;
  }
  private async mark(change: number, command: ForgeComment): Promise<void> {
    await this.update(change, (row) => {
      row.needsStatus = true;
      if (!row.processed.some((receipt) => receipt.id === command.id))
        row.processed.push({ id: command.id, at: command.createdAt });
      return row;
    });
  }
  async scan(change: number): Promise<void> {
    try {
      await this.scanCommands(change);
    } catch (error) {
      const entry = await this.options.engine.status(this.identity(change));
      if (
        entry &&
        (["stopping", "cleanup-pending"].includes(entry.session.status) ||
          this.options.now() >=
            (entry.session.firstReadyAt === undefined
              ? entry.session.setupDeadline
              : entry.session.expiresAt))
      )
        await this.options.engine.reconcile(this.identity(change));
      throw error;
    }
  }
  private async scanCommands(change: number): Promise<void> {
    const identity = this.identity(change),
      now = this.options.now();
    let inbox = await this.inbox(change);
    let respond = false;
    // Read complete history through a fixed upper boundary before any admission or provider effect.
    const snapshot = await this.options.forge.snapshot(change, false);
    const comments =
      snapshot.open && snapshot.sameProject
        ? await this.options.forge.commands(
            change,
            Math.max(0, now - this.options.maxCommandAgeMs),
            now,
          )
        : [];
    if (previewIdentityKey(snapshot.identity) !== previewIdentityKey(identity))
      throw new Error("Forge snapshot identity differs.");
    if (!snapshot.open || !snapshot.sameProject) {
      await this.options.engine.close(identity);
      inbox = await this.update(change, (row) => ({
        ...row,
        closedThrough: Math.max(row.closedThrough, now),
        scannedThrough: Math.max(row.scannedThrough, now),
      }));
    } else {
      const existing = await this.options.engine.status(identity);
      if (
        existing?.session.reservationHeld &&
        snapshot.commandAfter !== undefined &&
        Math.floor(snapshot.commandAfter / 1000) >= Math.floor(existing.session.createdAt / 1000)
      )
        await this.options.engine.close(identity);
      await this.options.engine.pushed(identity, snapshot.source.head);
      const candidates: Array<{
        comment: ForgeComment;
        admission: Omit<PreviewAdmission, "plan" | "hourlyCents">;
      }> = [];
      for (const comment of comments) {
        if (
          inbox.processed.some((row) => row.id === comment.id) ||
          comment.createdAt <= Math.max(inbox.closedThrough, snapshot.commandAfter ?? 0)
        )
          continue;
        const admission = await this.options.forge.admission(change, comment.id);
        if (
          !admission?.actorCanWrite ||
          !admission.originalHumanRoot ||
          !admission.sameProject ||
          !admission.open
        ) {
          continue;
        }
        if (
          admission.commandId !== comment.id ||
          admission.createdAt !== comment.createdAt ||
          previewIdentityKey(admission.identity) !== previewIdentityKey(identity) ||
          JSON.stringify(admission.command) !== JSON.stringify(comment.command)
        )
          throw new Error("Forge command changed during recovery.");
        candidates.push({ comment, admission });
        respond = true;
      }
      const kinds = candidates.map((row) => row.admission.command.kind);
      const lastStop = kinds.lastIndexOf("stop"),
        lastStart = kinds.lastIndexOf("start");
      for (const [index, { comment, admission }] of candidates.entries()) {
        // Newest explicit start coalesces earlier starts; a later stop dominates all older work.
        if (index < lastStop || (admission.command.kind === "start" && index !== lastStart)) {
          await this.mark(change, comment);
          continue;
        }
        if (admission.command.kind === "start") {
          const source = await this.options.forge.snapshot(change);
          if (!source.open || !source.sameProject) {
            await this.options.engine.close(identity);
            await this.mark(change, comment);
            continue;
          }
          if (comment.createdAt <= (source.commandAfter ?? 0)) {
            await this.mark(change, comment);
            continue;
          }
          const plan = await this.options.plan(source.source, admission.command);
          const current = await this.options.forge.snapshot(change, false);
          if (comment.createdAt <= (current.commandAfter ?? 0)) {
            await this.mark(change, comment);
            continue;
          }
          if (
            !current.open ||
            !current.sameProject ||
            current.source.head !== source.source.head ||
            current.source.target !== source.source.target
          )
            throw new Error("Source changed before preview admission.");
          if (plan.status !== "planned") {
            await this.update(change, (row) => ({ ...row, selection: plan.status }));
            await this.mark(change, comment);
            continue;
          }
          await this.update(change, (row) => ({ ...row, selection: undefined }));
          try {
            await this.options.engine.admit({
              ...admission,
              plan,
              hourlyCents: this.options.hourlyCents(plan),
            });
          } catch (error) {
            if (!(error instanceof PreviewAdmissionSuperseded)) throw error;
          }
        } else {
          if (admission.command.kind === "extend") {
            const existing = await this.options.engine.status(identity);
            if (
              !existing ||
              !["ready", "updating"].includes(existing.session.status) ||
              existing.session.firstReadyAt === undefined ||
              existing.session.pendingDeadline ||
              existing.session.extensions >= 2 ||
              now >= existing.session.expiresAt
            ) {
              await this.mark(change, comment);
              continue;
            }
          }
          await this.options.engine.admit(admission);
        }
        await this.mark(change, comment);
      }
      inbox = await this.update(change, (row) => ({
        ...row,
        scannedThrough: Math.max(row.scannedThrough, now),
      }));
    }
    await this.options.engine.reconcile(identity);
    if (
      respond ||
      inbox.needsStatus ||
      (await this.options.engine.status(identity)) ||
      inbox.status
    )
      await this.publish(change, inbox);
  }
  private async publish(change: number, inbox: Inbox): Promise<void> {
    const identity = this.identity(change),
      entry = await this.options.engine.status(identity);
    const marker = `<!-- devrouter-installation:${this.options.installationId} -->`;
    const body = `${previewStatusBody(entry, entry?.session.status === "ready" ? this.options.urls(entry) : {})}${inbox.selection ? `\n\nSelection: ${inbox.selection}.` : ""}${this.options.aliases?.length ? `\n\nAvailable profiles: ${this.options.aliases.map((alias) => `\`${alias}\``).join(", ")}.` : ""}\n\n${marker}`;
    const fingerprint = createHash("sha256").update(body).digest("hex"),
      now = this.options.now();
    if (inbox.status?.bodyDigest === fingerprint) {
      if (inbox.needsStatus) await this.update(change, (row) => ({ ...row, needsStatus: false }));
      return;
    }
    if (inbox.status?.publishedAt !== undefined && now - inbox.status.publishedAt < 15_000) return;
    const current = await this.options.engine.status(identity);
    if (JSON.stringify(current?.session) !== JSON.stringify(entry?.session)) return;
    let commentId = inbox.status?.commentId;
    if (!commentId) commentId = (await this.options.forge.findStatus(change, marker)) ?? undefined;
    let create = false;
    const intentId = randomUUID();
    if (!inbox.status)
      inbox = await this.update(change, (row) => {
        create = !row.status;
        return {
          ...row,
          status: row.status ?? { intentAt: now, intentId, ...(commentId ? { commentId } : {}) },
        };
      });
    commentId ??= inbox.status?.commentId;
    if (!commentId && !create) return; // unknown POST outcome: observe, never duplicate-create
    let id: string;
    try {
      id = await this.options.forge.publish(change, body, commentId);
    } catch (error) {
      if (error instanceof PreviewForgeNotSent && !commentId && create)
        await this.update(change, (row) => {
          if (row.status?.intentId === intentId && !row.status.commentId) delete row.status;
          return row;
        });
      throw error;
    }
    await this.update(change, (row) => ({
      ...row,
      needsStatus: false,
      status: {
        intentAt: row.status?.intentAt ?? now,
        intentId: row.status?.intentId ?? intentId,
        commentId: id,
        bodyDigest: fingerprint,
        publishedAt: now,
      },
    }));
  }
  async sweep(): Promise<void> {
    const active = (await this.options.engine.identities()).filter(
      (id) => id.forgeHost === this.options.forgeHost && id.projectId === this.options.projectId,
    );
    const known = new Set(active.map((id) => id.change));
    let failures = 0;
    for (const change of known) {
      try {
        await this.scan(change);
      } catch {
        failures++;
      }
    }
    const discovered = await this.options.forge.changes(
      Math.max(0, this.options.now() - this.options.maxCommandAgeMs),
    );
    if (discovered.length > 128)
      throw new Error(
        "Installation recovery scan exceeds its bound; active cleanup was still attempted.",
      );
    for (const change of discovered.filter((id) => !known.has(id))) {
      try {
        await this.scan(change);
      } catch {
        failures++;
      }
    }
    if (failures)
      throw new Error(`Preview sweep could not reconcile ${failures} registered changes.`);
  }
}
