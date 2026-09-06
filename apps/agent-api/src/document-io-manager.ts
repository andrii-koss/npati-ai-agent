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

    const parseLine = (line: string) =>
      line.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));

    const headers = parseLine(lines[0]!);
    const rows = lines.slice(1).map(parseLine);

    return [{ headers, rows }];
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
          const headersLine = `| ${data.table.headers.join(" | ")} |`;
          const sepLine = `| ${data.table.headers.map(() => "---").join(" | ")} |`;
          const rowsLines = data.table.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
          parts.push(`\n${headersLine}\n${sepLine}\n${rowsLines}`);
        }
        return parts.join("\n");
      }

      case "csv": {
        if (!data.table) return data.text || "";
        const lines = [
          data.table.headers.join(","),
          ...data.table.rows.map((r) => r.join(",")),
        ];
        return lines.join("\n");
      }

      case "json":
        return JSON.stringify(data, null, 2);

      case "text":
      default:
        return [data.title, data.text].filter(Boolean).join("\n\n");
    }
  }
}
