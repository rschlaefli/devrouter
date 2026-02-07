export async function runHostLsCommand(): Promise<void> {
  throw new Error(
    "Legacy command 'dev host ls' is no longer supported. Use 'dev app ls [--repo <path>] [--json]'."
  );
}
