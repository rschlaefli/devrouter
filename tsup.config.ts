import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    dev: "src/cli.ts"
  },
  format: ["cjs"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  splitting: false,
  dts: false,
  shims: false
});
