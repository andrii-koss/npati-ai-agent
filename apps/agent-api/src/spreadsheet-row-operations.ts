/**
 * Whole-table operations for chat spreadsheet edits, shared by CSV and XLSX. Before these existed, a sort or "+10%"
 * was emulated with cell-by-cell updates that drifted: an edited CSV paired bouquet names with other rows' prices and
 * stock, and "delete_rows"/"replace_sheet" were accepted but silently did nothing (V6 step 11).
 */
export type Cell = string | number | boolean | null | undefined;

/** A number in a cell ("1 200,50", "$35", "35 USD"); undefined when the cell is not numeric. */
export function cellNumber(value: Cell): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\s ]/g, "").replace(/[^\d.,+-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return undefined;
  const normalized = cleaned.includes(",") && !cleaned.includes(".") ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

export function columnIndex(header: Cell[], column: string | number | undefined, zeroBased = true): number {
  if (column == null) return -1;
  if (typeof column === "number") return zeroBased ? column - 1 : column;
  const wanted = String(column).trim().toLowerCase();
  const found = header.findIndex((cell) => String(cell ?? "").trim().toLowerCase() === wanted);
  if (found >= 0) return zeroBased ? found : found + 1;
  const asNumber = Number.parseInt(wanted, 10);
  return Number.isInteger(asNumber) && String(asNumber) === wanted ? (zeroBased ? asNumber - 1 : asNumber) : -1;
}

/** Sorts data rows (the header stays first) by one column; numbers compare as numbers, the rest as text. */
export function sortRows(rows: Cell[][], column: string | number | undefined, order: "asc" | "desc" = "asc"): Cell[][] {
  const index = columnIndex(rows[0] ?? [], column);
  if (index < 0) throw new Error(`Spreadsheet sort column not found: ${String(column)}`);
  const direction = order === "desc" ? -1 : 1;
  const data = rows.slice(1).map((row, position) => ({ row, position }));
  data.sort((a, b) => {
    const x = a.row[index], y = b.row[index];
    const nx = cellNumber(x), ny = cellNumber(y);
    const compared = nx !== undefined && ny !== undefined ? nx - ny : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" });
    return compared * direction || a.position - b.position;
  });
  return [rows[0] ?? [], ...data.map((item) => item.row)];
}

/** Multiplies and/or adds to every numeric cell of one column, with optional rounding. */
export function scaleColumn(rows: Cell[][], column: string | number | undefined, change: { multiply?: number; add?: number; round?: number }): { rows: Cell[][]; updated: number } {
  const index = columnIndex(rows[0] ?? [], column);
  if (index < 0) throw new Error(`Spreadsheet column not found: ${String(column)}`);
  if (change.multiply === undefined && change.add === undefined) throw new Error("scale_column needs multiply or add");
  let updated = 0;
  const next = rows.map((row, rowIndex) => {
    if (rowIndex === 0) return row;
    const number = cellNumber(row[index]);
    if (number === undefined) return row;
    let value = number * (change.multiply ?? 1) + (change.add ?? 0);
    if (change.round !== undefined) value = Number(value.toFixed(Math.max(0, Math.min(10, change.round))));
    updated++;
    const copy = [...row];
    copy[index] = value;
    return copy;
  });
  return { rows: next, updated };
}

/** Removes data rows whose cell (in one column, or in any column) equals the value. */
export function deleteRows(rows: Cell[][], value: string | number | undefined, column?: string | number): { rows: Cell[][]; deleted: number } {
  if (value == null || String(value).trim() === "") throw new Error("delete_rows needs deleteSearch");
  const wanted = String(value).trim().toLowerCase();
  const index = column == null ? -1 : columnIndex(rows[0] ?? [], column);
  if (column != null && index < 0) throw new Error(`Spreadsheet column not found: ${String(column)}`);
  const matches = (row: Cell[]) => (index >= 0 ? [row[index]] : row).some((cell) => String(cell ?? "").trim().toLowerCase() === wanted);
  const kept = rows.filter((row, rowIndex) => rowIndex === 0 || !matches(row));
  return { rows: kept, deleted: rows.length - kept.length };
}

/** Numeric comparison modes for map_column ("Reorder = yes when Stock is under 5" is {match:"5", mode:"lt"}). */
export function numericMatch(source: string, match: string, mode: string): boolean | undefined {
  if (!["lt", "lte", "gt", "gte", "eq_number"].includes(mode)) return undefined;
  const x = cellNumber(source), y = cellNumber(match);
  if (x === undefined || y === undefined) return false;
  return mode === "lt" ? x < y : mode === "lte" ? x <= y : mode === "gt" ? x > y : mode === "gte" ? x >= y : x === y;
}
