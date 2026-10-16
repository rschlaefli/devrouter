/** Parse a positive `<n><s|m|h|d|w>` duration flag such as `30m` or `30d`. */
export function parseInactiveFor(
  value = "30d",
  flag = "--inactive-for",
): {
  input: string;
  seconds: number;
} {
  const match = /^(?<amount>[1-9]\d*)(?<unit>[smhdw])$/.exec(value);
  if (!match?.groups) {
    throw new Error(
      `${flag} must be a positive integer followed by s, m, h, d, or w (for example 30d).`,
    );
  }
  const amount = Number(match.groups.amount);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[
    match.groups.unit as "s" | "m" | "h" | "d" | "w"
  ];
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${flag} is too large.`);
  }
  return { input: value, seconds };
}
