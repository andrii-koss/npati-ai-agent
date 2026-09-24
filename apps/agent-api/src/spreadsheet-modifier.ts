import ExcelJS from "exceljs";

export interface SpreadsheetEditOperation {
  sheet?: string;
  action?: "insert_after" | "insert_rows" | "append_rows" | "update_cells" | "add_column" | "map_column" | "delete_rows" | "replace_sheet";
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
  sourceColumn?: string | number;
  valueMap?: Array<{
    match: string;
    value: string | number | boolean | null;
    mode?: "contains" | "equals" | "starts_with" | "regex";
  }>;
  defaultValue?: string | number | boolean | null;
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
  sourceColumn?: SpreadsheetEditOperation["sourceColumn"];
  valueMap?: SpreadsheetEditOperation["valueMap"];
  defaultValue?: SpreadsheetEditOperation["defaultValue"];
}

export function normalizeSpreadsheetAction(rawAction?: string): SpreadsheetEditOperation["action"] | undefined {
  if (!rawAction) return undefined;
  const a = String(rawAction).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (a === "add_column" || a === "add_col" || a === "new_column" || a === "column") return "add_column";
  if (a === "map_column" || a === "map_col" || a === "map_values" || a === "map") return "map_column";
  if (a === "update_cells" || a === "update_cell" || a === "update" || a === "edit_cells" || a === "edit_cell" || a === "edit" || a === "modify_cells" || a === "modify" || a === "set_cells" || a === "set_cell") return "update_cells";
  if (a === "insert_after" || a === "insert" || a === "insert_row" || a === "insert_rows") return "insert_after";
  if (a === "append_rows" || a === "append_row" || a === "append" || a === "add_row" || a === "add_rows") return "append_rows";
  if (a === "delete_rows" || a === "delete_row" || a === "delete" || a === "remove_rows" || a === "remove_row" || a === "remove") return "delete_rows";
  if (a === "replace_sheet" || a === "replace_rows" || a === "replace") return "replace_sheet";
  return undefined;
}

export function columnLetterToIndex(col: string | number): number | undefined {
  if (typeof col === "number") return col;
  const clean = String(col).trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(clean)) return undefined;
  let index = 0;
  for (let i = 0; i < clean.length; i++) {
    index = index * 26 + (clean.charCodeAt(i) - 64);
  }
  return index;
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
          sourceColumn: directive.sourceColumn,
          valueMap: directive.valueMap,
          defaultValue: directive.defaultValue,
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
    const action = normalizeSpreadsheetAction(op.action) ?? "insert_after";

    // 1. Column addition
    if (action === "add_column" && op.newColumn) {
      const headerRow = sheet.getRow(1);
      const newColIndex = Math.max(sheet.actualColumnCount, sheet.columnCount, headerRow.actualCellCount) + 1;
      headerRow.getCell(newColIndex).value = op.newColumn.header;
      if (op.newColumn.values) {
        op.newColumn.values.forEach((val, idx) => {
          sheet.getRow(idx + 2).getCell(newColIndex).value = val;
        });
      }
      return `Додано нову колонку «${op.newColumn.header}» до аркуша «${sheet.name}»`;
    }

    if (action === "map_column" && op.newColumn && op.sourceColumn != null && op.valueMap?.length) {
      const headerRow = sheet.getRow(1);
      const headers = new Map<string, number>();
      headerRow.eachCell((cell, colNumber) => headers.set(String(cell.text || cell.value || "").trim().toLowerCase(), colNumber));
      const sourceIndex = typeof op.sourceColumn === "number"
        ? op.sourceColumn
        : headers.get(String(op.sourceColumn).trim().toLowerCase());
      if (!sourceIndex) throw new Error(`Spreadsheet source column not found: ${String(op.sourceColumn)}`);
      const newColIndex = Math.max(sheet.actualColumnCount, sheet.columnCount, headerRow.actualCellCount) + 1;
      headerRow.getCell(newColIndex).value = op.newColumn.header;
      let updated = 0;
      for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
        const source = String(sheet.getRow(rowIndex).getCell(sourceIndex).text ?? "").trim();
        const mapped = this.mapValue(source, op.valueMap);
        sheet.getRow(rowIndex).getCell(newColIndex).value = mapped === undefined ? (op.defaultValue ?? null) : mapped;
        updated++;
      }
      return `Mapped ${updated} rows from «${String(op.sourceColumn)}» into «${op.newColumn.header}» on «${sheet.name}»`;
    }

    // 2. Cell updates
    if (action === "update_cells" && op.cellUpdates?.length) {
      let updatedCount = 0;
      const headerRow = sheet.getRow(1);
      const headers = new Map<string, number>();
      headerRow.eachCell((cell, colNumber) => {
        headers.set(String(cell.text || cell.value || "").trim().toLowerCase(), colNumber);
      });

      for (const update of op.cellUpdates) {
        let targetRowIndex = update.row;
        if (!targetRowIndex && update.searchRow != null) {
          const searchStr = String(update.searchRow).trim().toLowerCase();
          sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            row.eachCell((cell) => {
              const cellText = String(cell.text || cell.value || "").trim().toLowerCase();
              if (cellText === searchStr) {
                targetRowIndex = rowNumber;
              }
            });
          });
        }
        if (!targetRowIndex) continue;

        let colIndex = typeof update.column === "number" ? update.column : headers.get(String(update.column).trim().toLowerCase());
        if (!colIndex && typeof update.column === "string") {
          const colNum = parseInt(update.column, 10);
          if (!isNaN(colNum)) {
            colIndex = colNum;
          } else {
            colIndex = columnLetterToIndex(update.column);
          }
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
                  if (String(cell.text || cell.value || "").trim().toLowerCase() === colKey) targetCol = cNum;
                });
              }
              if (targetCol !== -1) {
                const val = String(row.getCell(targetCol).text || row.getCell(targetCol).value || "").trim().toLowerCase();
                if (val === searchStr || val.includes(searchStr)) insertIndex = rowNumber;
              }
            } else {
              row.eachCell((cell) => {
                if (insertIndex !== -1) return;
                const val = String(cell.text || cell.value || "").trim().toLowerCase();
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
          sheet.insertRow(currentPos, rowData);
          currentPos++;
        }
        return `Вставлено ${op.rows.length} нових рядків після рядка ${insertIndex} у аркуш «${sheet.name}»`;
      }
    }

    // 4. Row deletion
    if (action === "delete_rows" && (op.deleteSearch != null || op.search != null)) {
      const searchStr = String(op.deleteSearch ?? op.search).trim().toLowerCase();
      let deleted = 0;
      for (let rowNumber = sheet.rowCount; rowNumber >= 2; rowNumber--) {
        const row = sheet.getRow(rowNumber);
        let match = false;
        if (op.searchColumn != null) {
          const colKey = String(op.searchColumn).trim().toLowerCase();
          let targetCol = typeof op.searchColumn === "number" ? op.searchColumn : -1;
          if (targetCol === -1) {
            sheet.getRow(1).eachCell((cell, cNum) => {
              if (String(cell.text || cell.value || "").trim().toLowerCase() === colKey) targetCol = cNum;
            });
          }
          if (targetCol !== -1) {
            const val = String(row.getCell(targetCol).text || row.getCell(targetCol).value || "").trim().toLowerCase();
            if (val === searchStr || val.includes(searchStr)) match = true;
          }
        } else {
          row.eachCell((cell) => {
            if (match) return;
            const val = String(cell.text || cell.value || "").trim().toLowerCase();
            if (val === searchStr || val.includes(searchStr)) match = true;
          });
        }
        if (match) {
          sheet.spliceRows(rowNumber, 1);
          deleted++;
        }
      }
      return `Видалено ${deleted} рядків з аркуша «${sheet.name}»`;
    }

    // 5. Replace sheet rows
    if (action === "replace_sheet" && op.rows?.length) {
      const headerRowValues = (sheet.getRow(1).values as any[]).slice(1);
      const isHeaderIncluded = op.rows[0] && op.rows[0].some((c, i) => String(c).trim().toLowerCase() === String(headerRowValues[i] ?? "").trim().toLowerCase());
      const rowsToAdd = isHeaderIncluded ? op.rows.slice(1) : op.rows;
      while (sheet.rowCount > 1) {
        sheet.spliceRows(2, sheet.rowCount - 1);
      }
      for (const rowData of rowsToAdd) {
        sheet.addRow(rowData);
      }
      return `Оновлено дані аркуша «${sheet.name}» (${rowsToAdd.length} рядків)`;
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
      const action = normalizeSpreadsheetAction(op.action) ?? "insert_after";

      if (action === "add_column" && op.newColumn) {
        if (rows.length > 0) rows[0]!.push(op.newColumn.header);
        const colVals = op.newColumn.values ?? [];
        for (let r = 1; r < rows.length; r++) {
          rows[r]!.push(String(colVals[r - 1] ?? ""));
        }
        summaries.push(`Додано колонку «${op.newColumn.header}»`);
        continue;
      }

      if (action === "map_column" && op.newColumn && op.sourceColumn != null && op.valueMap?.length) {
        if (!rows[0]) continue;
        const sourceIndex = typeof op.sourceColumn === "number"
          ? op.sourceColumn - 1
          : rows[0].findIndex((header) => header.trim().toLowerCase() === String(op.sourceColumn).trim().toLowerCase());
        if (sourceIndex < 0) throw new Error(`Spreadsheet source column not found: ${String(op.sourceColumn)}`);
        rows[0].push(op.newColumn.header);
        for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
          const mapped = this.mapValue(rows[rowIndex]![sourceIndex] ?? "", op.valueMap);
          rows[rowIndex]!.push(String(mapped === undefined ? (op.defaultValue ?? "") : mapped));
        }
        summaries.push(`Mapped ${Math.max(0, rows.length - 1)} rows into «${op.newColumn.header}»`);
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
          if (colIdx == null || colIdx < 0) {
            const letterIdx = columnLetterToIndex(u.column);
            if (letterIdx != null) colIdx = letterIdx - 1;
          }
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
        continue;
      }

      if (action === "delete_rows" && (op.deleteSearch != null || op.search != null)) {
        const searchStr = String(op.deleteSearch ?? op.search).toLowerCase();
        let deleted = 0;
        for (let i = rows.length - 1; i >= 1; i--) {
          const row = rows[i]!;
          if (row.some(c => c.toLowerCase() === searchStr || c.toLowerCase().includes(searchStr))) {
            rows.splice(i, 1);
            deleted++;
          }
        }
        summaries.push(`Видалено ${deleted} рядків`);
        continue;
      }

      if (action === "replace_sheet" && op.rows?.length) {
        const stringRows = op.rows.map(r => r.map(c => String(c ?? "")));
        if (rows.length > 0) {
          rows = [rows[0]!, ...stringRows];
        } else {
          rows = stringRows;
        }
        summaries.push(`Оновлено дані таблиці (${stringRows.length} рядків)`);
        continue;
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
    const explicit = text.match(/```(?:spreadsheet-edit|table-edit|excel-edit)\s*([\s\S]*?)```/i);
    const jsonFence = text.match(/```json\s*([\s\S]*?)```/i);
    const candidates: Array<{ raw: string; matched?: string }> = [];
    if (explicit?.[1]) candidates.push({ raw: explicit[1], matched: explicit[0] });
    if (jsonFence?.[1]) candidates.push({ raw: jsonFence[1], matched: jsonFence[0] });
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push({ raw: text.slice(firstBrace, lastBrace + 1) });

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate.raw.trim()) as SpreadsheetEditDirective;
        if (parsed.action) {
          const norm = normalizeSpreadsheetAction(parsed.action);
          if (norm) parsed.action = norm;
        }
        const operations = parsed.operations?.length ? parsed.operations : [parsed];
        const valid = operations.every((operation) => {
          if (!operation) return false;
          if (operation.action) {
            const norm = normalizeSpreadsheetAction(operation.action);
            if (norm) operation.action = norm;
          }
          const inferredAction = operation.action
            ?? (operation.newColumn ? "add_column" : operation.cellUpdates?.length ? "update_cells" : operation.rows?.length ? "append_rows" : "");
          return ["insert_after", "insert_rows", "append_rows", "update_cells", "add_column", "map_column", "delete_rows", "replace_sheet"].includes(inferredAction);
        });
        if (!valid) continue;
        const cleanText = candidate.matched
          ? text.replace(candidate.matched, "").trim()
          : (text.slice(0, firstBrace) + text.slice(lastBrace + 1)).trim();
        return { directive: parsed, cleanText };
      } catch {
        // Try the next supported representation.
      }
    }
    return null;
  }

  private static mapValue(source: string, mappings: NonNullable<SpreadsheetEditOperation["valueMap"]>) {
    const normalized = source.trim().toLowerCase();
    for (const mapping of mappings) {
      const match = mapping.match.trim();
      const needle = match.toLowerCase();
      const matched = mapping.mode === "equals"
        ? normalized === needle
        : mapping.mode === "starts_with"
          ? normalized.startsWith(needle)
          : mapping.mode === "regex"
            ? new RegExp(match, "iu").test(source)
            : normalized.includes(needle);
      if (matched) return mapping.value;
    }
    return undefined;
  }
}
