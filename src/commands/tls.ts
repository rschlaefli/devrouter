import { installTLS } from "../core/tls";

export async function runTLSInstallCommand(): Promise<void> {
  const result = await installTLS();

  if (result.alreadyEnabled) {
    process.stdout.write("TLS was already enabled and has been refreshed.\n");
    return;
  }

  process.stdout.write("TLS is now enabled for localhost and *.localhost.\n");
}
