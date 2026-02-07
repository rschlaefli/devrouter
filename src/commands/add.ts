import path from "node:path";
import { addOrUpdateAppConfig } from "../core/add-app";
import { AddOptions } from "../types";

export async function runAddCommand(options: AddOptions): Promise<void> {
  const result = addOrUpdateAppConfig(options);
  const fileName = path.basename(result.filePath);

  process.stdout.write(`Wrote ${result.filePath}\n`);
  process.stdout.write(`Host: ${result.host}\n`);
  process.stdout.write("Run your app with:\n");
  process.stdout.write(`docker compose -f docker-compose.yml -f ${fileName} up\n`);
}
