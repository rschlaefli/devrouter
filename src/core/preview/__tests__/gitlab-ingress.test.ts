import { describe, expect, it } from "vitest";
import { createGitLabPreviewIngress } from "../ingress/gitlab";

function fixture() {
  const calls: { url: string; body: unknown }[] = [];
  const handler = createGitLabPreviewIngress({
    hookSecret: async () => "s".repeat(40),
    triggerToken: async () => "synthetic-pipeline-token",
    apiUrl: "https://gitlab.example.org/api/v4/",
    controllerProjectId: "7",
    controllerRef: "preview-controller-v1",
    candidateProjectId: "123",
    installedProjectKey: "app",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 201 });
    },
  });
  const body = {
    object_kind: "note",
    project: { id: 123 },
    object_attributes: {
      id: 1,
      project_id: 123,
      noteable_type: "MergeRequest",
      action: "create",
      system: false,
      note: "/preview start web",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    merge_request: { iid: 9, source_project_id: 123, target_project_id: 123 },
  };
  const request = (value = body, secret = "s".repeat(40)) =>
    new Request("https://ingress.example.org/hooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gitlab-token": secret,
        "x-gitlab-event": "Note Hook",
        "x-gitlab-event-uuid": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify(value),
    });
  return { handler, body, request, calls };
}

describe("GitLab serverless note ingress", () => {
  it("triggers only the installed controller with numeric identity hints", async () => {
    const f = fixture();
    expect((await f.handler(f.request())).status).toBe(202);
    expect(f.calls).toEqual([
      {
        url: "https://gitlab.example.org/api/v4/projects/7/trigger/pipeline",
        body: {
          token: "synthetic-pipeline-token",
          ref: "preview-controller-v1",
          inputs: { preview_mode: "handle-event", preview_project: "app", preview_change: "9" },
        },
      },
    ]);
  });
  it("ignores issue comments that carry no merge request payload", async () => {
    const f = fixture();
    const { merge_request: _merge, ...payload } = f.body;
    payload.object_attributes.noteable_type = "Issue";
    const request = new Request("https://ingress.example.org/hooks/gitlab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gitlab-token": "s".repeat(40),
        "x-gitlab-event": "Note Hook",
        "x-gitlab-event-uuid": "00000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify(payload),
    });
    expect((await f.handler(request)).status).toBe(204);
    expect(f.calls).toEqual([]);
  });
  it("rejects wrong secrets and ignores edits, foreign projects and noncommands", async () => {
    const f = fixture();
    expect((await f.handler(f.request(f.body, "wrong"))).status).toBe(401);
    f.body.object_attributes.action = "update";
    expect((await f.handler(f.request())).status).toBe(204);
    f.body.object_attributes.action = "create";
    f.body.project.id = 999;
    expect((await f.handler(f.request())).status).toBe(204);
    f.body.project.id = 123;
    f.body.object_attributes.note = "ordinary discussion";
    expect((await f.handler(f.request())).status).toBe(204);
    expect(f.calls).toEqual([]);
  });
});
