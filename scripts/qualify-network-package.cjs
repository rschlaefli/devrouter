// Packed CLI diagnostics against closed, synthetic Docker command responses.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [packagePath, scratch] = process.argv.slice(2);
const packageDir = path.resolve(packagePath);
assert(packageDir && scratch);
const root = path.join(scratch, "network-qualification");
const bin = path.join(root, "bin");
fs.mkdirSync(bin, { recursive: true });
fs.symlinkSync("/bin/ps", path.join(bin, "ps"));
const endpoint = `unix://${path.join(root, "absent.sock")}`;
const receipt = path.join(root, "docker.jsonl");
const executable = `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(argv)+'\\n');
const reject = () => { fs.writeFileSync(${JSON.stringify(`${receipt}.unexpected`)}, 'rejected'); process.exit(97); };
let args = argv;
if (args[0] === '--host') {
  if (args[1] !== ${JSON.stringify(endpoint)}) reject();
  args = args.slice(2);
}
const print = value => process.stdout.write(JSON.stringify(value)+'\\n');
const nid = 'a'.repeat(64), cid = 'b'.repeat(64);
if (args[0] === 'info' && args[1] === '--format' && args[2].includes('.DefaultAddressPools'))
  print({id:'synthetic-daemon', pools:[{Base:'10.88.0.0/24',Size:24}]});
else if (args[0] === 'info' && args[2] === '{{json .ID}}') print('synthetic-daemon');
else if (args[0] === 'network' && args[1] === 'ls') process.stdout.write(nid+'\\n');
else if (args[0] === 'network' && args[1] === 'inspect')
  print({id:nid,name:'synthetic_default',driver:'bridge',ipam:[{Subnet:'10.88.0.0/24'}],activeEndpoints:0,project:'synthetic',network:'default'});
else if (args[0] === 'ps' && args.includes('--no-trunc')) process.stdout.write(cid+'\\n');
else if (args[0] === 'inspect' && args.includes(cid)) print({id:cid,networks:{default:{NetworkID:nid}}});
else if (args[0] === 'context' && args[1] === 'show') process.stdout.write('synthetic');
else if (args[0] === 'context' && args[1] === 'inspect') print(${JSON.stringify(endpoint)});
else if (['info','version','--version','ps'].includes(args[0]) || (args[0] === 'compose' && args[1] === 'version')) process.exit(1);
else reject();
`;
fs.writeFileSync(path.join(bin, "docker"), executable, { mode: 0o700 });
const result = spawnSync(
  process.execPath,
  [path.join(packageDir, "dist/devrouter.js"), "doctor", "--json"],
  {
    cwd: root,
    env: {
      PATH: bin,
      HOME: root,
      DEVROUTER_HOME: path.join(root, "home"),
      DOCKER_HOST: endpoint,
    },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  },
);
assert.equal(result.error, undefined);
// Unavailable unrelated tools make the doctor exit nonzero in this closed fixture.
assert([0, 1].includes(result.status));
assert(result.stdout.trim(), result.stderr);
const report = JSON.parse(result.stdout);
assert.equal(report.checks.filter((check) => check.id === "global.network-capacity").length, 1);
assert.equal(report.checks.find((check) => check.id === "global.network-capacity").level, "warn");
assert(!fs.existsSync(`${receipt}.unexpected`), "Unexpected Docker command or endpoint");
const calls = fs
  .readFileSync(receipt, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const pinned = calls
  .filter((args) => args[0] === "--host" && args[1] === endpoint)
  .map((args) => args.slice(2));
assert.equal(pinned.filter((args) => args[0] === "network" && args[1] === "inspect").length, 1);
assert.equal(
  pinned.filter((args) => args[0] === "inspect" && args.includes("b".repeat(64))).length,
  1,
);
assert.equal(pinned.filter((args) => args[0] === "info" && args[2] === "{{json .ID}}").length, 1);
assert(
  !calls
    .flat()
    .some((arg) => ["prune", "rm", "create", "start", "stop", "down", "up"].includes(arg)),
);
console.log(
  JSON.stringify({
    networkPackageQualification: "passed",
    dockerCalls: calls.length,
    retainedContainerInspections: 1,
    mutations: 0,
  }),
);
