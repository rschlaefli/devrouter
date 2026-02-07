export async function runHostRmCommand(): Promise<void> {
  throw new Error(
    "Legacy command 'dev host rm' is no longer supported. Use 'dev app rm <name> [--repo <path>]'."
  );
}
