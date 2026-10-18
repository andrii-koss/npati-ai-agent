/** Text transformations shared by canonical tools and the local workspace. */
export function detectEol(content: string): { eol: "lf" | "crlf"; mixed: boolean } {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return { eol: crlf > 0 && crlf >= lf ? "crlf" : "lf", mixed: crlf > 0 && lf > 0 };
}

export function detectEncoding(content: string): { encoding: "utf8" | "utf8-bom"; bom: boolean } {
  return content.startsWith("\uFEFF") ? { encoding: "utf8-bom", bom: true } : { encoding: "utf8", bom: false };
}

export function toEol(content: string, eol: "lf" | "crlf"): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/** Preserve literal replacement text and the existing file's newline convention. */
export function replaceLiteralText(content: string, find: string, replacement: string, replaceAll = false): string {
  const literal = toEol(replacement, detectEol(content).eol);
  return replaceAll ? content.split(find).join(literal) : content.replace(find, () => literal);
}
