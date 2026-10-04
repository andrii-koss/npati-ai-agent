import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chown, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PreviewProxyRequest, PreviewProxyResponse, SandboxBrowserQaOptions, SandboxBrowserQaResult, SandboxCommandResult, SandboxFile, SandboxProvider, SandboxScope, SandboxStatus } from "./sandbox-provider";
import { SandboxProviderError } from "./sandbox-provider";
import { safeProjectPath } from "./project-workspace";
import { classifyTerminalCommand } from "./terminal-command-policy";

interface RunnerLimits {
  cpu: string; memory: string; diskBytes: number; pids: number; image: string; proxyImage: string; maxFiles: number; maxBytes: number; allowedHosts: string;
}
const defaults: RunnerLimits = {
  cpu: "1", memory: "1024m", diskBytes: 512 * 1024 * 1024, pids: 128,
  image: "npati/project-sandbox:local", proxyImage: "npati/sandbox-egress:local", maxFiles: 500, maxBytes: 20_000_000, allowedHosts: "registry.npmjs.org,registry.yarnpkg.com,pypi.org,files.pythonhosted.org,repo.packagist.org,packagist.org,github.com,codeload.github.com,api.github.com,objects.githubusercontent.com",
};
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const label = (scope: SandboxScope) => createHash("sha256").update([scope.workspaceId, scope.userId, scope.companyId, scope.projectId].join(":")).digest("hex");
function args(cmd: string, values: string[], timeoutMs = 30_000, stdin?: string | Buffer, outputLimit = 128_000): Promise<{ code: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, values, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const push = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size <= outputLimit) target.push(chunk); else { timedOut = true; child.kill("SIGKILL"); } };
    child.stdout.on("data", (chunk: Buffer) => push(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => push(stderr, chunk));
    child.on("error", (error) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => { if (!finished) { finished = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut }); } });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
const text = (bytes: Buffer) => bytes.toString("utf8").slice(0, 128_000);
async function assignSandboxOwner(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await assignSandboxOwner(child);
    else await chown(child, 10001, 10001);
  }
  await chown(directory, 10001, 10001);
}
export class DockerSandboxProvider implements SandboxProvider {
  private readonly limits: RunnerLimits;
  private readonly activity = new Map<string, number>();
  private touch(id: string) { this.activity.set(id, Date.now()); }
  constructor(limits: Partial<RunnerLimits> = {}) { this.limits = { ...defaults, ...limits }; if (!this.limits.allowedHosts.split(",").every((host) => /^[a-z0-9.-]+$/.test(host) && !host.startsWith(".") && !host.endsWith("."))) throw new Error("Invalid sandbox allowlist");
    if (!/^(?:0\.[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(this.limits.cpu) || !/^[1-9][0-9]*(?:[kmg])?$/i.test(this.limits.memory) || !Number.isSafeInteger(this.limits.diskBytes) || this.limits.diskBytes < 16_000_000 || !Number.isSafeInteger(this.limits.pids) || this.limits.pids < 16) throw new Error("Invalid sandbox resource limits"); }
  private async docker(argsList: string[], timeoutMs = 30_000, stdin?: string | Buffer, outputLimit?: number) {
    const result = await args("docker", argsList, timeoutMs, stdin, outputLimit);
    if (result.code !== 0 || result.timedOut) throw new SandboxProviderError(result.timedOut ? "docker_timeout" : "docker_failed", "Sandbox runner operation failed", result.timedOut ? 504 : 503, "docker", "project.terminal.exec", result.timedOut);
    return result;
  }
  private names(id: string) {
    if (!uuid(id)) throw new SandboxProviderError("invalid_sandbox", "Invalid sandbox ID", 400);
    return { sandbox: `npati-sb-${id}`, network: `npati-net-${id}`, proxy: `npati-proxy-${id}` };
  }
  private async inspect(scope: SandboxScope, id: string) {
    const names = this.names(id);
    const found = await args("docker", ["inspect", "--format", "{{json .Config.Labels}}", names.sandbox]);
    if (found.code !== 0) throw new SandboxProviderError("sandbox_not_found", "Sandbox not found", 404);
    let labels: Record<string, string>;
    try { labels = JSON.parse(text(found.stdout)); } catch { throw new SandboxProviderError("sandbox_corrupt", "Sandbox metadata is invalid", 503); }
    if (labels["npati.scope"] !== label(scope) || labels["npati.sandbox"] !== id) throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403);
    return names;
  }
  private async state(scope: SandboxScope, id: string): Promise<SandboxStatus> {
    const names = await this.inspect(scope, id);
    const inspect = await this.docker(["inspect", "--format", "{{.Created}}|{{.State.Status}}|{{.State.StartedAt}}", names.sandbox]);
    const [createdAt, value, startedAt] = text(inspect.stdout).trim().split("|");
    const storedAt = this.activity.get(id) ?? Date.parse(startedAt ?? "");
    return { id, state: value === "running" ? "running" : value === "created" ? "created" : value === "exited" ? "stopped" : "failed", createdAt: createdAt ?? new Date().toISOString(), lastActivityAt: new Date(Number.isFinite(storedAt) ? storedAt : Date.now()).toISOString() };
  }
  async createSandbox(scope: SandboxScope): Promise<SandboxStatus> {
    if (!scope.workspaceId || !scope.userId || !scope.companyId || !scope.projectId) throw new SandboxProviderError("invalid_scope", "Sandbox scope is incomplete", 400);
    const id = randomUUID(), names = this.names(id);
    try {
      await this.docker(["network", "create", "--driver", "bridge", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", names.network]);
      await this.docker(["create", "--name", names.proxy, "--network", names.network, "--network-alias", "egress", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "64", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m", "--env", `ALLOWED_HOSTS=${this.limits.allowedHosts}`, this.limits.proxyImage]);
      await this.docker(["network", "connect", "bridge", names.proxy]);
      await this.docker(["start", names.proxy]);
      await this.docker([
        "create", "--name", names.sandbox, "--label", `npati.scope=${label(scope)}`, "--label", `npati.sandbox=${id}`,
        "--network", names.network, "--network-alias", "project-preview", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--cpus", this.limits.cpu, "--memory", this.limits.memory, "--pids-limit", String(this.limits.pids),
        "--tmpfs", `/workspace:rw,nosuid,nodev,uid=10001,gid=10001,size=${this.limits.diskBytes}`,
        "--tmpfs", "/tmp:rw,nosuid,nodev,uid=10001,gid=10001,size=64m",
        "--workdir", "/workspace", "--env", "HOME=/workspace/.npati-runtime", "--env", "NPM_CONFIG_CACHE=/workspace/.npati-runtime/npm", "--env", "PIP_CACHE_DIR=/workspace/.npati-runtime/pip", "--env", "PIP_TARGET=/workspace/.npati-runtime/python", "--env", "PYTHONPATH=/workspace/.npati-runtime/python", "--env", "HTTP_PROXY=http://egress:8080",
        "--env", "HTTPS_PROXY=http://egress:8080", "--env", "http_proxy=http://egress:8080", "--env", "https_proxy=http://egress:8080",
        "--env", "NO_PROXY=localhost,127.0.0.1", this.limits.image, "sleep", "infinity",
      ]);
      this.touch(id);
      return this.state(scope, id);
    } catch (error) {
      await args("docker", ["rm", "-f", names.sandbox]).catch(() => undefined);
      await args("docker", ["rm", "-f", names.proxy]).catch(() => undefined);
      await args("docker", ["network", "rm", names.network]).catch(() => undefined);
      throw error;
    }
  }
  async startSandbox(scope: SandboxScope, id: string) { const names = await this.inspect(scope, id); const status = await this.state(scope, id); if (status.state !== "running") await this.docker(["start", names.sandbox]); this.touch(id); return this.state(scope, id); }
  async stopSandbox(scope: SandboxScope, id: string) { const names = await this.inspect(scope, id); if ((await this.state(scope, id)).state === "running") await this.docker(["stop", "--time", "5", names.sandbox], 15_000); return this.state(scope, id); }
  async destroySandbox(scope: SandboxScope, id: string) { const names = await this.inspect(scope, id); await this.docker(["rm", "-f", names.sandbox]); await this.docker(["rm", "-f", names.proxy]); await this.docker(["network", "rm", names.network]); this.activity.delete(id); }
  async getStatus(scope: SandboxScope, id: string) { return this.state(scope, id); }
  async executeCommand(scope: SandboxScope, id: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    classifyTerminalCommand(command);
    this.touch(id);
    const env = Object.entries(options.environment ?? {});
    if (env.some(([key]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key))) throw new SandboxProviderError("invalid_environment", "Invalid environment key", 400);
    const script = env.map(([key, value]) => `export ${key}="$(printf %s ${Buffer.from(value).toString("base64")} | base64 -d)"`).join("\n") + "\n" + command + "\n";
    const started = Date.now();
    const result = await args("docker", ["exec", "-i", "--workdir", "/workspace", names.sandbox, "timeout", "-s", "TERM", "-k", "2", String(Math.max(1, Math.ceil(options.timeoutMs / 1000))), "sh", "-s"], Math.min(options.timeoutMs, 600_000) + 5_000, script, Math.min(options.outputLimitBytes, 128_000));
    if (result.timedOut) await this.stopSandbox(scope, id).catch(() => undefined);
    return {
      status: result.timedOut || result.code === 124 || result.code === 137 ? "timed_out" : result.code === 0 ? "completed" : "failed", exitCode: result.timedOut ? null : result.code,
      stdout: text(result.stdout), stderr: text(result.stderr), durationMs: Date.now() - started, step: "command", tool: "project.terminal.exec", retryable: result.timedOut,
    };
  }
  async inspectBrowser(scope: SandboxScope, id: string, options: SandboxBrowserQaOptions): Promise<SandboxBrowserQaResult> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
        !/^\/(?!\/)[A-Za-z0-9/_~.%-]*$/.test(options.path) || options.path.includes("..") ||
        !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000 ||
        !Number.isInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes < 50000 || options.maxScreenshotBytes > 2000000 ||
        !Number.isInteger(options.maxBrokenLinks) || options.maxBrokenLinks < 1 || options.maxBrokenLinks > 50 ||
        !Number.isInteger(options.viewport.width) || options.viewport.width < 320 || options.viewport.width > 1920 ||
        !Number.isInteger(options.viewport.height) || options.viewport.height < 320 || options.viewport.height > 1200) {
      throw new SandboxProviderError("invalid_qa_options", "Invalid browser QA options", 400, "browser_qa", "project.qa.inspect");
    }
    const container = `npati-qa-${randomUUID()}`;
    this.touch(id);
    try {
      const result = await args("docker", ["run", "--rm", "--name", container, "--network", names.network,
        "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--cpus", "1", "--memory", "768m", "--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--env", "HOME=/tmp", "-i", process.env.NPATI_BROWSER_QA_IMAGE || "npati/browser-qa:local"],
        options.timeoutMs + 5000, JSON.stringify({ ...options, host: names.sandbox }), 3_000_000);
      if (result.timedOut) throw new SandboxProviderError("qa_timeout", "Browser QA timed out or exceeded its output limit", 504, "browser_qa", "project.qa.inspect");
      if (result.code !== 0) throw new SandboxProviderError("qa_failed", "Browser QA runner failed", 503, "browser_qa", "project.qa.inspect");
      const parsed = JSON.parse(result.stdout.toString("utf8")) as SandboxBrowserQaResult;
      if (!Number.isInteger(parsed.statusCode) || !Array.isArray(parsed.brokenLinks) || !Array.isArray(parsed.accessibility))
        throw new SandboxProviderError("qa_invalid_result", "Browser QA runner returned invalid output", 503, "browser_qa", "project.qa.inspect");
      return parsed;
    } finally {
      await args("docker", ["rm", "-f", container], 5000).catch(() => undefined);
    }
  }
  async uploadFiles(scope: SandboxScope, id: string, files: SandboxFile[]) {
    const names = await this.inspect(scope, id);
    this.touch(id);
    if (files.length > this.limits.maxFiles || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > this.limits.maxBytes) throw new SandboxProviderError("upload_limit", "Upload exceeds sandbox limits", 413);
    const directory = await mkdtemp(path.join(tmpdir(), "npati-sandbox-upload-"));
    try {
      for (const file of files) {
        const relative = safeProjectPath(file.path);
        const target = path.join(directory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      }
      await assignSandboxOwner(directory);
      await this.docker(["cp", "-a", path.join(directory, "."), `${names.sandbox}:/workspace/`], 120_000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async downloadFiles(scope: SandboxScope, id: string): Promise<SandboxFile[]> {
    const names = await this.inspect(scope, id);
    this.touch(id);
    const listed = await this.docker(["exec", names.sandbox, "find", "/workspace", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/vendor/*", "-not", "-path", "*/.npati-runtime/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/build/*", "-not", "-path", "*/.venv/*", "-not", "-path", "*/__pycache__/*", "-print0"], 30_000, undefined, 256_000);
    const paths = listed.stdout.toString("utf8").split("\0").filter(Boolean);
    if (paths.length > this.limits.maxFiles) throw new SandboxProviderError("download_limit", "Too many sandbox files", 413);
    const files: SandboxFile[] = [];
    let total = 0;
    for (const absolute of paths) {
      if (!absolute.startsWith("/workspace/")) throw new SandboxProviderError("unsafe_path", "Sandbox returned an unsafe path", 400);
      const relative = safeProjectPath(absolute.slice("/workspace/".length));
      const result = await this.docker(["exec", names.sandbox, "cat", "--", absolute], 30_000, undefined, this.limits.maxBytes);
      total += result.stdout.length;
      if (total > this.limits.maxBytes) throw new SandboxProviderError("download_limit", "Sandbox files exceed sync limit", 413);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
      catch { throw new SandboxProviderError("unsupported_binary_file", "Sandbox generated a binary file outside ignored build artifacts", 422, "download"); }
      if (content.includes("\0")) throw new SandboxProviderError("unsupported_binary_file", "Sandbox generated a binary file outside ignored build artifacts", 422, "download");
      files.push({ path: relative, content });
    }
    return files;
  }
  async proxyPreview(scope: SandboxScope, id: string, options: PreviewProxyRequest): Promise<PreviewProxyResponse> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
        !options.path.startsWith("/") || options.path.startsWith("//") || options.path.length > 4096 ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(options.method) ||
        (options.body && options.body.length > 8_000_000)) {
      throw new SandboxProviderError("invalid_preview_request", "Invalid preview request", 400);
    }
    const script = `let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",async()=>{try{const q=JSON.parse(input);const url=new URL(q.path,"http://127.0.0.1:"+q.port);if(url.hostname!=="127.0.0.1")throw Error("Invalid preview path");const r=await fetch(url,{method:q.method,headers:q.headers,body:q.body?Buffer.from(q.body,"base64"):undefined,signal:AbortSignal.timeout(20000),redirect:"manual"});const data=Buffer.from(await r.arrayBuffer());if(data.length>8000000)throw Error("Preview response too large");process.stdout.write(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:data.toString("base64")}));}catch(e){process.stderr.write(String(e));process.exitCode=1}})`;
    const result = await args("docker", ["exec", "-i", names.sandbox, "node", "-e", script], 25_000, JSON.stringify(options), 16_000_000);
    if (result.code !== 0 || result.timedOut) throw new SandboxProviderError("preview_upstream_failed", "Sandbox preview is unavailable", 502);
    this.touch(id);
    return JSON.parse(result.stdout.toString("utf8")) as PreviewProxyResponse;
  }
  async exposePort(scope: SandboxScope, id: string, port: number): Promise<{ port: number; internalHost: string }> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxProviderError("invalid_port", "Invalid port number", 400);
    }
    const inspect = await args("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", names.sandbox]);
    const internalIp = text(inspect.stdout).trim();
    const internalHost = internalIp || names.sandbox;
    return { port, internalHost };
  }
  async getLogs(scope: SandboxScope, id: string, processId?: string) {
    const names = await this.inspect(scope, id);
    if (processId) { if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400); const result = await this.docker(["exec", names.sandbox, "cat", "--", `/tmp/npati-process-${processId}.log`]); return text(result.stdout); }
    const result = await this.docker(["logs", "--tail", "100", names.sandbox]); return text(result.stdout) + text(result.stderr);
  }
  async startProcess(scope: SandboxScope, id: string, command: string, options: { timeoutMs: number; outputLimitBytes: number; environment?: Record<string, string> }): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    classifyTerminalCommand(command);
    this.touch(id);
    if (Object.keys(options.environment ?? {}).length) throw new SandboxProviderError("process_secrets_unsupported", "Background process secret references are unavailable", 400);
    const processId = randomUUID(), marker = `/tmp/npati-process-${processId}`;
    const command64 = Buffer.from(command).toString("base64");
    const script = `setsid sh -c 'printf %s ${command64} | base64 -d | timeout -s TERM -k 2 ${Math.max(1, Math.ceil(options.timeoutMs / 1000))} sh -s > ${marker}.log 2>&1; echo $? > ${marker}.exit' </dev/null >/dev/null 2>&1 & echo $! > ${marker}.pid`;
    await this.docker(["exec", "-i", names.sandbox, "sh", "-s"], 10_000, script);
    return { status: "running", exitCode: null, stdout: "", stderr: "", durationMs: 0, step: "process", tool: "project.terminal.process", retryable: false, processId };
  }
  async getProcessStatus(scope: SandboxScope, id: string, processId: string): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    const result = await args("docker", ["exec", names.sandbox, "cat", "--", `/tmp/npati-process-${processId}.exit`]);
    const done = result.code === 0, exitCode = done ? Number(text(result.stdout).trim()) : null;
    return { status: done ? exitCode === 0 ? "completed" : exitCode === 124 ? "timed_out" : "failed" : "running", exitCode, stdout: "", stderr: "", durationMs: 0, step: done ? "finished" : "running", tool: "project.terminal.process", retryable: false, processId };
  }
  async stopProcess(scope: SandboxScope, id: string, processId: string): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    await this.docker(["exec", names.sandbox, "sh", "-c", `pid="$(cat /tmp/npati-process-${processId}.pid)"; /bin/kill -TERM -- "-$pid" 2>/dev/null || true; echo 143 > /tmp/npati-process-${processId}.exit`]);
    return { status: "stopped", exitCode: null, stdout: "", stderr: "", durationMs: 0, step: "stopped", tool: "project.terminal.process", retryable: false, processId };
  }
}