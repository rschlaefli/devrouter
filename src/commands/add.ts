export async function runLegacyAddCommand(): Promise<void> {
  throw new Error(
    "Legacy command 'dev add' is no longer supported. Use:\n1) dev repo init [--repo <path>]\n2) dev app add --name <name> --host <host.localhost> --protocol <http|tcp> --runtime <host|docker>"
  );
}
