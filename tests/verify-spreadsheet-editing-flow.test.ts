import { describe, it, expect, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { SpreadsheetModifier } from "../apps/agent-api/src/spreadsheet-modifier";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const apps: Array<ReturnType<typeof buildApp>> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("End-to-end spreadsheet modification pipeline", () => {
  it("processes a multi-sheet roadmap file, finds ID 306, and inserts items 307 and 308 while keeping original rows", async () => {
    // 1. Build a realistic multi-sheet workbook mimicking the user's roadmap
    const wb = new ExcelJS.Workbook();
    
    // Sheet 1: Features
    const sheet1 = wb.addWorksheet("Функції та roadmap");
    sheet1.addRow(["ID", "Функція", "Статус"]);
    for (let i = 1; i <= 50; i++) {
      sheet1.addRow([i, `Feature ${i}`, "Active"]);
    }

    // Sheet 2: Plan NPATI
    const sheet2 = wb.addWorksheet("План NPATI");
    sheet2.addRow(["Етап", "Черга", "ID", "Продукт", "Категорія", "Функція", "Статус"]);
    for (let i = 1; i <= 306; i++) {
      sheet2.addRow([1, i, i, "NPATI", "CORE", `Task ${i}`, "Completed"]);
    }
    sheet2.addRow([2, 307, 309, "NPATI", "FUTURE", "Future Task 309", "Planned"]);

    const originalBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    // 2. Apply the edit directive (simulating what LLM outputs when asked to add items after 306)
    const directive = {
      sheet: "План NPATI",
      action: "insert_after" as const,
      search: 306,
      rows: [
        [10, 999, 307, "NPATI", "TEST", "Тестовий пункт 307", "🧪 Test item"],
        [10, 1000, 308, "NPATI", "TEST", "Тестовий пункт 308", "🧪 Test item"],
      ],
    };

    const result = await SpreadsheetModifier.applyEdits(
      originalBuffer,
      "omniroute_v3.8.50_openclaw_features_roadmap_NPATI_with_plan.xlsx",
      directive
    );

    expect(result.modifiedFilename).toBe("omniroute_v3.8.50_openclaw_features_roadmap_NPATI_with_plan_edited.xlsx");

    // 3. Inspect modified workbook
    const modifiedWb = new ExcelJS.Workbook();
    await modifiedWb.xlsx.load(result.buffer as any);

    // Verify sheet 1 is completely preserved
    const resSheet1 = modifiedWb.getWorksheet("Функції та roadmap")!;
    expect(resSheet1).toBeDefined();
    expect(resSheet1.rowCount).toBe(51);

    // Verify sheet 2 has all original rows + 2 new rows inserted right after 306
    const resSheet2 = modifiedWb.getWorksheet("План NPATI")!;
    expect(resSheet2).toBeDefined();
    expect(resSheet2.rowCount).toBe(306 + 1 + 2 + 1); // 306 original + 1 future + 2 new + 1 header = 310

    // Row 306 should be at row index 307 (due to header)
    const row306 = resSheet2.getRow(307);
    expect(row306.getCell(3).value).toBe(306);

    // Row 307 (new) should be at row index 308
    const row307 = resSheet2.getRow(308);
    expect(row307.getCell(3).value).toBe(307);
    expect(row307.getCell(6).value).toBe("Тестовий пункт 307");

    // Row 308 (new) should be at row index 309
    const row308 = resSheet2.getRow(309);
    expect(row308.getCell(3).value).toBe(308);

    // Row 309 (existing future row) should now be at row index 310
    const row309 = resSheet2.getRow(310);
    expect(row309.getCell(3).value).toBe(309);
  });

  it("handles user uploading XLSX in chat, requesting edit in company context, and returns edited file", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Клієнти");
    sheet.addRow(["ID", "Ім'я", "Статус"]);
    sheet.addRow([1, "Олександр", "Новий"]);
    sheet.addRow([2, "Марія", "Новий"]);
    const sourceBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    const auth: AuthContext = { workspaceId: "ws-test", userId: "user-test", permissions: ["workspace:read", "workspace:write"] };
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NPATI Tech", industry: "IT" }, "test-company-key-1");

    const aiEngine: AIEngine = {
      chat: async () => ({
        content: "Готово! Я оновив статус клієнтів у вашій таблиці.\n```spreadsheet-edit\n{\n  \"sheet\": \"Клієнти\",\n  \"action\": \"update_cells\",\n  \"cellUpdates\": [\n    {\"row\": 2, \"column\": 3, \"value\": \"В роботі\"},\n    {\"row\": 3, \"column\": 3, \"value\": \"Завершено\"}\n  ]\n}\n```",
      }),
      async *stream() {
        yield "Готово! Я оновив статус клієнтів у вашій таблиці.\n```spreadsheet-edit\n{\n  \"sheet\": \"Клієнти\",\n  \"action\": \"update_cells\",\n  \"cellUpdates\": [\n    {\"row\": 2, \"column\": 3, \"value\": \"В роботі\"},\n    {\"row\": 3, \"column\": 3, \"value\": \"Завершено\"}\n  ]\n}\n```";
      },
      listModels: async () => [],
      getModel: async () => undefined,
      executeTool: async () => undefined,
      searchMemory: async () => [],
      saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
    };

    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "npati-chat-edit-"));
    tempDirectories.push(dataDirectory);

    const app = buildApp({
      workspaceStore: store,
      authProvider: { authenticate: async () => auth },
      aiEngine,
      marketplace,
      dataDirectory,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        contextType: "company",
        companyId: company.id,
        message: "відредагуй таблицю і поверни мені ту саму таблицю відредаговану",
        attachments: [{
          kind: "document",
          name: "clients.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          dataBase64: sourceBuffer.toString("base64"),
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message).toContain("clients_edited.xlsx");
    expect(body.message).toContain("[[npati-attachment:document:");
    expect(body.message).not.toContain("spreadsheet-edit");

    // Fetch conversation and verify attachment exists in chat files
    const attachmentMatch = body.message.match(/\[\[npati-attachment:document:([0-9a-f-]{36}):/);
    expect(attachmentMatch).toBeTruthy();
    const fileId = attachmentMatch![1];

    const fileResp = await app.inject({
      method: "GET",
      url: `/attachments/${fileId}`,
    });
    expect(fileResp.statusCode).toBe(200);

    const modifiedWb = new ExcelJS.Workbook();
    await modifiedWb.xlsx.load(fileResp.rawPayload as any);
    const modSheet = modifiedWb.getWorksheet("Клієнти")!;
    expect(modSheet.getCell(2, 3).value).toBe("В роботі");
    expect(modSheet.getCell(3, 3).value).toBe("Завершено");
  });

  it("handles fallback AI planner when primary model outputs markdown table instead of directive", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Завдання");
    sheet.addRow(["ID", "Задача"]);
    sheet.addRow([1, "Налаштувати DNS"]);
    const sourceBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    const auth: AuthContext = { workspaceId: "ws-test2", userId: "user-test2", permissions: ["workspace:read", "workspace:write"] };
    const store = new InMemoryWorkspaceStore();

    let plannerCalled = false;
    const aiEngine: AIEngine = {
      chat: async (req) => {
        const isPlanner = req.messages.some((m) => typeof m.content === "string" && m.content.includes("spreadsheet-edit JSON object"));
        if (isPlanner) {
          plannerCalled = true;
          // Verify valid message sequence: system -> user
          expect(req.messages[0]?.role).toBe("system");
          expect(req.messages[1]?.role).toBe("user");
          return {
            content: "```spreadsheet-edit\n{\n  \"sheet\": \"Завдання\",\n  \"action\": \"append_rows\",\n  \"rows\": [[2, \"Підключити SSL\"]]\n}\n```",
          };
        }
        // Primary call returns prose + markdown table
        return {
          content: "Ось оновлена таблиця:\n| ID | Задача |\n|---|---|\n| 1 | Налаштувати DNS |\n| 2 | Підключити SSL |",
        };
      },
      async *stream() {
        yield "Ось оновлена таблиця:\n| ID | Задача |\n|---|---|\n| 1 | Налаштувати DNS |\n| 2 | Підключити SSL |";
      },
      listModels: async () => [],
      getModel: async () => undefined,
      executeTool: async () => undefined,
      searchMemory: async () => [],
      saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
    };

    const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "npati-chat-fallback-"));
    tempDirectories.push(dataDirectory);

    const app = buildApp({
      workspaceStore: store,
      authProvider: { authenticate: async () => auth },
      aiEngine,
      marketplace,
      dataDirectory,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        contextType: "none",
        message: "додай нову задачу у таблицю та поверни мені ту саму таблицю відредаговану",
        attachments: [{
          kind: "document",
          name: "tasks.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          dataBase64: sourceBuffer.toString("base64"),
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(plannerCalled).toBe(true);
    const body = response.json();
    expect(body.message).toContain("tasks_edited.xlsx");
    expect(body.message).toContain("[[npati-attachment:document:");
  });
});
