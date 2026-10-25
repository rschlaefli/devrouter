import { describe, expect, it } from "vitest";

import { parsePreviewCommand } from "../command";

describe("parsePreviewCommand", () => {
  it.each([
    [" /preview start ", { kind: "start", aliases: [] }],
    ["/preview start chat,ai-mcp", { kind: "start", aliases: ["chat", "ai-mcp"] }],
    ["/preview start 1-chat", { kind: "start", aliases: ["1-chat"] }],
    ["/preview extend", { kind: "extend" }],
    ["/preview extend 1h", { kind: "extend" }],
    ["/preview stop", { kind: "stop" }],
    ["/preview status", { kind: "status" }],
    ["/preview profiles", { kind: "profiles" }],
  ])("accepts %s", (text, expected) => {
    expect(parsePreviewCommand(text)).toEqual(expected);
  });

  it.each([
    "",
    "/preview",
    "/preview start CHAT",
    "/preview start chat ai",
    "/preview start chat,",
    "/preview start chat,chat",
    `/preview start ${"a".repeat(64)}`,
    "/preview extend 2h",
    "/preview stop now",
    "```/preview status```",
    '"/preview status"',
    "/preview status\n/preview stop",
    "/preview status\n",
  ])("rejects malformed input %j", (text) => {
    expect(parsePreviewCommand(text)).toBeNull();
  });

  it("rejects commands over 512 UTF-8 bytes after otherwise valid padding", () => {
    expect(parsePreviewCommand(`${"/preview status"}${" ".repeat(498)}`)).toBeNull();
  });
});
