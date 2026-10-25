import type { CodingAgentRunnerPorts, CodingAgentRunResult, CodingAgentRunStatus, CodingAgentStopReason } from "./coding-agent-runner-contracts";
import type { CodingAgentInboxManager } from "./coding-agent-inbox-manager";
import type { CodingAgentReviewCoordinator } from "./coding-agent-review-coordinator";

type SettlementInput = {
 ports: CodingAgentRunnerPorts; companyId: string; stateRunId?: string; stateOwner: string;
 startedAt: number; steps: number; prompt: string; inboxManager: CodingAgentInboxManager; reviewCoordinator: CodingAgentReviewCoordinator;
 openTurn(): Promise<void>; writeState(operation: () => Promise<unknown>): Promise<void>;
 cancelled(): Promise<boolean>;
 stop(status: Exclude<CodingAgentRunStatus, "waiting_for_user">, reason: CodingAgentStopReason, message: string): Promise<CodingAgentRunResult>;
};
/** Existing turn settlement shared by natural completion and code.finish. No alternate execution path. */
export async function settleCodingTurn(input: SettlementInput, finalText: string, turnOpened: boolean): Promise<CodingAgentRunResult | null> {
 const { ports, companyId, stateRunId, stateOwner, startedAt, steps, prompt, inboxManager, reviewCoordinator, openTurn, writeState, cancelled, stop } = input;
        ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "turn_closing", turn: steps });
        if (!turnOpened) await openTurn();
        if (stateRunId && ports.runState) {
          await writeState(() => ports.runState!.appendTurn({
            companyId, runId: stateRunId!, turnIndex: steps, status: "finished", outcome: "ok",
            checkpointId: reviewCoordinator.turnCheckpointId(steps),
          }));
        }

        reviewCoordinator.applyTurnSummary();

        ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "collect_started", turn: steps });
        const barrierResult = await reviewCoordinator.handleCollectBarrier({
          startedAt, stateRunId, stateOwner, inboxOpened: inboxManager.isOpened,
          cancelled, admitInbox: () => inboxManager.admitInbox(steps),
        });

        ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "collect_finished", turn: steps, action: barrierResult.action });
        if (barrierResult.action === "stopped") return barrierResult.result;
        if (barrierResult.action === "input_collected") return null;

        if (inboxManager.isOpened && stateRunId) {
          try {
            if (await inboxManager.admitInbox(steps)) return null;
            const sealed = await inboxManager.sealInbox();
            if (!sealed) return null;
          } catch {
            return stop("interrupted", "interrupted", "Stopped: the inbox finalization cutoff could not be recorded.");
          }
        }

        ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "review_started", turn: steps });
        const reviewOutcome = await reviewCoordinator.finalizeOrReviewTurn({ steps, prompt, assistantText: finalText, stateRunId });
        if (reviewOutcome.action === "completed" || reviewOutcome.action === "stopped") return reviewOutcome.result;
        return null;

}
