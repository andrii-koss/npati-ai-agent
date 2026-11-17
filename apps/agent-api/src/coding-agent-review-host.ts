import type { ChatMessage } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { type CodingAgentStopReason, type CodingAgentRunStatus, type CodeRunActivityEvent, type CodingAgentRunnerPorts, type CodingAgentRunInput, type CodingAgentRunSummary, type CodingAgentRunResult } from "./coding-agent-runner-contracts";
import type { CodingAgentReviewPhases } from "./coding-agent-review-phases";
import type { CodeAgentLimits } from "./code-agent-config";
export interface ReviewCoordinatorHost {
    ports: CodingAgentRunnerPorts;
    limits: CodeAgentLimits;
    reviewPhases: CodingAgentReviewPhases;
    selfReviewDiffChars: number;
    input: CodingAgentRunInput;
    ctx: AuthContext;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    turnId: string;
    stepTurnKey: (index: number) => string;
    toolSteps: number[];
    capabilityScopeFields: Record<string, unknown>;
    summary: CodingAgentRunSummary;
    messages: ChatMessage[];
    record: (event: CodeRunActivityEvent) => Promise<void>;
    release: (reason: string) => Promise<void>;
    stop: (status: Exclude<CodingAgentRunStatus, "waiting_for_user">, reason: CodingAgentStopReason, message: string) => Promise<CodingAgentRunResult>;
}
