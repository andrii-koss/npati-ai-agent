export interface ParsedDocument {
  filename: string;
  format: "markdown" | "csv" | "json" | "text" | "pdf" | "docx";
  text: string;
  wordCount: number;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  metadata?: Record<string, unknown>;
}

export class DocumentIoManager {
  /**
   * 1. Parse multi-format document input (Text, Markdown, CSV, JSON, Document Buffers)
   */
  static parseDocument(
    content: string | Buffer,
    filename: string,
    mimeType?: string
  ): ParsedDocument {
    const rawText = Buffer.isBuffer(content) ? content.toString("utf8") : content;
    const ext = filename.split(".").pop()?.toLowerCase() || "";

    let format: ParsedDocument["format"] = "text";
    let tables: Array<{ headers: string[]; rows: string[][] }> | undefined;

    if (ext === "md" || mimeType?.includes("markdown")) {
      format = "markdown";
    } else if (ext === "json" || mimeType?.includes("json")) {
      format = "json";
      tables = this.parseJsonTables(rawText);
    } else if (ext === "csv" || mimeType?.includes("csv")) {
      format = "csv";
      tables = this.parseCsvTables(rawText);
    } else if (ext === "pdf" || mimeType?.includes("pdf")) {
      format = "pdf";
    } else if (ext === "docx" || mimeType?.includes("word")) {
      format = "docx";
    }

    const wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;

    return {
      filename,
      format,
      text: rawText,
      wordCount,
      tables,
      metadata: {
        sizeBytes: Buffer.byteLength(rawText, "utf8"),
        parsedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Parse CSV string into structured table headers and rows
   */
  private static parseCsvTables(csvText: string): Array<{ headers: string[]; rows: string[][] }> {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];

    const parseLine = (line: string) => {
      const result: string[] = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim().replace(/^["']|["']$/g, ""));
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim().replace(/^["']|["']$/g, ""));
      return result;
    };

    const headers = parseLine(lines[0]!);
    const rows = lines.slice(1).map(parseLine);

    return [{ headers, rows }];
  }

  /**
   * Parse JSON string to extract structured table if array of objects
   */
  private static parseJsonTables(jsonText: string): Array<{ headers: string[]; rows: string[][] }> | undefined {
    try {
      const parsed = JSON.parse(jsonText);
      const array = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.rows) ? parsed.rows : null;
      if (!array || array.length === 0 || typeof array[0] !== "object") {
        return undefined;
      }
      const headers = Object.keys(array[0]);
      const rows = array.map((item: Record<string, unknown>) => headers.map((h) => String(item[h] ?? "")));
      return [{ headers, rows }];
    } catch {
      return undefined;
    }
  }

  /**
   * 2. Generate formatted document output
   */
  static generateDocument(
    data: { title?: string; text?: string; table?: { headers: string[]; rows: string[][] } },
    format: "markdown" | "csv" | "json" | "text"
  ): string {
    switch (format) {
      case "markdown": {
        const parts: string[] = [];
        if (data.title) parts.push(`# ${data.title}\n`);
        if (data.text) parts.push(data.text);
        if (data.table) {
          const escapeMd = (str: string) => str.replace(/\|/g, "\\|");
          const headersLine = `| ${data.table.headers.map(escapeMd).join(" | ")} |`;
          const sepLine = `| ${data.table.headers.map(() => "---").join(" | ")} |`;
          const rowsLines = data.table.rows.map((r) => `| ${r.map(escapeMd).join(" | ")} |`).join("\n");
          parts.push(`\n${headersLine}\n${sepLine}\n${rowsLines}`);
        }
        return parts.join("\n");
      }

      case "csv": {
        if (!data.table) return data.text || "";
        const escapeCsv = (val: string) => {
          if (val.includes(",") || val.includes('"') || val.includes("\n")) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        };
        const lines = [
          data.table.headers.map(escapeCsv).join(","),
          ...data.table.rows.map((r) => r.map(escapeCsv).join(",")),
        ];
        return lines.join("\n");
      }

      case "json":
        return JSON.stringify(data, null, 2);

      case "text":
        return [data.title, data.text].filter(Boolean).join("\n\n");

      default:
        throw new Error(`UNSUPPORTED_FORMAT: Format '${format}' is not supported.`);
    }
  }
}
