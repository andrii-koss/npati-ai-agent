import ExcelJS from "exceljs";

export interface SpreadsheetEditOperation {
  sheet?: string;
  action?: "insert_after" | "insert_rows" | "append_rows" | "update_cells" | "add_column" | "delete_rows" | "replace_sheet";
  search?: string | number;
  searchColumn?: string | number;
  afterRow?: number;
  rows?: (string | number | boolean | null)[][];
  cellUpdates?: Array<{
    row?: number;
    searchRow?: string | number;
    column: string | number;
    value: string | number | boolean | null;
  }>;
  newColumn?: {
    header: string;
    values?: (string | number | boolean | null)[];
  };
  deleteSearch?: string | number;
}

export interface SpreadsheetEditDirective {
  file?: string;
  operations?: SpreadsheetEditOperation[];
  sheet?: string;
  action?: SpreadsheetEditOperation["action"];
  search?: string | number;
  searchColumn?: string | number;
  afterRow?: number;
  rows?: (string | number | boolean | null)[][];
  cellUpdates?: SpreadsheetEditOperation["cellUpdates"];
  newColumn?: SpreadsheetEditOperation["newColumn"];
}

function escapeCsvCell(val: unknown): string {
  const str = String(val ?? "").trim();
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsv(content: string): string[][] {
  let clean = content;
  if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1);
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentVal = "";
  let insideQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        currentVal += '"';
        i++;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentVal.trim());
        currentVal = "";
      } else if (char === "\n" || (char === "\r" && nextChar === "\n")) {
        currentRow.push(currentVal.trim());
        currentVal = "";
        if (currentRow.some(c => c.length > 0)) rows.push(currentRow);
        currentRow = [];
        if (char === "\r") i++;
      } else {
        currentVal += char;
      }
    }
  }
  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    if (currentRow.some(c => c.length > 0)) rows.push(currentRow);
  }
  return rows;
}

export class SpreadsheetModifier {
  /**
   * Applies structured edit directives to an Excel workbook or CSV buffer.
   */
  static async applyEdits(
    inputBuffer: Buffer | Uint8Array,
    filename: string,
    directive: SpreadsheetEditDirective
  ): Promise<{ buffer: Buffer; modifiedFilename: string; summary: string }> {
    const isCsv = /\.csv$/i.test(filename);
    const baseName = filename.replace(/\.(xlsx|xlsm|xlsb|xls|csv)$/i, "");
    const ext = isCsv ? ".csv" : ".xlsx";
    const modifiedFilename = `${baseName}_edited${ext}`;

    const operations: SpreadsheetEditOperation[] = directive.operations?.length
      ? directive.operations
      : [{
          sheet: directive.sheet,
          action: directive.action ?? (directive.rows?.length ? "insert_after" : directive.cellUpdates?.length ? "update_cells" : "append_rows"),
          search: directive.search,
          searchColumn: directive.searchColumn,
          afterRow: directive.afterRow,
          rows: directive.rows,
          cellUpdates: directive.cellUpdates,
          newColumn: directive.newColumn,
        }];

    if (isCsv) {
      const csvStr = Buffer.isBuffer(inputBuffer) ? inputBuffer.toString("utf8") : Buffer.from(inputBuffer).toString("utf8");
      const result = this.applyCsvEdits(csvStr, operations);
      return {
        buffer: Buffer.from("\uFEFF" + result.csv, "utf8"),
        modifiedFilename,
        summary: result.summary,
      };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(inputBuffer as any);

    const summaries: string[] = [];

    for (const op of operations) {
      const sheet = this.resolveWorksheet(workbook, op.sheet);
      if (!sheet) continue;

      const summary = this.applyWorksheetOperation(sheet, op);
      if (summary) summaries.push(summary);
    }

    const outputBuffer = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(outputBuffer),
      modifiedFilename,
      summary: summaries.join("; ") || "Таблицю успішно відредаговано.",
    };
  }

  private static resolveWorksheet(workbook: ExcelJS.Workbook, sheetName?: string): ExcelJS.Worksheet | undefined {
    if (sheetName?.trim()) {
      const target = sheetName.trim().toLowerCase();
      const match = workbook.worksheets.find(
        (ws) => ws.name.trim().toLowerCase() === target || ws.name.toLowerCase().includes(target)
      );
      if (match) return match;
    }
    return workbook.worksheets[0];
  }

  private static applyWorksheetOperation(sheet: ExcelJS.Worksheet, op: SpreadsheetEditOperation): string {
    const action = op.action ?? "insert_after";

    // 1. Column addition
    if (action === "add_column" && op.newColumn) {
      const headerRow = sheet.getRow(1);
      const newColIndex = sheet.columnCount + 1;
      headerRow.getCell(newColIndex).value = op.newColumn.header;
      if (op.newColumn.values) {
        op.newColumn.values.forEach((val, idx) => {
          sheet.getRow(idx + 2).getCell(newColIndex).value = val;
        });
      }
      return `Додано нову колонку «${op.newColumn.header}» до аркуша «${sheet.name}»`;
    }

    // 2. Cell updates
    if (action === "update_cells" && op.cellUpdates?.length) {
      let updatedCount = 0;
      const headerRow = sheet.getRow(1);
      const headers = new Map<string, number>();
      headerRow.eachCell((cell, colNumber) => {
        headers.set(String(cell.value ?? "").trim().toLowerCase(), colNumber);
      });

      for (const update of op.cellUpdates) {
        let targetRowIndex = update.row;
        if (!targetRowIndex && update.searchRow != null) {
          const searchStr = String(update.searchRow).trim().toLowerCase();
          sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell) => {
              if (String(cell.value ?? "").trim().toLowerCase() === searchStr) {
                targetRowIndex = rowNumber;
              }
            });
          });
        }
        if (!targetRowIndex) continue;

        let colIndex = typeof update.column === "number" ? update.column : headers.get(String(update.column).trim().toLowerCase());
        if (!colIndex && typeof update.column === "string") {
          const colNum = parseInt(update.column, 10);
          if (!isNaN(colNum)) colIndex = colNum;
        }
        if (!colIndex) continue;

        sheet.getRow(targetRowIndex).getCell(colIndex).value = update.value;
        updatedCount++;
      }
      return `Оновлено ${updatedCount} клітинок у аркуші «${sheet.name}»`;
    }

    // 3. Row insertion or appending
    if ((action === "insert_after" || action === "insert_rows" || action === "append_rows") && op.rows?.length) {
      let insertIndex = -1;

      if (action !== "append_rows") {
        if (op.search != null) {
          const searchStr = String(op.search).trim().toLowerCase();
          sheet.eachRow((row, rowNumber) => {
            if (insertIndex !== -1) return;
            if (op.searchColumn != null) {
              const colKey = String(op.searchColumn).trim().toLowerCase();
              let targetCol = typeof op.searchColumn === "number" ? op.searchColumn : -1;
              if (targetCol === -1) {
                sheet.getRow(1).eachCell((cell, cNum) => {
                  if (String(cell.value ?? "").trim().toLowerCase() === colKey) targetCol = cNum;
                });
              }
              if (targetCol !== -1) {
                const val = String(row.getCell(targetCol).value ?? "").trim().toLowerCase();
                if (val === searchStr || val.includes(searchStr)) insertIndex = rowNumber;
              }
            } else {
              row.eachCell((cell) => {
                if (insertIndex !== -1) return;
                const val = String(cell.value ?? "").trim().toLowerCase();
                if (val === searchStr) insertIndex = rowNumber;
              });
            }
          });
        }

        if (insertIndex === -1 && op.afterRow != null) {
          insertIndex = op.afterRow;
        }
      }

      if (insertIndex === -1) {
        // Append at the bottom
        for (const rowData of op.rows) {
          sheet.addRow(rowData);
        }
        return `Додано ${op.rows.length} нових рядків у кінець аркуша «${sheet.name}»`;
      } else {
        // Insert after insertIndex
        let currentPos = insertIndex + 1;
        for (const rowData of op.rows) {
          // ExcelJS insertRow takes 1-based index and array of values
          sheet.insertRow(currentPos, rowData);
          currentPos++;
        }
        return `Вставлено ${op.rows.length} нових рядків після рядка ${insertIndex} у аркуш «${sheet.name}»`;
      }
    }

    return "";
  }

  private static applyCsvEdits(
    csvText: string,
    operations: SpreadsheetEditOperation[]
  ): { csv: string; summary: string } {
    let rows = parseCsv(csvText);
    const summaries: string[] = [];

    for (const op of operations) {
      const action = op.action ?? "insert_after";

      if (action === "add_column" && op.newColumn) {
        if (rows.length > 0) rows[0]!.push(op.newColumn.header);
        const colVals = op.newColumn.values ?? [];
        for (let r = 1; r < rows.length; r++) {
          rows[r]!.push(String(colVals[r - 1] ?? ""));
        }
        summaries.push(`Додано колонку «${op.newColumn.header}»`);
        continue;
      }

      if (action === "update_cells" && op.cellUpdates?.length) {
        const headerMap = new Map<string, number>();
        if (rows[0]) rows[0].forEach((h, idx) => headerMap.set(h.toLowerCase(), idx));

        let updated = 0;
        for (const u of op.cellUpdates) {
          let rowIdx = u.row ? u.row - 1 : -1;
          if (rowIdx === -1 && u.searchRow != null) {
            const s = String(u.searchRow).toLowerCase();
            rowIdx = rows.findIndex((r, i) => i > 0 && r.some(c => c.toLowerCase() === s));
          }
          if (rowIdx < 0 || rowIdx >= rows.length) continue;

          let colIdx = typeof u.column === "number" ? u.column - 1 : headerMap.get(String(u.column).toLowerCase());
          if (colIdx == null || colIdx < 0) continue;

          rows[rowIdx]![colIdx] = String(u.value ?? "");
          updated++;
        }
        summaries.push(`Оновлено ${updated} клітинок`);
        continue;
      }

      if ((action === "insert_after" || action === "insert_rows" || action === "append_rows") && op.rows?.length) {
        const stringRows = op.rows.map(r => r.map(c => String(c ?? "")));
        let insertPos = -1;

        if (action !== "append_rows" && op.search != null) {
          const s = String(op.search).toLowerCase();
          const foundIdx = rows.findIndex((r, i) => i > 0 && r.some(c => c.toLowerCase() === s));
          if (foundIdx !== -1) insertPos = foundIdx + 1;
        }

        if (insertPos === -1 && op.afterRow != null) {
          insertPos = op.afterRow;
        }

        if (insertPos === -1 || insertPos >= rows.length) {
          rows.push(...stringRows);
          summaries.push(`Додано ${stringRows.length} рядків у кінець таблиці`);
        } else {
          rows.splice(insertPos, 0, ...stringRows);
          summaries.push(`Вставлено ${stringRows.length} рядків після позиції ${insertPos}`);
        }
      }
    }

    const outputCsv = rows.map(r => r.map(escapeCsvCell).join(",")).join("\r\n");
    return {
      csv: outputCsv,
      summary: summaries.join("; ") || "Таблицю оновлено.",
    };
  }

  /**
   * Parses ```spreadsheet-edit ... ``` block from text if present.
   */
  static extractDirective(text: string): { directive: SpreadsheetEditDirective; cleanText: string } | null {
    const match = text.match(/```(?:spreadsheet-edit|table-edit|excel-edit)\s*([\s\S]*?)```/i);
    if (!match) return null;

    try {
      const rawJson = match[1]!.trim();
      const parsed = JSON.parse(rawJson);
      // Remove the code block from the user-facing text
      const cleanText = text.replace(match[0], "").trim();
      return { directive: parsed, cleanText };
    } catch {
      return null;
    }
  }
}
