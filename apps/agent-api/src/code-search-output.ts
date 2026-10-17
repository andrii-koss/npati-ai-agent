import { SandboxProviderError } from "./sandbox-provider";
export interface CodeSearchLine { path: string; line: number; text: string; context?: Array<{ line: number; text: string }> }
/** Decode rg JSON so colons in file names and context lines retain their meaning. */
export function parseCodeSearchOutput(stdout: string, maxResults: number, contextLines: number) {
  const matches: CodeSearchLine[] = [], contexts = new Map<string, Array<{ line: number; text: string }>>();
  let truncated = false;
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    if (!raw.startsWith("{")) {
      const legacy = /^(.*?):(\d+):(.*)$/.exec(raw);
      if (legacy && matches.length < maxResults) matches.push({ path: legacy[1]!.replace(/^\.\//, ""), line: Number(legacy[2]), text: legacy[3]!.slice(0, 500) });
      else if (legacy) truncated = true;
      continue;
    }
    let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try { event = JSON.parse(raw); } catch { throw new SandboxProviderError("search_failed", "Sandbox search returned malformed JSON", 502); }
    if (event.type !== "match" && event.type !== "context") continue;
    const data = event.data;
    if (!data || typeof data.path?.text !== "string" || !Number.isSafeInteger(data.line_number) || typeof data.lines?.text !== "string")
      throw new SandboxProviderError("search_failed", "Sandbox search returned an invalid match", 502);
    const file = data.path.text.replace(/^\.\//, "");
    if (file.startsWith("../") || file.startsWith("/")) throw new SandboxProviderError("search_failed", "Search returned a path outside the project", 403);
    const line = { line: data.line_number!, text: data.lines.text.replace(/\r?\n$/, "").slice(0, 500) };
    if (event.type === "context") { const prior = contexts.get(file) ?? []; prior.push(line); contexts.set(file, prior); }
    else if (matches.length < maxResults) matches.push({ path: file, ...line });
    else truncated = true;
  }
  if (contextLines > 0) for (const match of matches) {
    const nearby = (contexts.get(match.path) ?? []).filter(line => Math.abs(line.line - match.line) <= contextLines);
    if (nearby.length) match.context = nearby;
  }
  return { matches, truncated, engine: "ripgrep" as const };
}
