import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { SpreadsheetModifier } from "../apps/agent-api/src/spreadsheet-modifier";

describe("SpreadsheetModifier", () => {
  it("extracts edit directives from raw JSON and generic JSON fences", () => {
    const raw = SpreadsheetModifier.extractDirective('{"action":"add_column","newColumn":{"header":"Status","values":["Done"]}}');
    expect(raw?.directive).toMatchObject({ action: "add_column", newColumn: { header: "Status" } });
    const fenced = SpreadsheetModifier.extractDirective('```json\n{"action":"update_cells","cellUpdates":[{"row":2,"column":"Status","value":"Done"}]}\n```');
    expect(fenced?.directive).toMatchObject({ action: "update_cells" });
    expect(fenced?.cleanText).toBe("");
  });

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

  it("maps a new column across every row of the original workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Roadmap");
    sheet.addRow(["Feature", "Current status"]);
    for (let index = 1; index <= 300; index++) {
      sheet.addRow([`Feature ${index}`, index % 2 ? "Already implemented" : "Planned"]);
    }
    const input = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await SpreadsheetModifier.applyEdits(input, "roadmap.xlsx", {
      action: "map_column",
      sourceColumn: "Current status",
      newColumn: { header: "Status" },
      valueMap: [
        { match: "Already implemented", value: "Done", mode: "contains" },
        { match: "Planned", value: "Planned", mode: "equals" },
      ],
      defaultValue: "Needs review",
    });

    const edited = new ExcelJS.Workbook();
    await edited.xlsx.load(result.buffer as any);
    const editedSheet = edited.getWorksheet("Roadmap")!;
    expect(editedSheet.rowCount).toBe(301);
    expect(editedSheet.getRow(2).getCell(3).value).toBe("Done");
    expect(editedSheet.getRow(301).getCell(3).value).toBe("Planned");
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
