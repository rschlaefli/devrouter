import { northflankQualificationKeys } from "../src/core/preview/providers/northflank";

// No resources are created: this reports prerequisites for a separately scoped live trial.
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      provider: "northflank",
      qualified: false,
      mode: "source-only",
      requiredProofs: northflankQualificationKeys,
      sourceVerification: "pnpm exec vitest run src/core/preview/__tests__/northflank.test.ts",
      liveTrial:
        "Requires exact installation, credentials, spend, lifetime and teardown authority.",
    },
    null,
    2,
  )}\n`,
);
process.exitCode = 3;
