import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { SpreadsheetModifier } from "../apps/agent-api/src/spreadsheet-modifier";

describe("SpreadsheetModifier", () => {
  it("modifies CSV by inserting rows after a search term", async () => {
    const csv = "ID,Name,Status\r\n1,Task A,Pending\r\n2,Task B,Pending\r\n";
    const buf = Buffer.from(csv, "utf8");

    const result = await SpreadsheetModifier.applyEdits(buf, "tasks.csv", {
      action: "insert_after",
      search: "1",
      rows: [["1.1", "Task A.1", "Done"]],
    });

    const text = result.buffer.toString("utf8");
    expect(text).toContain("1.1");
    expect(text).toContain("Task A.1");
    expect(result.modifiedFilename).toBe("tasks_edited.csv");
  });

  it("modifies Excel workbook by inserting rows after row with ID", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("План");
    sheet.addRow(["ID", "Назва", "Статус"]);
    sheet.addRow([305, "Feature 305", "Pending"]);
    sheet.addRow([306, "Feature 306", "Pending"]);
    sheet.addRow([309, "Feature 309", "Pending"]);

    const inputBuf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await SpreadsheetModifier.applyEdits(inputBuf, "roadmap.xlsx", {
      sheet: "План",
      action: "insert_after",
      search: 306,
      rows: [
        [307, "Feature 307", "Active"],
        [308, "Feature 308", "Active"],
      ],
    });

    const outWb = new ExcelJS.Workbook();
    await outWb.xlsx.load(result.buffer as any);
    const outSheet = outWb.getWorksheet("План")!;
    expect(outSheet.rowCount).toBe(6);
    expect(result.modifiedFilename).toBe("roadmap_edited.xlsx");
  });
});
