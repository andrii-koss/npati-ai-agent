import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { AuthContext, InMemoryWorkspaceStore, Project } from "@npati/workspace";
import { ProjectOrchestrator } from "../../apps/agent-api/src/project-orchestrator";
import { CompanyDelegationRuntime } from "../../apps/agent-api/src/company-runtime";
import { FeatureFlagService } from "../../apps/agent-api/src/feature-flags";
import { ProjectPreviewService } from "../../apps/agent-api/src/project-preview-service";
import { CodeSessionRunExecutor } from "../../apps/agent-api/src/code-session-run-executor";
import type { OfflineMatrixDriver } from "./offline-matrix-145-driver";

export function installOfflineProjectSpies(input: {
  driver: OfflineMatrixDriver;
  store: InMemoryWorkspaceStore;
  auth: AuthContext;
}) {
  const { driver, store, auth } = input;
  const { names } = driver;

  async function ensureProjectRecord(params: {
    companyId: string;
    name: string;
    framework: string;
    kind: "website" | "game" | "mobile_app" | "api" | "code_project";
    type: "website" | "mobile_app" | "code_project";
    dataBackendId?: string;
    prompt: string;
  }): Promise<Project> {
    const existing = (await store.listProjects(auth, params.companyId)).find((p) => p.name === params.name);
    if (existing) {
      return store.updateProjectPreview(auth, params.companyId, existing.id, {
        framework: params.framework || existing.framework,
        status: "ready",
        previewUrl: "/preview",
        lastBuildStatus: "success",
        ...(params.dataBackendId ? { dataBackendId: params.dataBackendId } : {}),
      } as never);
    }
    const { project } = await store.createProject(
      auth,
      params.companyId,
      {
        name: params.name,
        description: params.prompt,
        type: params.type,
        kind: params.kind as never,
        dataBackendId: params.dataBackendId,
      },
      `proj-${params.companyId}-${params.name}`,
    );
    return store.updateProjectPreview(auth, params.companyId, project.id, {
      framework: params.framework,
      status: "ready",
      previewUrl: "/preview",
      lastBuildStatus: "success",
    });
  }

  function applyDataAndFiles(actionId: string, companyId: string, project: Project) {
    const pages = driver.pageState.get(project.name) ?? {};
    const existingFiles = driver.readProjectFiles(companyId, project.id);
    const files: Record<string, string> = { ...existingFiles };

    if (project.name === names.pNext) {
      if (actionId === "A006") {
        pages["/"] = "STRESS_BAKERY_SHOP";
        pages["/catalog"] = "Product catalog";
        pages["/about"] = "About";
        files["src/app/page.tsx"] = "export default function Home() { return <h1>STRESS_BAKERY_SHOP</h1>; }";
        files["src/app/globals.css"] = ":root { --accent: #d97706; }";
      } else if (actionId === "A009") {
        const ds = driver.ensureDataState(project.name);
        ds.foreignKey = true;
        ds.tables.categories = { columns: ["id", "name"], rows: [] };
        ds.tables.products = { columns: ["id", "name", "price", "category_id"], rows: [] };
      } else if (actionId === "A013") {
        pages["/faq"] = "STRESS_FAQ";
        files["src/app/faq/page.tsx"] = "export default function Faq() { return <h1>STRESS_FAQ</h1>; }";
      } else if (actionId === "A015") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.categories ??= { columns: ["id", "name"], rows: [] };
        ds.tables.products ??= { columns: ["id", "name", "price", "category_id"], rows: [] };
        const catId = "cat-bread-1";
        ds.tables.categories.rows = [{ id: catId, name: "Stress Bread" }];
        ds.tables.products.rows = [{ id: "prod-731", name: "STRESS_PRODUCT_731", price: 73.1, category_id: catId }];
      } else if (actionId === "A021") {
        pages["/catalog"] = "STRESS_PRODUCT_731 73.1";
        files["src/app/catalog/page.tsx"] = "export default function Catalog() { return <div>STRESS_PRODUCT_731 73.1</div>; }";
      } else if (actionId === "A024") {
        files["src/app/globals.css"] = ":root { --accent: #2563eb; }";
      } else if (actionId === "A029") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.products!.rows = [{ id: "prod-731", name: "STRESS_PRODUCT_UPDATED_732", price: 74.25, category_id: "cat-bread-1" }];
      } else if (["A030", "A040", "A080"].includes(actionId)) {
        pages["/catalog"] = "STRESS_PRODUCT_UPDATED_732 74.25";
        files["src/app/catalog/page.tsx"] = "export default function Catalog() { return <div>STRESS_PRODUCT_UPDATED_732 74.25</div>; }";
      } else if (actionId === "A036") {
        const ds = driver.ensureDataState(project.name);
        if (!ds.tables.products!.columns.includes("test_note")) ds.tables.products!.columns.push("test_note");
      } else if (actionId === "A047") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.stress_scratch = { columns: ["id", "note"], rows: [{ id: "scr-1", note: "TEST_SCRATCH_731" }] };
      } else if (actionId === "A048") {
        pages["/contact"] = "STRESS_CONTACT";
        files["src/app/contact/page.tsx"] = "export default function Contact() { return <h1>STRESS_CONTACT</h1>; }";
      } else if (actionId === "A052") {
        pages["/contact"] = "STRESS_CONTACT STRESS_FREE_PICKUP";
        files["src/components/DeliveryBadge.tsx"] = "export function DeliveryBadge() { return <span>STRESS_FREE_PICKUP</span>; }";
      } else if (actionId === "A057") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.products!.rows = [{ id: "prod-731", name: "STRESS_PRODUCT_UPDATED_732", price: 74.25, category_id: "cat-bread-1", test_note: "NOTE_CONTEXT_733" }];
      } else if (actionId === "A059") {
        files["src/app/globals.css"] = ":root { --accent: #d97706; }";
      } else if (actionId === "A065") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.products!.columns = ds.tables.products!.columns.filter((c) => c !== "test_note");
      } else if (actionId === "A073") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.stress_scratch!.rows = [{ id: "scr-1", note: "TEST_SCRATCH_735" }];
      } else if (actionId === "A079") {
        const ds = driver.ensureDataState(project.name);
        ds.tables.stress_scratch!.rows = [];
      } else if (actionId === "A085") {
        const ds = driver.ensureDataState(project.name);
        delete ds.tables.stress_scratch;
      } else if (actionId === "A087") {
        pages["/"] = "STRESS_BAKERY_SHOP Skip to content";
        files["src/app/page.tsx"] = "export default function Home() { return <main><a href='#main'>Skip to content</a><h1>STRESS_BAKERY_SHOP</h1></main>; }";
      }
    } else if (project.name === names.pVite) {
      if (actionId === "A027") {
        pages["/"] = "STRESS_VITE_STUDIO 0";
        files["src/App.jsx"] = "export default function App() { return <h1>STRESS_VITE_STUDIO</h1>; }";
      } else if (actionId === "A037") {
        pages["/"] = "STRESS_VITE_UPDATED 1";
        files["src/App.jsx"] = "export default function App() { return <h1>STRESS_VITE_UPDATED</h1>; }";
      } else if (actionId === "A069") {
        pages["/"] = "STRESS_VITE_UPDATED STRESS_COUNTER 2";
        files["src/App.jsx"] = "export default function App() { return <main><h1>STRESS_VITE_UPDATED</h1><button>STRESS_COUNTER</button></main>; }";
      }
    } else if (project.name === names.pAstro) {
      if (actionId === "A044") {
        pages["/about"] = "STRESS_ASTRO";
        files["src/pages/about.astro"] = "<h1>STRESS_ASTRO</h1>";
      } else if (actionId === "A063") {
        pages["/about"] = "STRESS_ASTRO STRESS_ASTRO_UPDATED";
        files["src/pages/about.astro"] = "<h1>STRESS_ASTRO STRESS_ASTRO_UPDATED</h1>";
      }
    } else {
      // Universal P001-P039 projects
      if (Object.keys(files).length === 0) {
        if (project.name === "V3 Pygame") {
          files["main.py"] = "import pygame\nSCORE_PER_STAR = 1\n";
          files["test_game.py"] = "def test_star(): assert True\n";
        } else if (project.name === "V3 Flutter") {
          files["lib/main.dart"] = "import 'package:flutter/material.dart';\nvoid main() {}\n";
          files["test/widget_test.dart"] = "// flutter test\n";
        } else if (project.kind === "mobile_app") {
          files["App.tsx"] = `import React from 'react'; import { View, Text } from 'react-native'; export default function App() { return <View><Text>${project.name}</Text></View>; }`;
          files["App.test.tsx"] = "test('mobile list', () => { expect(true).toBe(true); });";
        } else if (project.name === "V3 Phaser") {
          files["index.html"] = "<!doctype html><html><head><title>V3 Phaser</title></head><body><script>// phaser platformer</script></body></html>";
        } else if (project.kind === "api") {
          files["server.js"] = "// Express / FastAPI server with /health and /items";
        } else {
          const defaultMarker = project.name === "V3 HTML" ? "V3_HTML"
            : project.name === "V3 React" ? "V3_REACT"
            : project.name === "V3 Shop" ? "V3_SHOP"
            : project.name === "V3 Pages" ? "V3_PAGES"
            : project.name === "V3 Switch Site" ? "V3_SWITCH_SITE"
            : project.name;
          files["index.html"] = `<!doctype html><html lang="uk"><head><title>${project.name}</title></head><body><h1>${defaultMarker}</h1><button>0</button></body></html>`;
        }
      }
      if (actionId === "P001") pages["/"] = "V3_HTML";
      if (actionId === "P002") pages["/"] = "V3_REACT";
      if (actionId === "P003") pages["/"] = "V3_SHOP";
      if (actionId === "P004") {
        pages["/"] = "V3_PAGES";
        pages["/about.html"] = "About V3_PAGES";
        pages["/contact.html"] = "Contact V3_PAGES";
        files["about.html"] = "<!doctype html><html><head><title>About</title></head><body>About V3_PAGES</body></html>";
        files["contact.html"] = "<!doctype html><html><head><title>Contact</title></head><body>Contact V3_PAGES</body></html>";
      }
      if (actionId === "P005") {
        pages["/faq.html"] = "V3_FAQ";
        files["faq.html"] = "<!doctype html><html><head><title>FAQ</title></head><body><h1>V3_FAQ</h1></body></html>";
      }
      if (actionId === "P006") {
        files["index.html"] = "<!doctype html><html><head><title>V3 HTML</title><style>body{background:#14213d;color:#fca311;}</style></head><body><h1>V3_HTML</h1><button>0</button></body></html>";
      }
      if (actionId === "P014") {
        files["src/App.tsx"] = "// dark-blue background #0f172a and yellow X #facc15";
      }
      if (actionId === "P015") {
        pages["/"] = "V3_MATCH_SCORE";
        files["src/App.tsx"] = "// V3_MATCH_SCORE match counter";
      }
      if (actionId === "P020") {
        files["main.py"] = "import pygame\nSCORE_PER_STAR = 5\n";
      }
      if (actionId === "P028") {
        files["App.tsx"] = "import React from 'react'; import { View, Text } from 'react-native'; export default function App() { return <View><Text>V3_MOBILE_UPDATED</Text></View>; }";
      }
      if (actionId === "P033") {
        const ds = driver.ensureDataState(project.name);
        ds.foreignKey = true;
        ds.tables.categories = { columns: ["id", "name"], rows: [] };
        ds.tables.items = { columns: ["id", "name", "category_id"], rows: [] };
      }
      if (actionId === "P036") {
        pages["/contact.html"] = "V3_SWITCH_CONTACT";
        files["contact.html"] = "<!doctype html><html><head><title>Switch Contact</title></head><body><h1>V3_SWITCH_CONTACT</h1></body></html>";
      }
      if (actionId === "P037") {
        files["index.html"] = "<!doctype html><html><head><title>V3 Switch Game</title></head><body><h1>V3_SWITCH_GAME bonus +5</h1></body></html>";
      }
      if (actionId === "P038") {
        files["App.tsx"] = "import React from 'react'; import { View, Text } from 'react-native'; export default function App() { return <View><Text>V3_SWITCH_MOBILE_UPDATED</Text></View>; }";
      }
      if (actionId === "P039") {
        pages["/contact.html"] = "V3_SWITCH_CONTACT V3_AFTER_RESTART";
        files["contact.html"] = "<!doctype html><html><head><title>Switch Contact</title></head><body><h1>V3_SWITCH_CONTACT V3_AFTER_RESTART</h1></body></html>";
      }
    }

    driver.pageState.set(project.name, pages);
    driver.writeProjectFiles(companyId, project.id, files);
  }

  const orchestratorSpy = vi.spyOn(ProjectOrchestrator.prototype, "executeWebsiteTask").mockImplementation(async (ctx, params) => {
    const action = driver.getCurrentAction();
    const actionId = action?.id ?? "UNKNOWN";
    if (actionId === "P035") {
      const specs = [
        { name: "V3 Switch Site", framework: "HTML/CSS", kind: "website" as const, type: "website" as const },
        { name: "V3 Switch Game", framework: "HTML/CSS", kind: "game" as const, type: "website" as const },
        { name: "V3 Switch Mobile", framework: "Expo", kind: "mobile_app" as const, type: "mobile_app" as const },
      ];
      let firstProject: Project | undefined;
      for (const spec of specs) {
        const p = await ensureProjectRecord({ companyId: params.companyId, ...spec, prompt: params.prompt });
        applyDataAndFiles(actionId, params.companyId, p);
        firstProject ??= p;
      }
      const { run } = await store.createCompanyAgentRun(ctx, params.companyId, { task: params.prompt, requestedMode: "single", projectId: firstProject!.id }, `run-${actionId}`);
      const completed = await store.updateCompanyAgentRun(ctx, params.companyId, run.id, { status: "completed", executionMode: "single", result: "Created V3 Switch Site, V3 Switch Game, V3 Switch Mobile" });
      return {
        project: firstProject!,
        runDetails: { run: completed, steps: [], toolAudit: [], backgroundEvents: [] },
        responseMessage: "Created V3 Switch Site, V3 Switch Game, V3 Switch Mobile",
        projectCard: { id: firstProject!.id, projectId: firstProject!.id, name: firstProject!.name, status: "ready", companyId: params.companyId, framework: firstProject!.framework },
        projectAction: { action: "create", projectId: firstProject!.id, projectName: firstProject!.name, companyId: params.companyId },
        previewUrl: "/preview",
      };
    }

    const exp = action?.expect ?? {};
    const existingById = params.projectId
      ? (await store.listProjects(auth, params.companyId)).find((p) => p.id === params.projectId)
      : undefined;
    const targetName = exp.project ?? exp.name ?? params.intentDecision.targetDetails?.entityName ?? existingById?.name ?? "Project";
    const framework = exp.framework ?? (exp.stack === "Flutter" ? "Flutter" : exp.stack === "Expo" || exp.stack === "Android" ? "Expo" : params.intentDecision.targetDetails?.framework ?? existingById?.framework ?? "HTML/CSS");
    const kind = (exp.projectKind ?? (exp.kind === "game" || exp.kind === "python" ? "game" : exp.kind === "mobile" ? "mobile_app" : exp.kind === "backend" ? "api" : existingById?.kind ?? "website")) as "website" | "game" | "mobile_app" | "api";
    const type = kind === "mobile_app" ? "mobile_app" : "website";
    const needsDb = ["A009", "A015", "A021", "A029", "A036", "A047", "A057", "A065", "A073", "A079", "A085", "P033", "P034"].includes(actionId);
    const project = await ensureProjectRecord({
      companyId: params.companyId,
      name: targetName,
      framework,
      kind,
      type,
      dataBackendId: needsDb ? `db-${targetName.toLowerCase().replace(/\s+/g, "-")}` : undefined,
      prompt: params.prompt,
    });
    applyDataAndFiles(actionId, params.companyId, project);
    const { run } = await store.createCompanyAgentRun(ctx, params.companyId, { task: params.prompt, requestedMode: "single", projectId: project.id }, `run-${actionId}-${randomUUID()}`);
    const completed = await store.updateCompanyAgentRun(ctx, params.companyId, run.id, { status: "completed", executionMode: "single", result: `Completed ${actionId} on ${project.name}` });
    const responseMessage = actionId === "P029" || actionId === "P030"
      ? "Source Generated: PASS, Dependencies Installed: PASS, Static Analysis: PASS, Unit Tests: PASS, Native Build: BLOCKED (Android SDK, Flutter SDK, emulator absent in Sandbox), Installed/Launched: BLOCKED, Device UI E2E: BLOCKED."
      : `Completed ${actionId} for ${project.name}`;
    return {
      project,
      runDetails: { run: completed, steps: [], toolAudit: [], backgroundEvents: [] },
      responseMessage,
      projectCard: { id: project.id, projectId: project.id, name: project.name, status: "ready", companyId: params.companyId, framework: project.framework, previewUrl: "/preview", lastBuildStatus: "success" },
      projectAction: { action: params.projectId ? "edit" : "create", projectId: project.id, projectName: project.name, companyId: params.companyId },
      previewUrl: "/preview",
    };
  });

  const runtimeSpy = vi.spyOn(CompanyDelegationRuntime.prototype, "execute").mockImplementation(async (ctx, companyId, input, key) => {
    const action = driver.getCurrentAction();
    const agents = await store.listCompanyAgents(ctx, companyId);
    const selectedIds = agents.slice(0, 2).map((a) => a.id);
    const { run } = await store.createCompanyAgentRun(ctx, companyId, { task: input.task, requestedMode: input.mode ?? "pipeline", projectId: input.projectId }, key || `del-${randomUUID()}`);
    const resultText = action?.id === "A034" || action?.id === "A077"
      ? "STRESS_WEEKLY_OK"
      : action?.id === "A035"
        ? "Strategy for audience (local families and small offices), offer (sourdough & coffee) and two measurable experiments."
        : `Delegation completed by ${agents.map((a) => a.name).join(" and ")} (run ${run.id}).`;
    const completed = await store.updateCompanyAgentRun(ctx, companyId, run.id, {
      status: "completed",
      executionMode: "pipeline",
      selectedAgentIds: selectedIds,
      result: resultText,
    });
    return {
      run: completed,
      steps: selectedIds.map((agentId, index) => ({
        id: `step-${index}`,
        runId: completed.id,
        companyId,
        workspaceId: ctx.workspaceId,
        stepOrder: index + 1,
        agentId,
        task: input.task,
        status: "completed" as const,
        output: resultText,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      toolAudit: action?.id === "A041" && selectedIds[0]
        ? [{ id: "audit-read-1", runId: completed.id, companyId, workspaceId: ctx.workspaceId, agentId: selectedIds[0], toolName: "project.files.read", status: "succeeded" as const, durationMs: 5, inputSummary: { path: "src/App.jsx" }, outputSummary: { ok: true }, createdAt: new Date().toISOString() }]
        : [],
      backgroundEvents: [],
    };
  });

  const flagSpy = vi.spyOn(FeatureFlagService.prototype, "assertEnabled").mockResolvedValue(undefined);
  const previewSpy = vi.spyOn(ProjectPreviewService.prototype, "getPreviewStatus").mockResolvedValue({ isRunning: true, status: "running", previewUrl: "/preview" } as never);
  const execSpy = vi.spyOn(CodeSessionRunExecutor.prototype, "execute").mockResolvedValue({
    result: { status: "completed", message: "Batch verification passed", verification: { status: "passed", executedTools: ["typecheck", "test"] } } as never,
    terminalStatus: "completed",
    needsApproval: false,
  });

  return () => {
    orchestratorSpy.mockRestore();
    runtimeSpy.mockRestore();
    flagSpy.mockRestore();
    previewSpy.mockRestore();
    execSpy.mockRestore();
  };
}

