import { timingSafeEqual } from "node:crypto";
import { parsePreviewCommand } from "../command";
import { forgeId, forgeObject as object } from "../forge/status";
import { readPreviewResponse } from "../http";

/** Fetch-compatible serverless ingress. Holds a pipeline trigger token, never deployment credentials. */
export function createGitLabPreviewIngress(options: {
  hookSecret: () => Promise<string>;
  triggerToken: () => Promise<string>;
  apiUrl: string;
  controllerProjectId: string;
  controllerRef: string;
  candidateProjectId: string;
  installedProjectKey: string;
  fetch?: typeof fetch;
}) {
  const base = new URL(options.apiUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.port ||
    base.pathname !== "/api/v4/" ||
    !/^[A-Za-z0-9_./-]{1,128}$/.test(options.controllerRef) ||
    options.controllerRef.includes("..") ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(options.installedProjectKey)
  )
    throw new Error("Invalid registered GitLab ingress policy.");
  forgeId(options.controllerProjectId);
  forgeId(options.candidateProjectId);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let secret: string;
    try {
      secret = await options.hookSecret();
    } catch {
      return new Response(null, { status: 503 });
    }
    const presented = request.headers.get("x-gitlab-token") ?? "";
    if (
      secret.length < 32 ||
      secret.length > 256 ||
      presented.length > 256 ||
      Buffer.byteLength(secret) !== Buffer.byteLength(presented) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(presented))
    )
      return new Response(null, { status: 401 });
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
      return new Response(null, { status: 415 });
    if (
      request.headers.get("x-gitlab-event") !== "Note Hook" ||
      !/^[a-f0-9-]{36}$/i.test(request.headers.get("x-gitlab-event-uuid") ?? "")
    )
      return new Response(null, { status: 400 });
    let payload: Record<string, unknown>;
    try {
      payload = object(
        JSON.parse(await readPreviewResponse(new Response(request.body), "GitLab hook", 64 * 1024)),
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      if (payload.object_kind !== "note") return new Response(null, { status: 204 });
      const note = object(payload.object_attributes);
      if (note.noteable_type !== "MergeRequest") return new Response(null, { status: 204 });
      const merge = object(payload.merge_request),
        project = object(payload.project);
      if (
        payload.object_kind !== "note" ||
        forgeId(project.id) !== options.candidateProjectId ||
        forgeId(note.project_id) !== options.candidateProjectId ||
        note.noteable_type !== "MergeRequest" ||
        note.action !== "create" ||
        note.system !== false ||
        note.created_at !== note.updated_at ||
        note.line_code ||
        typeof note.note !== "string" ||
        !parsePreviewCommand(note.note) ||
        merge.target_project_id !== Number(options.candidateProjectId) ||
        merge.source_project_id !== Number(options.candidateProjectId)
      )
        return new Response(null, { status: 204 });
      const change = forgeId(merge.iid);
      forgeId(note.id);
      let token: string;
      try {
        token = await options.triggerToken();
      } catch {
        return new Response(null, { status: 503 });
      }
      if (!token || /\s/.test(token)) return new Response(null, { status: 503 });
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(
          new URL(`projects/${options.controllerProjectId}/trigger/pipeline`, base),
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token,
              ref: options.controllerRef,
              inputs: {
                preview_mode: "handle-event",
                preview_project: options.installedProjectKey,
                preview_change: change,
              },
            }),
          },
        );
      } catch {
        return new Response(null, { status: 503 });
      }
      await response.body?.cancel();
      return new Response(null, { status: response.ok ? 202 : 503 });
    } catch {
      return new Response(null, { status: 400 });
    }
  };
}
