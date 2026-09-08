import { expect, it } from "vitest";
import { ControllerProbeUnavailable, runControllerProbe } from "../controller-probe";

it("collects bounded successful output without retaining stderr", async () => {
  const result = await runControllerProbe(
    process.execPath,
    ["-e", "process.stderr.write('transient');process.stdout.write('ready')"],
    new AbortController().signal,
  );
  expect(result).toBe("ready");
});
it("distinguishes absent executables from failed installed probes", async () => {
  await expect(
    runControllerProbe("/fixture/absent-observer-executable", [], new AbortController().signal),
  ).rejects.toMatchObject({ missingExecutable: true });
  await expect(
    runControllerProbe(process.execPath, ["-e", "process.exit(1)"], new AbortController().signal),
  ).rejects.not.toBeInstanceOf(ControllerProbeUnavailable);
});
it("cancels its exact child and omits raw output from failures", async () => {
  const abort = new AbortController();
  const result = runControllerProbe(
    process.execPath,
    ["-e", "process.stderr.write('private-fixture-output');setInterval(()=>{},1000)"],
    abort.signal,
  );
  const timer = setTimeout(() => abort.abort(), 50);
  try {
    await expect(result).rejects.toThrow("Observation process failed or exceeded its bound.");
  } finally {
    clearTimeout(timer);
  }
});
it("rejects excess output", async () => {
  await expect(
    runControllerProbe(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1048577))"],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it("passes transient stdin and scoped environment without shell evaluation", async () => {
  const result = await runControllerProbe(
    process.execPath,
    [
      "-e",
      "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,value:process.env.OBSERVATION_FIXTURE,git:process.env.GIT_OPTIONAL_LOCKS})))",
    ],
    new AbortController().signal,
    { input: "literal $(ignored)\n", env: { OBSERVATION_FIXTURE: "fixture" } },
  );
  expect(JSON.parse(result)).toEqual({ input: "literal $(ignored)\n", value: "fixture", git: "0" });
});
it("cancels probe descendants that inherit output pipes", async () => {
  const abort = new AbortController();
  const result = runControllerProbe(
    process.execPath,
    [
      "-e",
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)",
    ],
    abort.signal,
  );
  const timer = setTimeout(() => abort.abort(), 150);
  try {
    await expect(result).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
}, 2000);
