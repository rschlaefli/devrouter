function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value + " ".repeat(width - value.length);
}

export function renderTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) {
    return "";
  }

  const widths = headers.map((header, index) => {
    const rowWidth = rows.reduce((max, row) => {
      const cell = row[index] ?? "";
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(header.length, rowWidth);
  });

  const headerLine = headers.map((header, idx) => pad(header, widths[idx])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join("  "))
    .join("\n");

  if (!body) {
    return `${headerLine}\n${separator}`;
  }

  return `${headerLine}\n${separator}\n${body}`;
}
