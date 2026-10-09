import { SandboxProviderError } from "./sandbox-provider";
import { redactTerminalText } from "./terminal-command-policy";
import { SandboxQuotaError } from "./sandbox-resource-quota";

/** Preserve admission refusals across the runner API instead of masking them as Docker failures. */
export function runnerFailure(error: unknown, operation: string): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof SandboxQuotaError) return new SandboxProviderError(error.code, error.message, error.status, operation, "project.terminal.exec", error.retryable);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EACCES" || code === "EPERM") return new SandboxProviderError("sandbox_workspace_permission_denied", "Sandbox workspace is not writable", 503);
  if (code === "ENOSPC") return new SandboxProviderError("sandbox_storage_full", "Sandbox storage is full", 503);
  return new SandboxProviderError("runner_failure", `Sandbox runner ${operation} failed`, 503);
}

export function safeDockerStderr(value: string): string {
  return redactTerminalText(value).slice(0, 1600)
    .replace(/https?:\/\/\S+/gi, "[URL_REDACTED]")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/(?:--env\s+|\b(?:TOKEN|SECRET|PASSWORD|KEY)=)\S+/gi, "[REDACTED]");
}

export function dockerFailure(action: string, stderr: string, timedOut = false, spawnCode?: string): SandboxProviderError {
  const source = stderr.toLowerCase();
  let code = "docker_command_failed", message = `Docker ${action} failed`, status = 503;
  if (timedOut) { code = "docker_timeout"; message = `Docker ${action} timed out`; status = 504; }
  else if (spawnCode === "ENOENT") { code = "docker_cli_missing"; message = "Docker CLI is unavailable in sandbox runner"; }
  else if (/(?:permission denied|operation not permitted)/.test(source) && /(?:docker\.sock|docker daemon|\/var\/run\/docker)/.test(source)) { code = "docker_socket_permission_denied"; message = "Docker socket permission denied"; }
  else if (/(?:cannot connect to the docker daemon|is the docker daemon running|error during connect|connection refused)/.test(source)) { code = "docker_daemon_unavailable"; message = "Docker daemon unavailable"; }
  else if (/(?:no such image|unable to find image|pull access denied|manifest unknown|image .* not found)/.test(source)) { code = "sandbox_image_not_found"; message = "Sandbox image not found"; }
  else if (/(?:network .* not found|no such network)/.test(source)) { code = "sandbox_network_not_found"; message = "Sandbox Docker network not found"; }
  else if (/(?:no space left on device|disk quota exceeded)/.test(source)) { code = "sandbox_storage_full"; message = "Sandbox storage is full"; }
  else if (/(?:read-only file system|permission denied)/.test(source) && /(?:workspace|\/tmp|mkdir|copy|cp:)/.test(source)) { code = "sandbox_workspace_permission_denied"; message = "Sandbox workspace is not writable"; }
  else if (/(?:oci runtime create failed|failed to create task|container .*failed to start)/.test(source)) { code = "sandbox_container_start_failed"; message = "Sandbox container failed to start"; }
  const error = new SandboxProviderError(code, message, status, action, "project.terminal.exec", timedOut);
  error.diagnostics = { dockerAction: action, dockerStderr: safeDockerStderr(stderr) };
  return error;
}
