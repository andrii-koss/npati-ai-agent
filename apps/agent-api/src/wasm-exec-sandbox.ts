import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export interface IsolatedExecInput { language?: string; code: string; timeoutMs?: number; }
export interface IsolatedExecResult {
  executionId: string; runtime: "quickjs-wasm-worker"; success: boolean; stdout: string; stderr: string; result?: unknown;
  durationMs: number; timedOut: boolean; isolated: true; networkAccess: false; hostFileAccess: false;
}
export interface IsolatedExecSandbox { execute(input: IsolatedExecInput, signal: AbortSignal): Promise<IsolatedExecResult>; }

const MAX_CODE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { getQuickJS } = await import("quickjs-emscripten");
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.timeoutMs;
  let outputBytes = 0, outputExceeded = false;
  const stdout = [], stderr = [];
  const append = (target, value) => {
    const bytes = Buffer.byteLength(value + "\n", "utf8");
    if (outputBytes + bytes > 64 * 1024) { outputExceeded = true; return; }
    outputBytes += bytes; target.push(value);
  };
  runtime.setInterruptHandler(() => outputExceeded || Date.now() >= deadline);
  const vm = runtime.newContext();
  try {
    const consoleHandle = vm.newObject();
    for (const [name, target] of [["log", stdout], ["info", stdout], ["warn", stderr], ["error", stderr]]) {
      const handle = vm.newFunction(name, (...args) => append(target, args.map((arg) => {
        const dumped = vm.dump(arg); return typeof dumped === "string" ? dumped : JSON.stringify(dumped);
      }).join(" ")));
      vm.setProp(consoleHandle, name, handle); handle.dispose();
    }
    vm.setProp(vm.global, "console", consoleHandle); consoleHandle.dispose();
    parentPort.postMessage({ type: "started" });
    const evaluated = vm.evalCode(workerData.code, "company-agent-exec.js");
    const timedOut = Date.now() >= deadline;
    if (evaluated.error) {
      const dumped = vm.dump(evaluated.error); evaluated.error.dispose();
      const message = typeof dumped === "string" ? dumped : dumped?.message ?? dumped?.name ?? "Execution failed";
      append(stderr, outputExceeded ? "Output limit exceeded" : timedOut ? "Execution timed out" : message);
      parentPort.postMessage({ type: "result", success: false, stdout: stdout.join("\n"), stderr: stderr.join("\n"), timedOut });
    } else {
      const result = vm.dump(evaluated.value); evaluated.value.dispose();
      parentPort.postMessage({ type: "result", success: !outputExceeded, stdout: stdout.join("\n"),
        stderr: outputExceeded ? "Output limit exceeded" : stderr.join("\n"), result, timedOut: false });
    }
  } finally { vm.dispose(); runtime.dispose(); }
})().catch((error) => parentPort.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
`;

function boundedTimeout(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(50, Math.min(Math.trunc(parsed), MAX_TIMEOUT_MS)) : DEFAULT_TIMEOUT_MS;
}

/** Runs each snippet in its own resource-limited worker and QuickJS WebAssembly VM. */
export class WasmExecSandbox implements IsolatedExecSandbox {
  private readonly active = new Map<string, Worker>();

  activeExecutions() { return [...this.active.keys()]; }
  async cancel(executionId: string) {
    const worker = this.active.get(executionId);
    if (!worker) return false;
    this.active.delete(executionId);
    await worker.terminate();
    return true;
  }

  async execute(input: IsolatedExecInput, signal: AbortSignal): Promise<IsolatedExecResult> {
    const startedAt = Date.now();
    const language = (input.language ?? "javascript").trim().toLowerCase();
    if (!["javascript", "js"].includes(language)) throw new Error("Exec currently supports isolated JavaScript only");
    if (typeof input.code !== "string" || !input.code.trim()) throw new Error("Exec code is required");
    if (Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES) throw new Error("Exec code exceeds the 64 KiB limit");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const executionId = `exec_${randomUUID().replace(/-/g, "")}`;
    const timeoutMs = boundedTimeout(input.timeoutMs);
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { code: input.code, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    this.active.set(executionId, worker);

    return new Promise<IsolatedExecResult>((resolve, reject) => {
      let settled = false;
      const finish = () => { this.active.delete(executionId); signal.removeEventListener("abort", onAbort); };
      const onAbort = () => {
        if (settled) return; settled = true; finish();
        void worker.terminate().finally(() => reject(new DOMException("Cancelled", "AbortError")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (message: Record<string, unknown>) => {
        if (settled || message.type === "started") return;
        if (message.type === "error") { settled = true; finish(); void worker.terminate(); reject(new Error(String(message.message))); return; }
        if (message.type === "result") {
          settled = true; finish(); void worker.terminate();
          resolve({ executionId, runtime: "quickjs-wasm-worker", success: message.success === true,
            stdout: String(message.stdout ?? ""), stderr: String(message.stderr ?? ""), result: message.result,
            durationMs: Date.now() - startedAt, timedOut: message.timedOut === true,
            isolated: true, networkAccess: false, hostFileAccess: false });
        }
      });
      worker.once("error", (error) => { if (!settled) { settled = true; finish(); reject(error); } });
      worker.once("exit", (code) => { if (!settled) { settled = true; finish(); reject(new Error(`Exec worker exited unexpectedly (${code})`)); } });
    });
  }
}
