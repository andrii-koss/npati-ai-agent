import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { SpreadsheetModifier } from "../apps/agent-api/src/spreadsheet-modifier";

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
});
