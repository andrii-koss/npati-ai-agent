import { chatLanguageInstruction, codingChatResponseInstruction } from "./company-chat-i18n";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import type { CodeModelProfile } from "./code-model-profiles";
import { BUSINESS_MEMORY_HEADER, COMPANY_MEMORY_HEADER, PROJECT_CONTEXT_HEADER, renderContextBlocks } from "./code-context-memory";
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
          loaded.businessMemory ? { header: BUSINESS_MEMORY_HEADER, body: loaded.businessMemory, chars: loaded.businessMemory.length, truncated: false } : null,
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
      "An explicit user restriction such as 'edit only index.html' remains binding during verification repair. If a failing check requires changing another file, report that limitation and stop; do not repair outside the user's scope or use shell/delegation as a workaround.",
      "For an underspecified creation request, state reasonable assumptions in the user's language and implement a usable result. Ask a concise question only if a missing decision prevents useful implementation. A generic title, empty main element, framework starter or a successful HTTP/build response alone does not fulfill a website request. Write real domain content and working actions before finishing. Once the entry page has been read, edit it instead of repeatedly inspecting the scaffold.",
      "For an existing-project bug fix, diagnose the failing behavior and apply the smallest causal correction. Do not add product flows, initial-fetch effects, unrelated cleanup, dependency upgrades or build/install hooks unless evidence shows they are required to fix that behavior. Restore missing dependencies through code.deps.install, without changing application scripts. Review the complete diff against the original request before finishing, and remove only your own unrelated edits while preserving pre-existing changes.",
      "When creating Node/fullstack tests, verify the documented root npm test command itself, including workspace delegation, on the actual sandbox Node version. Use node --test with explicit test files, supported globs or automatic discovery; do not use a directory operand such as node --test test/. Passing a different direct-file command does not validate the documented command. Keep assertions and test coverage intact when fixing scripts.",
      "Never embed fixed passwords or tokens in application code; load them from the approved secret environment. In test files under tests/ or named *.test.* a plain sample password is fine, but never a real key. If a tool reports secret_content, it is a protection refusal, not a network failure: identify the affected file and replace only credentials you introduced with runtime generation/environment references. Never relax scanning, move the same secret elsewhere, or retry the identical command expecting HTTP500 recovery.",
      "When a user asks for a file containing a supplied literal text, preserve that content exactly, including whitespace. Do not append a newline unless the supplied content includes one or the user requests it. Use code.fs.write with the exact content when a line-based patch would add a trailing newline. A file with additional whitespace is not an exact match; inspect and correct it before claiming success.",
      "Never invent a fact about the company or its business that neither the user nor the supplied company or business memory gives (address, phone, e-mail, prices, opening hours, names, numbers). When the request needs such a fact and it is missing, do not write a made-up value that looks real; leave that content out and ask the user for the fact in your reply.",
      "Generate dependency lockfiles through the package manager. Never invent registry URLs or integrity hashes, or downgrade an installed package because you remember a different latest version. Use current registry or package-manager evidence for version claims.",
      "A request to change a page's title or heading means what the user sees: update the visible main heading and the document title together.",
      "In a TypeScript project keep \"noEmit\": true in tsconfig and run type checks with tsc --noEmit, so no compiled .js files land next to the sources.",
      "The project has a git history of every step. To see or restore how something was before, read it with the shell: git log --oneline, git log -p -- <file>, git show <commit>:<file>. When restoring, bring back every value that step changed, then check the file before saying it is done.",
      "Packages that compile native code install slowly. Unless the user names one, prefer node:sqlite over better-sqlite3 and bcryptjs over bcrypt.",
      "Before finishing, compare the result with every requirement in the request, including the named languages and frameworks. Do what is missing, and state plainly anything you could not do.",
      "Do not begin application creation with a batch of npm view/version queries. The task does not require claiming the latest version. Declare compatible package ranges and let the permitted package-manager workflow resolve and lock them. If a registry query requires approval, do not repeat it for more packages or treat the refusal as an outage; continue the permitted source implementation and report any installation approval that is actually necessary. Never bypass an approval or claim a registry check you did not complete.",
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
