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
        ...(!input.noMemory ? { sessionId } : {}),
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
      "Browser QA functionalQaPassed=true means no blocking errors, not zero warnings. Report qaSummary.status and the actual brokenLinksCount/a11yViolationsCount/warningCount. Never claim zero broken links or zero issues when those counters are nonzero; a local-link request warning may require another check and must be disclosed, not silently dismissed.",
      "For server-rendered websites, the initial client render must match the server HTML. Locale data can differ between Node and browsers: use deterministic currencyDisplay: 'code' or explicit stable units for currency; avoid default Intl currency symbols, locale-dependent dates, random values or current timestamps in initial SSR markup. A passing build does not prove hydration. If Browser QA reports hydration errors, fix their source in the same project, rebuild and recheck; do not suppress warnings or claim success from HTTP alone.",
      "Sandbox shell calls accept exactly one simple command with arguments. Never use pipes, redirects, substitutions, semicolons or &&/|| chaining. Read source through code.fs.read, not sed/fold pipelines. Run independent checks as separate calls in one tool batch (for example node --check app.js, then wc -l index.html styles.css app.js); do not append echo. A rejected shell call has not changed files: correct only that call and retain all successful edits; do not restart implementation or repeat saved writes.",
      ...(input.responseLanguage ? [chatLanguageInstruction("", [], input.responseLanguage), codingChatResponseInstruction()] : []),
      ...(input.emptyHtmlWorkspace ? ["This is a new empty HTML/CSS/JavaScript project, not an existing-code edit. Start by writing the requested index.html directly with code.fs.write; do not list files, inspect project info, search a template or create a plan first. Write the requested user-facing content, then add the CSS and JavaScript needed. Existing-file read-before-edit rules apply only after you have created files. Do not turn the first write into a placeholder or a starter template."] : []),
      ...(input.websiteEdit ? ["This is an edit to an existing working website. Scale the workflow to the actual scope: a local color, spacing or text adjustment needs only the affected files, one coherent patch, and automatic verification. Do not create a project-wide plan or audit for a local adjustment. Use supplied revision-checked edit memory to locate prior work; re-read relevant current source before editing. For a request only about the main/background color, if that color is already applied, say so and finish after a minimal check; do not invent extra edits just to produce a diff or because the user repeated a request. A main/background color request does not authorize recoloring secondary panels, accents, gradients or every component unless explicitly requested. Do not search for hypothetical overrides without concrete evidence in the already-read source or Preview. Inspect only the affected selectors, batch the requested changes and finish. For a small theme edit, when stylesheet locations are supplied in repository context, begin with a bounded read of their theme variables and body selectors; do not rediscover known stylesheet paths with grep/tree/list. Before any edit, call code.fs.read for every file you will change, with all independent reads in one tool batch. A grep result, remembered content or supplied path does not satisfy the read-before-write requirement. For known stylesheet paths, prefer direct reads over grep. Then apply one coherent patch and finish. For CSS edits, account for the supplied stylesheet import order and overriding selectors: a rule in an earlier stylesheet can be overridden by a later one. Do not edit only the first matching background variable when another imported stylesheet controls the visible background. Do not audit unrelated components. " + (input.allowStylePreview ? "If saved changes affect only CSS, the system verifies them through Next.js development compilation in Live Preview; a production build is unnecessary. If other files change, production verification remains mandatory." : "Production verification is handled automatically after your edits.")] : []),
      ...(input.extraSystemPromptLines ?? []),
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
