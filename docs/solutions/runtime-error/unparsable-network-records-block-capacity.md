# Unparsable network records blocked capacity evidence

Status: source correction verified locally at revision
`a2b4f92`; publication and release are pending, so the installed 0.1.2 still
carries the malformed template.

The Docker network format template in `src/core/network-inventory.ts` opened a
JSON object and never closed it, so every record the daemon returned was a
partial object. `JSON.parse` failed on every line, the catch-all reason reported
`Docker network inventory is unavailable or malformed.`, and the inventory
reported `unknown` on this machine for the whole life of the code. The defect
shipped in `#74` and in releases through 0.1.2.

The consequence was wider than a warn-level diagnostic. With unknown inventory,
`networkCapacityCheck` can never reach `ok`, `hasExhaustedDockerPools` can never
be true, and `src/core/network-managed.ts` refuses every managed allocation with
`Network inventory is unknown; allocation is blocked.`. Any repository that
enrolled capacity was blocked from allocating a subnet by a template typo, and
0.1.2's improved doctor wording named the missing input without revealing that
the input could never be read.

## Exact evidence

- Live read of the shipped function on this machine before the fix:
  `{"status":"unknown","endpoint":"unix:///Users/rschlae/.orbstack/run/docker.sock","daemon":"ded85e46-31f","pools":31,"networks":0,"reasons":["Docker network inventory is unavailable or malformed."]}`.
- The daemon's own output from the shipped template ended at
  `...,"network":"default"` with no closing brace, for all sixteen networks,
  while the neighbouring container template closed correctly and parsed 52 of 52
  records.
- The installed 0.1.2 reported
  `global.network-capacity  WARN  Network allocation readiness requires complete
  route and capacity evidence.  ... Missing evidence: Docker network inventory is
  unknown; retained container references are unknown; route evidence is
  incomplete or unknown.`
- After the correction the same read against the same daemon returns
  `{"status":"complete","pools":31,"networks":16,"withRetained":10,"reasons":[]}`,
  and the source build's doctor reports
  `global.network-capacity  OK  Docker default pools have unoccupied capacity;
  managed allocation is not configured.` with route evidence still unknown by
  design on a virtualized daemon.

## Why the suite missed it

`network-inventory.test.ts` injects `NetworkInventoryReader`, which replaces the
daemon entirely, so the tests hand the parser well-formed JSON and never exercise
the template the daemon applies. The template is the only artifact that decides
whether a record can parse, and nothing asserted it. The regression added with
the fix renders the template's literal scaffolding through the same replacement
the daemon performs and requires one complete JSON object; that assertion fails
against the shipped string.

## Prevention

- Treat a daemon format template as a protocol value: assert its scaffolding
  renders the object the reader parses, next to the tests for that reader. The
  shared renderer lives in `src/core/__tests__/inspect-format-scaffold.ts`; the
  2026-09-21 sweep found the other five daemon templates correct and pinned each
  one, including the two that are derived by string surgery at module load.
- Classify a parse failure as its own bounded evidence. The generic
  "unavailable or malformed" reason hid a total failure for weeks; a named
  `contains a malformed record` reason points at the record instead of the
  daemon.
- Qualify evidence-producing reads against the real daemon in a live harness.
  Fixture-injected readers protect the parser's behaviour, never the query that
  feeds it.
