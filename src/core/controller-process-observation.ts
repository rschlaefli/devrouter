import { runControllerProbeStatus } from "./controller-probe";

// Execute only in the already-proven exact container. The inner deadline also
// bounds execution if the host Docker client loses its connection.
// Exit 0 proves the expected generation is present, exit 3 proves it is absent,
// and every other outcome is ambiguous and must stay unobservable.
const PROCESS_OBSERVATION = String.raw`
set -euo pipefail
name="$1"
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 1
file="${"$"}{DEVROUTER_PROCESS_STATE_DIR:-/tmp}/devrouter-process-$name.state"
[ ! -L "$file" ] || exit 1
# A missing marker is positive absence: the expected process was never recorded.
[ -f "$file" ] || exit 3
[ "$(stat -c %s "$file")" -le 4096 ] || exit 1
before="$(head -c 4097 "$file")"
read -r pid pgid fingerprint extra <<<"$before"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" = "$pgid" ] || exit 1
[[ "$fingerprint" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:-]*$ ]] && [ -z "$extra" ] || exit 1
identity() {
  local statline rest state parent actual_group fields
  [ -r "/proc/$pid/stat" ] && [ -r "/proc/$pid/environ" ] || return 1
  statline="$(head -c 4097 "/proc/$pid/stat")"
  rest="${"$"}{statline##*) }"
  read -r -a fields <<<"$rest"
  state="${"$"}{fields[0]}"
  actual_group="${"$"}{fields[2]}"
  [ "$state" != Z ] && [ "$state" != X ] && [ "$actual_group" = "$pgid" ] || return 1
  [[ "${"$"}{fields[19]}" =~ ^[0-9]+$ ]] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "DEVROUTER_PROCESS_NAME=$name" >/dev/null || return 1
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "DEVROUTER_PROCESS_FINGERPRINT=$fingerprint" >/dev/null || return 1
  printf '%s' "${"$"}{fields[19]}"
}
birth="$(identity)" || exit 3
[ "$birth" = "$(identity)" ] || exit 1
[ ! -L "$file" ] || exit 1
[ "$before" = "$(head -c 4097 "$file")" ] || exit 3
printf '%s %s %s\n' "$pid" "$birth" "$fingerprint"
`;

const PROCESS_ABSENT_EXIT = 3;

/** Positive absence is distinct from an unobservable process. */
export type ControllerProcessObservation =
  | { kind: "present"; identity: string }
  | { kind: "absent" };

/**
 * Returns transient process identity only. A missing or stopped recorded
 * generation is positive absence; ambiguous or unavailable evidence rejects so
 * the caller keeps it unobservable rather than treating it as a failure.
 */
export async function observeControllerProcess(
  containerId: string,
  name: string,
  signal: AbortSignal,
): Promise<ControllerProcessObservation> {
  if (!/^[a-f0-9]{12,64}$/.test(containerId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name))
    throw new Error("Process observation identity is invalid.");
  const result = await runControllerProbeStatus(
    "docker",
    [
      "exec",
      containerId,
      "timeout",
      "--signal=KILL",
      "2s",
      "bash",
      "-c",
      PROCESS_OBSERVATION,
      "observer",
      name,
    ],
    signal,
  );
  if (result.code === PROCESS_ABSENT_EXIT) return { kind: "absent" };
  if (result.code !== 0) throw new Error("Process observation is unavailable.");
  const identity = result.output.trim();
  if (!/^[1-9][0-9]* [0-9]+ [a-zA-Z0-9][a-zA-Z0-9._:-]{0,4095}$/.test(identity))
    throw new Error("Process observation is unavailable.");
  return { kind: "present", identity };
}
