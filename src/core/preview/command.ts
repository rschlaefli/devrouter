const MAX_COMMAND_BYTES = 512;
const MAX_ALIAS_LENGTH = 63;
const ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const previewRefusalReasons = [
  "update-unavailable",
  "extension-unavailable",
  "capacity",
  "command-window",
  "metadata",
  "selection-required",
] as const;
export class PreviewAdmissionRefused extends Error {
  constructor(
    readonly reason: (typeof previewRefusalReasons)[number],
    message: string,
  ) {
    super(message);
  }
}

export type PreviewCommand =
  | { kind: "start"; aliases: string[] }
  | { kind: "extend" }
  | { kind: "stop" | "status" | "profiles" };

export function parsePreviewCommand(text: string): PreviewCommand | null {
  if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES || /[\r\n]/u.test(text)) {
    return null;
  }

  const command = text.trim();
  if (command === "/preview start") {
    return { kind: "start", aliases: [] };
  }
  if (command.startsWith("/preview start ")) {
    return parseStart(command.slice("/preview start ".length));
  }
  if (command === "/preview extend" || command === "/preview extend 1h") {
    return { kind: "extend" };
  }
  if (command === "/preview stop") return { kind: "stop" };
  if (command === "/preview status") return { kind: "status" };
  if (command === "/preview profiles") return { kind: "profiles" };
  return null;
}

export function isPreviewAlias(alias: string): boolean {
  return typeof alias === "string" && alias.length <= MAX_ALIAS_LENGTH && ALIAS_PATTERN.test(alias);
}

function parseStart(rawAliases: string): PreviewCommand | null {
  const aliases = rawAliases.split(",");
  if (aliases.some((alias) => !isPreviewAlias(alias)) || new Set(aliases).size !== aliases.length) {
    return null;
  }
  return { kind: "start", aliases };
}
