import readXlsxFile from "read-excel-file/node";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as fflate from "fflate";

export interface ExtractedDocumentResult {
  filename: string;
  mimeType: string;
  kind: "spreadsheet" | "document" | "archive" | "text";
  text: string;
}

export function inferMimeType(filename: string, fallback = "application/octet-stream"): string {
  const lower = filename.toLowerCase();
  if (/\.(xlsx|xlsm|xlsb)$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.xls$/i.test(lower)) return "application/vnd.ms-excel";
  if (/\.csv$/i.test(lower)) return "text/csv";
  if (/\.tsv$/i.test(lower)) return "text/tab-separated-values";
  if (/\.pdf$/i.test(lower)) return "application/pdf";
  if (/\.docx$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.doc$/i.test(lower)) return "application/msword";
  if (/\.pptx$/i.test(lower)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (/\.ppt$/i.test(lower)) return "application/vnd.ms-powerpoint";
  if (/\.zip$/i.test(lower)) return "application/zip";
  if (/\.(tar|tar\.gz|tgz)$/i.test(lower)) return "application/x-tar";
  if (/\.gz$/i.test(lower)) return "application/gzip";
  if (/\.json$/i.test(lower)) return "application/json";
  if (/\.xml$/i.test(lower)) return "application/xml";
  if (/\.(txt|log|ini|cfg|env)$/i.test(lower)) return "text/plain";
  if (/\.(md|markdown)$/i.test(lower)) return "text/markdown";
  if (/\.(html|htm)$/i.test(lower)) return "text/html";
  if (/\.(css)$/i.test(lower)) return "text/css";
  if (/\.(js|mjs|cjs)$/i.test(lower)) return "application/javascript";
  if (/\.(ts|tsx)$/i.test(lower)) return "application/typescript";
  if (/\.(yaml|yml)$/i.test(lower)) return "application/x-yaml";
  if (/\.(m4a)$/i.test(lower)) return "audio/mp4";
  if (/\.(mp3)$/i.test(lower)) return "audio/mpeg";
  if (/\.(wav)$/i.test(lower)) return "audio/wav";
  if (/\.(ogg)$/i.test(lower)) return "audio/ogg";
  if (/\.(webm)$/i.test(lower)) return "audio/webm";
  if (/\.(png)$/i.test(lower)) return "image/png";
  if (/\.(jpg|jpeg)$/i.test(lower)) return "image/jpeg";
  if (/\.(webp)$/i.test(lower)) return "image/webp";
  if (/\.(gif)$/i.test(lower)) return "image/gif";
  return fallback;
}

export async function extractDocumentText(data: Buffer, declaredMime: string, filename: string): Promise<string> {
  const mime = (declaredMime && declaredMime !== "application/octet-stream")
    ? declaredMime.toLowerCase().split(";", 1)[0]!.trim()
    : inferMimeType(filename, declaredMime);
  const lowerName = filename.toLowerCase();

  const MAX_TOTAL_CHARS = 60_000;

  // 1. Spreadsheets / Tables (.xlsx, .xlsm, .xlsb, .xls)
  if (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    mime.includes("msexcel") ||
    /\.(xlsx|xlsm|xlsb|xls)$/i.test(lowerName)
  ) {
    let target: Buffer = data;
    try {
      const unzipped = fflate.unzipSync(new Uint8Array(data));
      let hasBackslash = false;
      const fixed: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(unzipped)) {
        if (k.includes("\\")) hasBackslash = true;
        fixed[k.replace(/\\/g, "/")] = v;
      }
      if (hasBackslash) target = Buffer.from(fflate.zipSync(fixed));
    } catch {}

    try {
      const sheets = await readXlsxFile(target);
      if (!sheets || sheets.length === 0) return `[Spreadsheet: ${filename} is empty]`;
      const sheetTexts: string[] = [];
      let totalDocChars = 0;
      const maxRowsPerSheet = 120;

      for (const s of sheets) {
        if (totalDocChars >= MAX_TOTAL_CHARS) {
          sheetTexts.push(`\n... [Additional sheets truncated to fit context budget]`);
          break;
        }
        const sheetName = s.sheet || "Sheet";
        const rawRows = s.data || [];
        const nonEmptyRows = rawRows.filter(row => row && row.some(cell => cell != null && String(cell).trim() !== ""));
        if (nonEmptyRows.length === 0) continue;

        let displayedRows: any[][];
        let truncationNote = "";
        if (nonEmptyRows.length <= 350) {
          displayedRows = nonEmptyRows;
        } else {
          // Keep header and first 220 rows + last 80 rows
          displayedRows = [
            ...nonEmptyRows.slice(0, 220),
            [null, "...", `[${nonEmptyRows.length - 300} intermediate rows omitted for context budget]`, "..."],
            ...nonEmptyRows.slice(-80),
          ];
          truncationNote = `\n... [${nonEmptyRows.length - 300} intermediate rows omitted]`;
        }
        const colCount = Math.max(...nonEmptyRows.slice(0, 20).map(r => r.length));

        const formattedRows = displayedRows.map((row) => {
          return row.map(cell => {
            if (cell == null) return "";
            if (cell instanceof Date) return cell.toISOString().split("T")[0]!;
            return String(cell).replace(/[\r\n\t]+/g, " ").trim();
          }).join(" | ");
        });

        let text = `[Table / Sheet: ${sheetName}] (${nonEmptyRows.length} rows, ${colCount} cols):\n` + formattedRows.join("\n") + truncationNote;
        if (totalDocChars + text.length > MAX_TOTAL_CHARS) {
          text = text.slice(0, Math.max(500, MAX_TOTAL_CHARS - totalDocChars)) + `\n... [Content truncated]`;
        }
        totalDocChars += text.length;
        sheetTexts.push(text);
      }
      return sheetTexts.length > 0 ? sheetTexts.join("\n\n") : `[Spreadsheet: ${filename} has no data rows]`;
    } catch (excelErr) {
      const fallback = data.toString("utf8").replace(/\0/g, "").trim();
      if (fallback.length > 50) return fallback.slice(0, 10000);
      throw excelErr;
    }
  }

  // 2. CSV / TSV
  if (mime === "text/csv" || mime === "text/tab-separated-values" || /\.(csv|tsv)$/i.test(lowerName)) {
    let text = data.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    const maxLines = 300;
    const displayed = lines.slice(0, maxLines);
    let result = `[CSV/Table: ${filename}] (${lines.length} rows):\n` + displayed.join("\n");
    if (lines.length > maxLines) {
      result += `\n... [${lines.length - maxLines} additional rows truncated]`;
    }
    return result;
  }

  // 3. Word Documents (.docx, .doc)
  if (mime.includes("wordprocessingml") || mime.includes("msword") || /\.(docx|doc)$/i.test(lowerName)) {
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      const val = result.value.trim();
      return val || `[Word document: ${filename} has no readable text]`;
    } catch (docErr) {
      const printable = data.toString("utf8").replace(/[^\x20-\x7E\n\r\t\u0400-\u04FF]/g, " ").replace(/\s{2,}/g, " ").trim();
      if (printable.length > 100) return printable.slice(0, 20000);
      throw docErr;
    }
  }

  // 4. PDF Documents (.pdf)
  if (mime === "application/pdf" || /\.pdf$/i.test(lowerName)) {
    const p = new PDFParse({ data });
    try {
      const res = await p.getText();
      const text = (res.text || "").trim();
      return text || `[PDF: ${filename} has no readable text]`;
    } finally {
      await p.destroy();
    }
  }

  // 5. Zip Archives (.zip)
  const isZipSig = data[0] === 0x50 && data[1] === 0x4b;
  if (mime.includes("zip") || /\.zip$/i.test(lowerName) || isZipSig) {
    try {
      const unzipped = fflate.unzipSync(new Uint8Array(data));
      const entries = Object.entries(unzipped);
      if (entries.length === 0) return `[Archive ${filename} is empty]`;

      const fileList = entries.map(([name, bytes]) => {
        const sizeKb = (bytes.length / 1024).toFixed(1);
        return `- ${name} (${sizeKb} KB)`;
      });

      const extractedParts: string[] = [];
      let totalExtractedBytes = 0;
      const MAX_ARCHIVE_BYTES = 60 * 1024;

      for (const [entryName, entryBytes] of entries) {
        if (totalExtractedBytes >= MAX_ARCHIVE_BYTES) {
          extractedParts.push(`\n... [Remaining archive files omitted to preserve size limit]`);
          break;
        }
        const subLower = entryName.toLowerCase();
        if (/\.(txt|md|markdown|json|csv|tsv|xml|yaml|yml|html|css|js|jsx|ts|tsx|py|sql|sh|bat|ps1|ini|cfg|env|properties)$/i.test(subLower)) {
          try {
            const fileText = Buffer.from(entryBytes).toString("utf8");
            if (!fileText.slice(0, 512).includes("\0")) {
              const slice = fileText.slice(0, 6000);
              extractedParts.push(`\n--- Archive file: ${entryName} ---\n${slice}${fileText.length > 6000 ? "\n... [File truncated]" : ""}`);
              totalExtractedBytes += slice.length;
            }
          } catch {}
        } else if (/\.(xlsx|xlsm)$/i.test(subLower)) {
          try {
            const subSheets = await readXlsxFile(Buffer.from(entryBytes));
            if (subSheets.length > 0) {
              const firstSheet = subSheets[0];
              const rows = (firstSheet?.data || []).slice(0, 40).map(r => r.join(" | ")).join("\n");
              extractedParts.push(`\n--- Archive spreadsheet: ${entryName} (Sheet: ${firstSheet?.sheet || "Sheet1"}) ---\n${rows}`);
              totalExtractedBytes += rows.length;
            }
          } catch {}
        }
      }

      let archiveSummary = `[Archive: ${filename} (${entries.length} files)]\nFiles in archive:\n` + fileList.slice(0, 80).join("\n");
      if (entries.length > 80) archiveSummary += `\n... and ${entries.length - 80} more files`;
      if (extractedParts.length > 0) {
        archiveSummary += `\n\nExtracted contents:\n` + extractedParts.join("\n");
      }
      return archiveSummary;
    } catch (zipErr) {
      // If fflate fails, fallback to general error or text
      throw new Error(`Failed to read archive ${filename}: ${zipErr instanceof Error ? zipErr.message : String(zipErr)}`);
    }
  }

  // 6. Plain text, JSON, Markdown, XML, Code, Config
  let text = data.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const maxChars = 40000;
  if (text.length > maxChars) {
    return text.slice(0, maxChars) + `\n... [${text.length - maxChars} characters truncated]`;
  }
  return text;
}
