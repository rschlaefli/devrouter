import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: {
    devrouter: "src/cli.ts",
  },
  format: ["cjs"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  shims: false,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
