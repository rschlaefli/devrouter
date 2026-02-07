export async function runHostAttachCommand(): Promise<void> {
  throw new Error(
    "Legacy command 'dev host attach' is no longer supported. Use 'dev app run <name> [--repo <path>]'."
  );
}
