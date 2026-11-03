import { CodeToolError } from "./code-tool-runtime-errors";

/** The existing workspace read rule, shared with agent pre-write validation without changing its policy. */
export function isWorkspaceManifest(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(?:json|lock)|requirements\.txt|Pipfile(?:\.lock)?)$/i.test(name);
}

const isTestFile = (filePath: string) => /(?:^|[\\/])(?:tests?|__tests__|spec|specs|e2e|fixtures?)[\\/]|\.(?:test|spec)\.[A-Za-z0-9]+$/i.test(filePath);

/**
 * A quoted value under a credential-like name. Messages and labels (spaces or non-Latin letters) and names of a
 * storage key, field or header ("TOKEN_KEY", "passwordLabel") are ordinary code, not credentials. So are the sample
 * passwords of a test file. Real key formats stay refused everywhere, by `isWorkspaceContentProtected`.
 */
export function hasQuotedCredential(content: string, filePath = ""): boolean {
  if (isTestFile(filePath)) return false;
  const assignments = /(?<![-A-Za-z0-9_])([A-Za-z0-9_]*(?:api[_-]?key|password|secret|token)(?![sS]\b)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']([^"']{8,})["']/gi;
  for (const [, name, value] of content.matchAll(assignments)) {
    if (/\s|[^\x00-\x7F]/.test(value!)) continue;
    const secretKeyName = /(?:api|secret|access|private)[_-]?key$/i.test(name!);
    if (!secretKeyName && /(?:key|name|storage|header|field|label|error|message|placeholder|hint|title|path|url|type|param|cookie|prefix|regex|pattern)$/i.test(name!)) continue;
    return true;
  }
  return false;
}

export function isWorkspaceContentProtected(filePath: string, content: string): boolean {
  return !isWorkspaceManifest(filePath) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/i.test(content) || !isWorkspaceManifest(filePath) && hasQuotedCredential(content, filePath);
}

export function assertCodeWriteReadable(filePath: string, content: string, tool: string): void {
  if (isWorkspaceContentProtected(filePath, content)) {
    throw new CodeToolError("secret_content", "Write refused before persistence: this content would be unreadable under workspace protection. Generate test credentials at runtime and use approved secret environment references. The file was not changed. This is not an approval request: user approval cannot override content protection. Do not offer an exception or suggest moving the same protected content through another tool.", 403, "guard", false, tool, { path: filePath, approvalCanOverride: false });
  }
}
