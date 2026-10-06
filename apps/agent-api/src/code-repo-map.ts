/**
 * Repo map (C8): a concise, ranked overview of a project's files and symbols, used as context by the
 * coding agent so that large repositories and long sessions stay affordable.
 *
 * Design decisions worth keeping:
 *  - **No new dependency.** There is no tree-sitter in this repository (verified), so symbols are
 *    extracted by line-oriented per-language patterns over the file text. This is an approximation:
 *    it finds declarations, not a syntax tree. It is deliberately conservative — a missed symbol
 *    costs context, a wrong symbol costs trust.
 *  - **Structure only, never content.** The map carries paths, symbol names and short signatures.
 *    No file body is ever emitted, so a secret cannot ride along inside a "signature".
 *  - **That is not taken on faith:** the rendered text is scanned with the C4a scanner and the build
 *    *refuses* (`RepoMapSecretRejectedError`) instead of stripping, because silent removal would
 *    hide the leak from whoever caused it.
 *  - **Cache keyed by commit hash**, not mtime: a rebuilt workspace with identical content reuses
 *    the map, and a new commit must never return the old one.
 *  - **Token limit with an explicit marker:** a silently shortened map looks complete, which is the
 *    failure mode that makes an agent trust a map that is missing the file it needed.
 *  - **Off by default** (`NPATI_CODE_REPO_MAP_ENABLED`), per rule 16: new context paths do not
 *    switch themselves on. When disabled the call is a no-op, so a caller can invoke it
 *    unconditionally.
 */
import type { AuthContext } from "@npati/workspace";
import type { ProjectFileContent, ProjectFileEntry } from "./project-workspace";
import { scanTextForSecrets } from "./code-secret-scanner";

/** The narrow file surface the map needs; `ProjectWorkspace` satisfies it structurally. */
export interface RepoMapFilePort {
  listFiles(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    workspaceId?: string,
    agentId?: string,
  ): Promise<ProjectFileEntry[]>;
  readFile(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    filePath: string,
    workspaceId?: string,
    agentId?: string,
  ): Promise<ProjectFileContent>;
}

export interface RepoMapLimits {
  enabled: boolean;
  /** Token budget for the rendered map. */
  maxTokens: number;
  /** Files larger than this are mapped by name only; we never read a huge file for a signature. */
  maxFileBytes: number;
  /** Signature length cap, so one long declaration cannot consume the budget. */
  maxSignatureChars: number;
}

export const DEFAULT_REPO_MAP_LIMITS: RepoMapLimits = {
  enabled: false,
  maxTokens: 2_000,
  maxFileBytes: 256_000,
  maxSignatureChars: 160,
};

/** Directories that never carry project structure a model needs. Mirrors the sandbox's own
 *  exclusion list (`docker-sandbox-provider.ts`) so host and container agree on what "the project"
 *  is — two different notions of the tree would produce two different maps. */
const NOISE_DIRECTORIES = [
  "node_modules",
  ".git",
  "vendor",
  ".npati-runtime",
  "dist",
  "build",
  ".next",
  ".cache",
  ".venv",
  "__pycache__",
  "coverage",
  "target",
  "out",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
];

/** Paths whose *names* must never reach a prompt, even as a structural entry. */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)(\.npmrc|\.netrc|\.pgpass|\.htpasswd)$/i,
  /(^|\/)credentials?(\.|$)/i,
  /(^|\/)secrets?(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sql: "sql",
  sh: "shell",
  ps1: "powershell",
  vue: "vue",
  svelte: "svelte",
};

/** Files that are structure-free or machine-generated: mapping them is pure noise. */
const SKIP_FILE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp4|pdf|zip|gz|tar|wasm|map|snap)$/i,
  /\.d\.ts$/,
];

export class RepoMapSecretRejectedError extends Error {
  readonly code = "repo_map_secret_detected";
  readonly httpStatus = 403;
  readonly retryable = false;
  constructor(readonly kind: string) {
    super(`repo map contains a secret-shaped value (${kind})`);
    this.name = "RepoMapSecretRejectedError";
  }
}

export function isNoiseRepoPath(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments.some((segment) => NOISE_DIRECTORIES.includes(segment))) return true;
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** Exported so the caller can refuse a focus path that points at a secret before ranking it. */
export function isSecretRepoPath(filePath: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Declaration patterns per language. Each returns the capture group holding the name.
 * Deliberately narrow: `const x = 1` inside a function is not a symbol worth spending tokens on.
 */
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  ],
  python: [
    /^\s*def\s+([A-Za-z_]\w*)/,
    /^\s*class\s+([A-Za-z_]\w*)/,
  ],
  go: [
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^type\s+([A-Za-z_]\w*)/,
  ],
  rust: [
    /^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  ],
  java: [
    /^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/,
    /^\s*(?:public|protected)\s+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/,
  ],
  csharp: [
    /^\s*(?:public|internal)\s+(?:static\s+)?(?:sealed\s+)?class\s+([A-Za-z_]\w*)/,
    /^\s*(?:public|internal)\s+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/,
  ],
  ruby: [
    /^\s*def\s+([A-Za-z_]\w*[?!]?)/,
    /^\s*(?:class|module)\s+([A-Za-z_]\w*)/,
  ],
  php: [
    /^\s*(?:public|protected|private)?\s*function\s+([A-Za-z_]\w*)/,
    /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/,
  ],
  swift: [
    /^\s*(?:public\s+|internal\s+)?func\s+([A-Za-z_]\w*)/,
    /^\s*(?:public\s+|internal\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/,
  ],
  sql: [
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i,
  ],
  shell: [/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/],
  powershell: [/^\s*function\s+([A-Za-z_][\w-]*)/i],
};

// Languages that share a family's grammar share its patterns. Written as explicit copies (rather than
// aliases assigned inline) because indexed access is narrowed under `noUncheckedIndexedAccess`.
const TS_FAMILY = SYMBOL_PATTERNS.ts ?? [];
const JAVA_FAMILY = SYMBOL_PATTERNS.java ?? [];
for (const language of ["tsx", "js", "jsx", "vue", "svelte"]) {
  SYMBOL_PATTERNS[language] = TS_FAMILY;
}
SYMBOL_PATTERNS.kotlin = JAVA_FAMILY;

export function repoMapLanguageFor(filePath: string): string | null {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export interface RepoMapSymbol {
  name: string;
  exported: boolean;
  signature: string;
}

export interface RepoMapFile {
  path: string;
  language: string;
  symbols: RepoMapSymbol[];
  /** True when the file was too large to read; it is listed by name and counted as truncated. */
  skippedBody: boolean;
}

export interface ExtractSymbolsInput {
  path: string;
  language: string;
  content: string;
  maxSignatureChars: number;
}

export function extractRepoMapSymbols(input: ExtractSymbolsInput): RepoMapSymbol[] {
  const patterns = SYMBOL_PATTERNS[input.language];
  if (!patterns) return [];
  const seen = new Set<string>();
  const symbols: RepoMapSymbol[] = [];
  for (const line of input.content.split(/\r?\n/)) {
    if (symbols.length >= 200) break;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      const name = match[1];
      if (seen.has(name)) break;
      seen.add(name);
      symbols.push({
        name,
        exported: /^\s*export|\bpub\b|^\s*(?:public|internal)\b/.test(line),
        signature: line.trim().slice(0, input.maxSignatureChars),
      });
      break;
    }
  }
  return symbols;
}

export type RepoMapCache = {
  get(key: string): RepoMapResult | undefined;
  set(key: string, value: RepoMapResult): void;
  clear(): void;
  size(): number;
};

/** Bounded: an unbounded map cache is a memory leak keyed by other people's commits. */
export function createRepoMapCache(maxEntries = 32): RepoMapCache {
  const entries = new Map<string, RepoMapResult>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, value);
    },
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}

export interface RepoMapRequest {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  workspaceId?: string;
  agentId?: string;
  /** Commit the map is keyed by. Callers resolve it from the git service; `null` means "unknown". */
  commit: string | null;
  /** Task-relevant paths (edited/mentioned files) that should rank first. */
  focusPaths?: readonly string[];
  tokenLimit?: number;
  limits?: Partial<RepoMapLimits>;
}

export interface RepoMapResult {
  enabled: boolean;
  commit: string | null;
  text: string;
  tokens: number;
  files: number;
  symbols: number;
  truncated: boolean;
  omittedFiles: number;
  cacheHit: boolean;
  /** Paths whose names alone were emitted because their body was skipped. */
  skippedSecrets: number;
}

export function estimateRepoMapTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function scoreFile(file: RepoMapFile, focusPaths: readonly string[]): number {
  let score = 0;
  const depth = file.path.split("/").length - 1;
  score += Math.min(20, file.symbols.filter((symbol) => symbol.exported).length * 4);
  score += Math.min(10, file.symbols.length);
  score -= depth * 2;
  if (focusPaths.some((focus) => file.path === focus)) score += 40;
  else if (
    focusPaths.some((focus) => file.path.startsWith(`${focus.replace(/\/[^/]*$/, "")}/`))
  ) {
    score += 20;
  }
  if (file.symbols.length === 0) score -= 5;
  return score;
}

export function resolveRepoMapLimits(env: NodeJS.ProcessEnv = process.env): RepoMapLimits {
  const enabled = String(env.NPATI_CODE_REPO_MAP_ENABLED ?? "").toLowerCase() === "true";
  const rawTokens = Number(env.NPATI_CODE_REPO_MAP_TOKENS);
  const maxTokens =
    Number.isFinite(rawTokens) && rawTokens > 0
      ? Math.floor(rawTokens)
      : DEFAULT_REPO_MAP_LIMITS.maxTokens;
  return { ...DEFAULT_REPO_MAP_LIMITS, enabled, maxTokens };
}

function renderFile(file: RepoMapFile): string[] {
  const header = `${file.path} [${file.language}]${
    file.skippedBody ? " (body skipped: too large)" : ""
  }`;
  const lines = [header];
  for (const symbol of file.symbols.slice(0, 40)) {
    lines.push(`  ${symbol.exported ? "+" : " "} ${symbol.signature}`);
  }
  return lines;
}

/**
 * Builds the map. The caller passes the commit it resolved; the cache is keyed by that commit so a
 * new commit can never be served a stale map, and a rebuilt-but-identical workspace can reuse one.
 */
export async function buildRepoMap(
  ports: { files: RepoMapFilePort; cache?: RepoMapCache },
  request: RepoMapRequest,
): Promise<RepoMapResult> {
  const limits = { ...resolveRepoMapLimits(), ...request.limits };
  if (!limits.enabled) {
    return {
      enabled: false,
      commit: request.commit,
      text: "",
      tokens: 0,
      files: 0,
      symbols: 0,
      truncated: false,
      omittedFiles: 0,
      cacheHit: false,
      skippedSecrets: 0,
    };
  }

  const tokenLimit = request.tokenLimit ?? limits.maxTokens;
  const focusPaths = (request.focusPaths ?? []).filter(
    (focus) => !isSecretRepoPath(focus) && !isNoiseRepoPath(focus),
  );
  const entries = await ports.files.listFiles(
    request.ctx,
    request.companyId,
    request.projectId,
    request.workspaceId,
    request.agentId,
  );

  // The commit alone is not enough: a run edits the workspace long before anything is committed, so a
  // commit-only key would serve the pre-edit map and hand the model a stale picture of the very files
  // it just changed. The fingerprint is derived from data the port already returns (path, size,
  // revision) rather than from mtime or a clock, so the map stays a pure function of content — which
  // is also what keeps the C6b replay input deterministic. Listing is cheap; the file reads below are
  // the expensive part and remain cached.
  const fingerprint = entries
    .filter((entry) => entry.type === "file")
    .map((entry) => `${entry.path}:${entry.size ?? 0}:${entry.revision ?? ""}`)
    .sort()
    .join(",");
  const cacheKey = [
    request.companyId,
    request.projectId,
    request.workspaceId ?? "",
    request.commit ?? "no-commit",
    String(tokenLimit),
    focusPaths.join(","),
    fingerprint,
  ].join("|");

  const cached = ports.cache?.get(cacheKey);
  if (cached) return { ...cached, cacheHit: true };

  let skippedSecrets = 0;
  const mapped: RepoMapFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (isNoiseRepoPath(entry.path)) continue;
    // A secret file is never named in the map: even the name ("db-prod-credentials.txt") is data
    // the model has no need for, and the count keeps the omission auditable.
    if (isSecretRepoPath(entry.path)) {
      skippedSecrets += 1;
      continue;
    }
    const language = repoMapLanguageFor(entry.path);
    if (!language) continue;
    if (typeof entry.size === "number" && entry.size > limits.maxFileBytes) {
      mapped.push({ path: entry.path, language, symbols: [], skippedBody: true });
      continue;
    }
    const content = await ports.files.readFile(
      request.ctx,
      request.companyId,
      request.projectId,
      entry.path,
      request.workspaceId,
      request.agentId,
    );
    mapped.push({
      path: entry.path,
      language,
      symbols: extractRepoMapSymbols({
        path: entry.path,
        language,
        content: content.content,
        maxSignatureChars: limits.maxSignatureChars,
      }),
      skippedBody: false,
    });
  }

  mapped.sort((left, right) => {
    const delta = scoreFile(right, focusPaths) - scoreFile(left, focusPaths);
    return delta !== 0 ? delta : left.path.localeCompare(right.path);
  });

  const lines: string[] = [];
  let symbolCount = 0;
  let mappedFiles = 0;
  let omittedFiles = 0;
  let truncated = false;
  for (const file of mapped) {
    const block = renderFile(file);
    const candidate = [...lines, ...block].join("\n");
    if (estimateRepoMapTokens(candidate) > tokenLimit && lines.length > 0) {
      truncated = true;
      omittedFiles += 1;
      continue;
    }
    lines.push(...block);
    symbolCount += file.symbols.length;
    mappedFiles += 1;
  }
  if (truncated) {
    lines.push(
      `... repo map truncated: ${omittedFiles} file(s) omitted to fit ${tokenLimit} tokens`,
    );
  }

  const text = lines.join("\n");
  const scan = scanTextForSecrets(text);
  if (scan.findings.length > 0) {
    throw new RepoMapSecretRejectedError(scan.findings[0]!.kind);
  }

  const result: RepoMapResult = {
    enabled: true,
    commit: request.commit,
    text,
    tokens: estimateRepoMapTokens(text),
    files: mappedFiles,
    symbols: symbolCount,
    truncated,
    omittedFiles,
    cacheHit: false,
    skippedSecrets,
  };
  ports.cache?.set(cacheKey, result);
  return result;
}
