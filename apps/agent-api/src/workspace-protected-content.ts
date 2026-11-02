import { CodeToolError } from "./code-tool-runtime-errors";

/** The existing workspace read rule, shared with agent pre-write validation without changing its policy. */
export function isWorkspaceManifest(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(?:json|lock)|requirements\.txt|Pipfile(?:\.lock)?)$/i.test(name);
}

export function isWorkspaceContentProtected(filePath: string, content: string): boolean {
  return !isWorkspaceManifest(filePath) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b|(?<![-A-Za-z0-9_])(?:[A-Za-z0-9_]*(?:api[_-]?key|password|secret|token)(?![sS]\b)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'][^"']{8,}["']/i.test(content);
}

export function assertCodeWriteReadable(filePath: string, content: string, tool: string): void {
  if (isWorkspaceContentProtected(filePath, content)) {
    throw new CodeToolError("secret_content", "Write refused before persistence: this content would be unreadable under workspace protection. Generate test credentials at runtime and use approved secret environment references. The file was not changed. This is not an approval request: user approval cannot override content protection. Do not offer an exception or suggest moving the same protected content through another tool.", 403, "guard", false, tool, { path: filePath, approvalCanOverride: false });
  }
}
