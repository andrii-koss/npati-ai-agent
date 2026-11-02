import { CodeToolError } from "./code-tool-runtime-errors";
import { normalizeWorkspacePath } from "./code-tools-path";
import { patchTargets } from "./code-tools-patch";

/** Recognize explicit file lists, not inferred focus words or paths mentioned in quoted source. */
export function explicitUserWritePaths(prompt: string): string[] | undefined {
  prompt = prompt.replace(/```[\s\S]*?```/g, "");
  const marker = /(?:^|[.!?\n]\s*)(?:змінюй|редагуй|изменяй|редактируй|edit|modify|change)\s+(?:лише|тільки|только|only)\s+/giu;
  const matches = [...prompt.matchAll(marker)];
  const match = matches[0];
  if (!match || matches.length !== 1) return undefined;
  let tail = prompt.slice(match.index! + match[0].length);
  const paths: string[] = [];
  for (let index = 0; index < 20; index++) {
    const file = /^(?:`([^`\n]+)`|([\p{L}\p{N}_./-]+\.[A-Za-z0-9]+))/u.exec(tail);
    if (!file) return undefined;
    try { paths.push(normalizeWorkspacePath(file[1] ?? file[2], { tool: "user_file_scope", allowEmpty: false })); } catch { return undefined; }
    tail = tail.slice(file[0].length);
    if (/^\s*(?:$|[.!?;\n]|,?\s*(?:решту|решта|інші|остальные|leave|do not)(?=\s|$))/iu.test(tail)) return [...new Set(paths)];
    const separator = /^\s*(?:,|(?:та|і|и|and)(?=\s))\s*/iu.exec(tail);
    if (!separator) return undefined;
    tail = tail.slice(separator[0].length);
  }
  return undefined;
}

/** Model-controlled writes must not expand a user's exact file list during verification repair. */
export function assertUserFileScope(tool: string, args: Record<string, unknown>, allowed: readonly string[], write: boolean): void {
  const fileTools = ["code.fs.edit", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.apply_patch"];
  if (tool === "code.verify.run" || tool.startsWith("code.preview.")) return;
  const deny = () => { throw new CodeToolError("file_scope_denied", `The user restricted edits to: ${allowed.join(", ")}. Report failures outside that scope; do not repair other files or bypass this restriction.`, 403, "policy", false, tool); };
  if (fileTools.includes(tool)) {
    const paths = tool === "code.fs.apply_patch" ? patchTargets(String(args.patch ?? "")).map(file => file.path)
      : [args.path, args.from, args.to].filter((value): value is string => typeof value === "string");
    if (!paths.length || paths.some(file => !allowed.includes(normalizeWorkspacePath(file, { tool, allowEmpty: false })))) deny();
  } else if (write || /^code\.(?:shell|deps|git|subagents?|agents?)\./.test(tool)) deny();
}
