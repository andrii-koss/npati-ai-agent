import { describe, expect, it } from "vitest";
import type { CodeSession } from "@npati/workspace";
import { classifyCodeIntent, codeIntentIsReadOnly } from "@npati/shared";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { CODE_WRITE_TOOLS } from "../apps/agent-api/src/code-edit-approval";
import { CodingAgentToolCatalog } from "../apps/agent-api/src/coding-agent-tool-catalog";
import {
  CONSERVATIVE_CODE_MODEL_PROFILE,
  DEFAULT_CODE_MODEL_PROFILES,
  resolveToolVisibility,
  validateCodeModelProfile,
  type CodeModelProfile,
} from "../apps/agent-api/src/code-model-profiles";
import {
  DEFAULT_CODE_TOOL_VISIBILITY,
  MINIMAL_CODE_TOOL_VISIBILITY,
  selectVisibleTools,
  type CodeToolVisibilityContext,
} from "../apps/agent-api/src/code-tool-visibility";
import { WEBSITE_EDIT_TOOL_PATTERN } from "../apps/agent-api/src/coding-agent-runner";

const profile = (id: string): CodeModelProfile =>
  id === CONSERVATIVE_CODE_MODEL_PROFILE.id ? CONSERVATIVE_CODE_MODEL_PROFILE : DEFAULT_CODE_MODEL_PROFILES.find((entry) => entry.id === id)!;

function catalog(overrides: Partial<Record<string, boolean>> = {}) {
  const listed = CODE_TOOL_SCHEMAS.map((schema) => ({
    name: schema.name, version: schema.version, status: schema.status, description: schema.description,
    write: CODE_WRITE_TOOLS.has(schema.name), available: overrides[schema.name] ?? true,
  }));
  return new CodingAgentToolCatalog({ toolRuntime: { listTools: () => listed }, schemas: CODE_TOOL_SCHEMAS } as never, { delegationAllowed: true } as never);
}

const session = (mode: string): CodeSession => ({ mode, toolManifestVersion: null } as unknown as CodeSession);
const allFlags = { asyncProcessesEnabled: true, asyncSubagentsEnabled: true, asyncAgentControlsEnabled: true };

function offered(profileId: string, mode: string, context: Partial<CodeToolVisibilityContext> = {}, readOnlyIntent = false) {
  const available = catalog().toolDescriptors(session(mode), { ...allFlags, readOnlyIntent }).map((tool) => tool.name);
  return selectVisibleTools(available, resolveToolVisibility(profile(profileId)), {
    userMessage: "", sessionMode: mode, readOnlyIntent, dataStudioEnabled: true, ...context,
  });
}

describe("Coding Agent tool visibility tiers", () => {
  it("every shipped profile declares valid tiers and the conservative default resolves to the minimal core", () => {
    for (const entry of DEFAULT_CODE_MODEL_PROFILES) expect(() => validateCodeModelProfile(entry)).not.toThrow();
    expect(resolveToolVisibility(profile("hosted-native-tools"))).toBe(DEFAULT_CODE_TOOL_VISIBILITY);
    expect(resolveToolVisibility(profile("hosted-native-tools-small-context"))).toBe(MINIMAL_CODE_TOOL_VISIBILITY);
    expect(resolveToolVisibility(profile("local-text-tools"))).toBe(MINIMAL_CODE_TOOL_VISIBILITY);
    expect(resolveToolVisibility(CONSERVATIVE_CODE_MODEL_PROFILE)).toBe(MINIMAL_CODE_TOOL_VISIBILITY);
    expect(() => validateCodeModelProfile({ ...profile("hosted-native-tools"), toolVisibility: { core: [], contextual: [], intentGroups: ["nope"] } } as never))
      .toThrow(/unknown group/);
  });

  it("offers only the core to a plain edit request, smaller for small-context and local profiles", () => {
    const hosted = offered("hosted-native-tools", "auto_edit", { userMessage: "change the hero heading text on the home page" });
    expect([...hosted.visible].sort()).toEqual(DEFAULT_CODE_TOOL_VISIBILITY.core.filter((name) => CODE_TOOL_SCHEMAS.some((schema) => schema.name === name)).sort());
    for (const id of ["hosted-native-tools-small-context", "local-text-tools", CONSERVATIVE_CODE_MODEL_PROFILE.id]) {
      const small = offered(id, "auto_edit", { userMessage: "change the hero heading text on the home page" });
      expect(small.visible.length).toBeLessThan(hosted.visible.length);
      expect(small.visible).not.toContain("code.fs.apply_patch");
      expect(small.visible).toEqual(expect.arrayContaining(["code.fs.read", "code.fs.grep", "code.fs.edit", "code.fs.write", "code.shell.exec", "code.verify.run"]));
    }
    expect(hosted.visible.length).toBeLessThanOrEqual(12);
  });

  it("adds intent groups only when the request or the project state asks for them", () => {
    const git = offered("hosted-native-tools", "auto_edit", { userMessage: "commit the change and open a pull request" });
    expect(git.visible).toEqual(expect.arrayContaining(["code.git.status", "code.git.commit", "code.git.pr.create"]));
    expect(git.visible.some((name) => name.startsWith("code.data."))).toBe(false);

    const data = offered("hosted-native-tools", "auto_edit", { userMessage: "створи таблицю замовлень у базі даних" });
    expect(data.visible).toEqual(expect.arrayContaining(["code.data.schema.inspect", "code.data.schema.apply"]));
    expect(data.visible.some((name) => name.startsWith("code.git."))).toBe(false);

    const attached = offered("hosted-native-tools", "auto_edit", { userMessage: "show the orders on the page", dataBackendAttached: true });
    expect(attached.visible).toContain("code.data.schema.inspect");

    const flagOff = offered("hosted-native-tools", "auto_edit", { userMessage: "створи таблицю в базі даних", dataStudioEnabled: false });
    expect(flagOff.visible.some((name) => name.startsWith("code.data."))).toBe(false);
    expect(flagOff.hidden.find((entry) => entry.name === "code.data.schema.apply")?.reason).toBe("data_studio_disabled");

    const plain = offered("hosted-native-tools", "auto_edit", { userMessage: "fix the typo in the footer" });
    for (const prefix of ["code.git.", "code.agent.", "code.data.", "code.deps."]) {
      expect(plain.visible.some((name) => name.startsWith(prefix))).toBe(false);
    }
  });

  it("matches Ukrainian keywords without relying on ASCII word boundaries", () => {
    expect(offered("hosted-native-tools", "auto_edit", { userMessage: "склади план робіт" }).intentGroups).toContain("planning");
    expect(offered("hosted-native-tools", "auto_edit", { userMessage: "покажи логи сервера" }).intentGroups).toContain("processes");
    expect(offered("hosted-native-tools", "auto_edit", { userMessage: "яка структура бд" }).intentGroups).toContain("data");
    expect(offered("hosted-native-tools", "auto_edit", { userMessage: "плануй" }).intentGroups).not.toContain("planning");
  });

  it("never hides a degraded tool behind an intent: it stays out of the model's list", () => {
    const decision = offered("hosted-native-tools", "full_auto", { userMessage: "run it in the background as a long-running process" });
    expect(decision.visible).not.toContain("code.shell.exec_async");
    expect(decision.visible).not.toContain("code.shell.process.wait");
    expect(decision.hidden.filter((entry) => entry.reason === "degraded").map((entry) => entry.name).sort())
      .toEqual(["code.shell.exec_async", "code.shell.process.wait"]);
  });

  it("changing the session mode changes the set: plan and read-only intents carry no write tool at all", () => {
    const edit = offered("hosted-native-tools", "auto_edit", { userMessage: "проаналізуй структуру проєкту" });
    const plan = offered("hosted-native-tools", "plan", { userMessage: "проаналізуй структуру проєкту" });
    const review = offered("hosted-native-tools", "auto_edit", { userMessage: "проаналізуй структуру проєкту" }, true);
    expect(edit.visible).not.toEqual(plan.visible);
    for (const decision of [plan, review]) {
      expect(decision.visible.filter((name) => CODE_WRITE_TOOLS.has(name) && name !== "code.fs.diff")).toEqual([]);
      expect(decision.visible.filter((name) => name.startsWith("code.shell.") || name === "code.verify.run")).toEqual([]);
      expect(decision.visible).toEqual(expect.arrayContaining(["code.fs.read", "code.fs.grep"]));
    }
  });

  it("classifies an analysis request as read-only unless it also asks for a change", () => {
    for (const message of ["проаналізуй сайт і скажи що не так", "Analyze the checkout flow", "оціни якість коду в проєкті", "зроби аналіз структури"]) {
      const decision = classifyCodeIntent({ message, activeProjectId: "p1", projectKind: "code_project", projectIntent: "EDIT_PROJECT" });
      expect(decision.intent, message).toBe("REVIEW_CODE");
      expect(codeIntentIsReadOnly(decision.intent)).toBe(true);
    }
    for (const message of ["проаналізуй і виправ помилку в формі", "analyze and fix the login bug", "зміни колір кнопки"]) {
      const decision = classifyCodeIntent({ message, activeProjectId: "p1", projectKind: "code_project", projectIntent: "EDIT_PROJECT" });
      expect(codeIntentIsReadOnly(decision.intent), message).toBe(false);
    }
  });

  it("keeps a tool without an executor out of the model's list", () => {
    const tools = catalog({ "code.fs.tree": false }).toolDescriptors(session("auto_edit"), allFlags).map((tool) => tool.name);
    expect(tools).not.toContain("code.fs.tree");
    expect(tools).toContain("code.fs.read");
  });

  it("describes every offered core tool with WHEN / NOT WHEN / RETURNS and explicit pair boundaries", () => {
    const hosted = offered("hosted-native-tools", "auto_edit", { userMessage: "change the hero heading text" });
    const tools = catalog().toolDescriptors(session("auto_edit"), allFlags).filter((tool) => hosted.visible.includes(tool.name));
    const definitions = catalog().chatToolDefinitions(tools);
    const byName = new Map(definitions.map((definition) => [definition.function.name, definition.function.description ?? ""]));
    for (const [name, description] of byName) {
      expect(description, name).toMatch(/WHEN:/);
      expect(description, name).toMatch(/NOT WHEN:/);
      expect(description, name).toMatch(/RETURNS/);
    }
    expect(byName.get("code.fs.read")).toContain("code.image.view");
    expect(byName.get("code.fs.edit")).toContain("code.fs.apply_patch");
    expect(byName.get("code.fs.write")).toContain("code.fs.edit");
    expect(byName.get("code.shell.exec")).toContain("code.verify.run");
    expect(byName.get("code.verify.run")).toContain("code.shell.exec");
    expect(byName.get("code.fs.grep")).toContain("code.fs.read");
    // The published schema description itself is untouched: the guidance is appended for the model only.
    for (const schema of CODE_TOOL_SCHEMAS.filter((entry) => byName.has(entry.name))) expect(byName.get(schema.name)!.startsWith(schema.description.trim())).toBe(true);
  });

  it("does not offer image viewing or screenshots when a website edit carries the reference and the system verifies it", () => {
    const withReference = offered("hosted-native-tools", "auto_edit", { userMessage: "зроби дизайн як на фото", websiteEdit: true, imageCount: 1 });
    expect(withReference.visible).not.toContain("code.image.view");
    expect(withReference.visible).not.toContain("code.preview.screenshot");
    const styleOnly = offered("hosted-native-tools", "auto_edit", { userMessage: "зроби кнопку яскравішою", websiteEdit: true });
    expect(styleOnly.visible).toContain("code.preview.screenshot");
    const codeProject = offered("hosted-native-tools", "auto_edit", { userMessage: "check logo.png", imageCount: 0 });
    expect(codeProject.visible).toContain("code.image.view");
  });

  it("matches context on the user's words, not on the system guidance appended to a website prompt", () => {
    const decision = offered("hosted-native-tools", "auto_edit", { userMessage: "зміни колір кнопки на зелений", websiteEdit: true });
    expect(decision.visible.some((name) => name.startsWith("code.data."))).toBe(false);
    expect(WEBSITE_EDIT_TOOL_PATTERN.test("code.git.commit")).toBe(false);
    expect(WEBSITE_EDIT_TOOL_PATTERN.test("code.agent.spawn")).toBe(false);
    expect(WEBSITE_EDIT_TOOL_PATTERN.test("code.fs.edit")).toBe(true);
  });
});
