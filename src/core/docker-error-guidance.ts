const NO_SPACE_LEFT_RE = /no space left on device/i;

export function withDockerFailureGuidance(details: string): string {
  const base = details.trim() || "unknown error";

  if (!NO_SPACE_LEFT_RE.test(base)) {
    return base;
  }

  return (
    `${base}\n\n` +
    'Docker storage appears full ("no space left on device"). ' +
    "Free Docker disk space using your preferred method, then retry the command."
  );
}
