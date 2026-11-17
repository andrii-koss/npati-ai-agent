import { randomUUID } from "node:crypto";
import type { SandboxCommandOptions, SandboxCommandResult, SandboxProvider, SandboxScope } from "./sandbox-provider";

/** A foreground check needs a scoped process handle so Stop can terminate it, including a dispatch race. */
export async function executeCancellableSandboxCommand(
  provider: Pick<SandboxProvider, "executeCommand" | "stopProcess" | "processCapabilities">, scope: SandboxScope, sandboxId: string, command: string,
  options: SandboxCommandOptions, signal?: AbortSignal,
): Promise<SandboxCommandResult> {
  if (!signal) return provider.executeCommand(scope, sandboxId, command, options);
  signal.throwIfAborted();
  const capabilities = await provider.processCapabilities?.(scope);
  // Older/isolated providers retain their existing foreground semantics; do not
  // pretend they support process-scoped cancellation or change their security policy.
  if (!capabilities?.foregroundCancellation) return provider.executeCommand(scope, sandboxId, command, options);
  signal.throwIfAborted();
  const processId = randomUUID();
  let stopping: Promise<SandboxCommandResult> | undefined;
  const stop = () => { stopping ??= provider.stopProcess(scope, sandboxId, processId); void stopping.catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    // Keep the foreground execution path, its environment guards, separate stdout/stderr and timeout.
    const result = await provider.executeCommand(scope, sandboxId, command, { ...options, processId });
    if (signal.aborted) { stop(); await stopping; return { ...result, status: "stopped" }; }
    return result;
  } catch (error) {
    // A transport error may follow successful dispatch; clean up the same scoped identity.
    await provider.stopProcess(scope, sandboxId, processId).catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", stop); }
}
