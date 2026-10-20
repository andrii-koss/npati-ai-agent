import { chatLanguageInstruction, codingChatResponseInstruction } from "./company-chat-i18n";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import type { CodeModelProfile } from "./code-model-profiles";
import { COMPANY_MEMORY_HEADER, PROJECT_CONTEXT_HEADER, renderContextBlocks } from "./code-context-memory";
import {
  type CodeRunToolDescriptor,
  type CodeRunSkillProvenance,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
  buildSystemPrompt,
} from "./coding-agent-runner-contracts";

export interface BuildPromptContextArgs {
  ctx: AuthContext;
  session: CodeSession;
  input: CodingAgentRunInput;
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  companyId: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  startedAt: number;
  runTurnLimit: number;
  tools: CodeRunToolDescriptor[];
  profile: CodeModelProfile;
}

export async function buildRunPromptContext(args: BuildPromptContextArgs): Promise<{
  systemPrompt: string;
}> {
  const {
    ctx,
    session,
    input,
    ports,
    limits,
    companyId,
    projectId,
    sessionId,
    prompt,
    startedAt,
    runTurnLimit,
    tools,
    profile,
  } = args;

  let projectInstructions: { body: string; contentHash: string | null; trusted: boolean } | null = null;
  if (ports.projectInstructions) {
    try {
      projectInstructions = await ports.projectInstructions.load({ ctx, companyId, projectId });
    } catch {
      projectInstructions = null;
    }
  }
  ports.environment?.setProjectInstructions(
    projectInstructions
      ? { contentHash: projectInstructions.contentHash, trustStatus: projectInstructions.trusted ? "trusted" : "untrusted" }
      : null,
  );

  let contextBlocks: string | null = null;
  if (ports.contextBlocks) {
    try {
      const loaded = await ports.contextBlocks.load({
        ctx,
        companyId,
        projectId,
        query: prompt.slice(0, 500),
        ...(input.websiteEdit ? { websiteEdit: true } : {}),
      });
      if (loaded) {
        contextBlocks = renderContextBlocks([
          loaded.companyMemory ? { header: COMPANY_MEMORY_HEADER, body: loaded.companyMemory, chars: loaded.companyMemory.length, truncated: false } : null,
          loaded.projectContext ? { header: PROJECT_CONTEXT_HEADER, body: loaded.projectContext, chars: loaded.projectContext.length, truncated: false } : null,
        ]) || null;
      }
    } catch {
      contextBlocks = null;
    }
  }

  let skillInstructions: string | null = null;
  let skillProvenance: readonly CodeRunSkillProvenance[] = [];
  if (ports.skillInstructions) {
    try {
      skillInstructions = await ports.skillInstructions.render({ ctx, companyId, projectId, sessionId });
      skillProvenance = skillInstructions
        ? await ports.skillInstructions.provenance({ ctx, companyId, projectId, sessionId })
        : [];
    } catch {
      skillInstructions = null;
      skillProvenance = [];
    }
  }
  ports.environment?.setSkillInstructions(skillProvenance.length > 0 ? skillProvenance : null);

  const systemPrompt = buildSystemPrompt({
    session,
    editProfile: profile,
    tools,
    environment: {
      os: process.platform,
      cwd: `/workspace/${projectId}`,
      date: new Date(startedAt).toISOString().slice(0, 10),
    },
    limits: { ...limits, maxStepsPerRun: runTurnLimit },
    ...(projectInstructions ? { instructions: projectInstructions.body } : {}),
    ...(contextBlocks ? { contextBlocks } : {}),
    ...(skillInstructions ? { skillInstructions } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    extraLines: [
      ...(input.extraSystemPromptLines ?? []),
      ...(input.responseLanguage ? [chatLanguageInstruction("", [], input.responseLanguage), codingChatResponseInstruction()] : []),
      ...(input.websiteEdit ? ["This is an edit to an existing working website. Inspect only the affected selectors, batch the requested changes and finish. For a small theme edit, when stylesheet locations are supplied in repository context, begin with a bounded read of their theme variables and body selectors; do not rediscover known stylesheet paths with grep/tree/list. Batch those reads in one turn, apply the necessary changes and finish. For CSS edits, account for the supplied stylesheet import order and overriding selectors: a rule in an earlier stylesheet can be overridden by a later one. Do not edit only the first matching background variable when another imported stylesheet controls the visible background. Do not audit unrelated components. " + (input.allowStylePreview ? "If saved changes affect only CSS, the system verifies them through Next.js development compilation in Live Preview; a production build is unnecessary. If other files change, production verification remains mandatory." : "Production verification is handled automatically after your edits.")] : []),
    ],
  });

  if (ports.snapshotConfigVersions) {
    const configVersions = ports.snapshotConfigVersions;
    const configInput = { ctx, companyId, projectId, workspaceId: session.workspaceId, ...(sessionId ? { sessionId } : {}) };
    try {
      const ref = await configVersions.ensureSystemPromptVersion({ ...configInput, promptText: systemPrompt, profileId: profile.id });
      ports.environment?.setSystemPrompt(ref ? { version: ref.version, contentHash: ref.contentHash } : null);
    } catch {
      ports.environment?.setSystemPrompt(null);
    }
    try {
      ports.environment?.setModelProfileVersion(
        await configVersions.ensureModelProfilesVersion({ ...configInput, profile }),
      );
    } catch {
      ports.environment?.setModelProfileVersion(null);
    }
  }

  return { systemPrompt };
}
