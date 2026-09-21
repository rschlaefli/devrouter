/**
 * Renders a Docker `--format` template's literal scaffolding as JSON text.
 *
 * The daemon applies the template, so only this literal decides whether a
 * record can ever parse. Value actions become a placeholder, a conditional
 * block keeps only its `else` branch (the shape the daemon emits when the
 * guarded value is absent), and every other action is dropped, so a caller can
 * require that the result parses as one complete JSON object.
 */
export function renderInspectFormatScaffold(template: string): string {
  const blocks: Array<{ rendering: boolean; active: boolean }> = [];
  const rendering = () => blocks.every((block) => block.rendering && block.active);
  let output = "";
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf("{{", index);
    if (open < 0) {
      if (rendering()) output += template.slice(index);
      break;
    }
    if (rendering()) output += template.slice(index, open);
    const close = template.indexOf("}}", open + 2);
    if (close < 0) throw new Error("Inspect format has an unterminated action.");
    const action = template.slice(open + 2, close).trim();
    index = close + 2;
    const keyword = action.split(/\s+/)[0];
    if (keyword === "end") {
      if (!blocks.length) throw new Error("Inspect format closes an unopened block.");
      blocks.pop();
    } else if (keyword === "else") {
      const current = blocks[blocks.length - 1];
      if (!current) throw new Error("Inspect format branches outside a block.");
      current.active = current.rendering && !current.active;
    } else if (keyword === "with" || keyword === "range" || keyword === "if") {
      blocks.push({ rendering: rendering(), active: false });
    } else if (rendering()) {
      output += '"synthetic"';
    }
  }
  if (blocks.length) throw new Error("Inspect format leaves a block open.");
  return output;
}
