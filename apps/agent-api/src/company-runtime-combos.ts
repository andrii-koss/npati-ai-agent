import { type AIEngine } from "@npati/omniroute-adapter";
import type { Company, CompanyAgent } from "@npati/workspace";
import { MAX_SELECTED, type Mode, type LinkedBusinessContext, CompanyRuntimeError, digest, comboModel, toolName, json, instruction } from "./company-runtime-types";
export async function configureCompanyCombos(runtime: {
    ai: AIEngine;
    strictInferenceRouting: boolean;
    timeoutMs: number;
}, company: Company, main: CompanyAgent, selected: CompanyAgent[], reviewer: CompanyAgent | undefined, mode: Mode, signal: AbortSignal, includeMemory = true, linked?: LinkedBusinessContext, inferenceModels?: string[], mainAssignedWork = false) {
    if (!runtime.ai.ensureCombo)
        throw new CompanyRuntimeError("OMNIROUTE_COMBOS_UNAVAILABLE", "NPATI AI routing combinations are unavailable", 503);
    const unique = [...new Map([...selected, main].map((agent) => [agent.id, agent])).values()], names = new Map<string, string>();
    for (const agent of unique) {
        const agentModels = inferenceModels?.length
            ? [...new Set([agent.modelId, agent.fallbackModelId, ...inferenceModels].filter((model): model is string => Boolean(model && inferenceModels.includes(model))))]
            : undefined;
        const primary = agentModels?.[0] ?? comboModel(agent.modelId), fallback = agentModels?.[1] ?? comboModel(agent.fallbackModelId);
        const allowed = agent.tools.map(toolName).map((item) => item.replace(/[^a-z0-9.]/gi, ""));
        const comboCandidateModels = agentModels?.length ? [...agentModels] : [...new Set([primary, fallback])];
        if (!runtime.strictInferenceRouting) {
            // Bare "auto" is ambiguous inside an OmniRoute combo, even when
            // auto/smart is a valid primary. Keep the qualified automatic route.
            if (!comboCandidateModels.includes("auto/smart"))
                comboCandidateModels.push("auto/smart");
        }
        // OmniRoute keeps an existing combo unchanged. Include its effective routing
        // and prompt in the identity so a Settings change cannot reuse an old provider.
        // Since OmniRoute 3.8.52 a step is bounded only by `targetTimeoutMs`, not by `timeoutMs`. These calls do not
        // stream, so it bounds the whole step: with a fallback model a hung first step gets half the request budget,
        // leaving the other half for the next model instead of the request timing out first.
        const systemMessage = instruction(company, agent, agent.id === main.id, includeMemory, linked);
        const name = `npati/a/${digest(JSON.stringify({ workspace: company.workspaceId, company: company.id, agent: agent.id, revision: agent.revision, models: comboCandidateModels, systemMessage, tools: allowed, timeoutMs: runtime.timeoutMs }))}`;
        await runtime.ai.ensureCombo({
            name, strategy: "priority", models: comboCandidateModels,
            description: `NPATI Company agent ${agent.name}`, system_message: systemMessage,
            tool_filter_regex: allowed.length ? `^(?:${allowed.join("|")})$` : "a^",
            config: { maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: runtime.timeoutMs, targetTimeoutMs: comboCandidateModels.length > 1 ? Math.floor(runtime.timeoutMs / 2) : runtime.timeoutMs }
        }, signal);
        names.set(agent.id, name);
    }
    const agentModels = Object.fromEntries(names);
    const workers = selected.filter((agent) => agent.id !== main.id && agent.id !== reviewer?.id);
    // A main agent explicitly selected as an author produces a draft before a distinct reviewer.
    if (mainAssignedWork && reviewer && reviewer.id !== main.id)
        workers.unshift(main);
    if (mode === "single" && !workers.length && (!reviewer || reviewer.id === main.id))
        return { model: names.get(main.id)!, mode: "single" as const, agentModels };
    const signature = digest(json({ company: company.id, mode, mainAssignedWork, agents: unique.map((agent) => [agent.id, names.get(agent.id)]), reviewer: reviewer?.id, judgeModel: runtime.strictInferenceRouting ? inferenceModels?.[0] : comboModel(main.modelId) }));
    if (mode === "fusion" && workers.length >= 2) {
        const fusion = `npati/f/${signature}`;
        await runtime.ai.ensureCombo({
            name: fusion, strategy: "fusion",
            models: workers.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
            config: {
                nestedComboMode: "execute", judgeModel: runtime.strictInferenceRouting ? inferenceModels?.[0] : comboModel(main.modelId), timeoutMs: runtime.timeoutMs,
                fusionTuning: { minPanel: 2, stragglerGraceMs: 4000, panelHardTimeoutMs: Math.min(90000, runtime.timeoutMs), maxPanel: MAX_SELECTED }
            }
        }, signal);
        if (!reviewer || reviewer.id === main.id)
            return { model: fusion, mode: "fusion" as const, agentModels };
        const final = `npati/p/${digest(signature + ":review")}`;
        await runtime.ai.ensureCombo({
            name: final, strategy: "pipeline", models: [
                { kind: "combo-ref", comboName: fusion }, { kind: "combo-ref", comboName: names.get(reviewer.id)! },
                { kind: "combo-ref", comboName: names.get(main.id)! }
            ],
            config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: runtime.timeoutMs, targetTimeoutMs: runtime.timeoutMs }
        }, signal);
        return { model: final, mode: "fusion" as const, agentModels };
    }
    const chain = [...workers];
    if (reviewer && reviewer.id !== main.id && !chain.some((agent) => agent.id === reviewer.id))
        chain.push(reviewer);
    chain.push(main);
    const pipeline = `npati/p/${signature}`;
    await runtime.ai.ensureCombo({
        name: pipeline, strategy: "pipeline",
        models: chain.map((agent) => ({ kind: "combo-ref", comboName: names.get(agent.id)! })),
        config: { nestedComboMode: "execute", maxRetries: 2, retryDelayMs: 500, failoverBeforeRetry: true, timeoutMs: runtime.timeoutMs, targetTimeoutMs: runtime.timeoutMs }
    }, signal);
    return { model: pipeline, mode: mode === "single" ? "single" as const : "pipeline" as const, agentModels };
}
