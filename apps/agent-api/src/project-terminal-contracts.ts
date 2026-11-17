export interface TerminalSecretReference {
    id: string;
    field: string;
}
export interface ProcessWorkspaceSnapshot {
    version?: 2;
    sandboxId: string;
    mounted: boolean;
    files: Array<{
        path: string;
        revision: string;
        hash: string;
    }>;
}
export interface TerminalRequest {
    projectId: string;
    sandboxId?: string;
    command?: string;
    executable?: string;
    args?: string[];
    cwd?: string;
    processId?: string;
    action?: "start" | "status" | "logs" | "stop";
    environmentReferences?: Record<string, TerminalSecretReference>;
    approved?: boolean;
    runId?: string;
    agentId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Internal verification caller consumes a failed execution result; policy/approval failures still throw. */
    captureFailure?: boolean;
    policyCleared?: boolean; // The coding policy ruled this command read-only; the stricter terminal rules do not apply.
}
export interface TerminalLimits {
    commandTimeoutMs: number;
    installBuildTimeoutMs: number;
    outputLimitBytes: number;
    inactivityMs: number;
    syncMaxBytes: number;
    syncMaxFiles: number;
    /**
     * C10 (ТЗ item 7): how long a sandbox may stay idle (stopped **or** running) before the retention policy
     * destroys it. Destroying is safe — `ensure` recreates the sandbox from the stored project files — and not
     * destroying is not: a stopped container keeps its disk for as long as nothing removes it. Default seven days.
     */
    retentionMs: number;
}
export const defaultTerminalLimits: TerminalLimits = {
    commandTimeoutMs: 120000, installBuildTimeoutMs: 3600000, outputLimitBytes: 64000,
    inactivityMs: 900000, syncMaxBytes: Number.POSITIVE_INFINITY, syncMaxFiles: Number.POSITIVE_INFINITY,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
};
