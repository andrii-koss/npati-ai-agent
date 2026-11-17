import type { AuthContext } from "@npati/workspace";
export interface PreviewTokenPayload {
    workspaceId?: string;
    userId: string;
    companyId: string;
    projectId: string;
    sandboxId: string;
    expiresAt: number;
}
export interface ActivePreviewSession {
    projectId: string;
    companyId: string;
    sandboxId: string;
    processId: string;
    port: number;
    framework: string;
    command: string;
    restartCount: number;
    maxRestarts: number;
    status: "starting" | "running" | "restarting" | "failed" | "stopped";
    lastError?: string;
    startedAt: string;
    workspaceId: string;
    userId: string;
}
export type PreviewOriginRegistrar = (ctx: AuthContext, companyId: string, projectId: string, origin: string) => Promise<void>;
