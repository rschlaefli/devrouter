export async function runHostRunCommand(): Promise<void> {
  throw new Error(
    "Legacy command 'dev host run' is no longer supported. Use 'dev app run <name> [--repo <path>]'."
  );
}
