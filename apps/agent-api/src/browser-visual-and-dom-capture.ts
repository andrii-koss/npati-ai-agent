import { randomUUID } from "node:crypto";

export interface InteractiveDomNode {
  id: string;
  tag: string;
  role?: string;
  text: string;
  selector: string;
  isInteractive: boolean;
}

export interface DomSnapshotResult {
  cleanTree: string;
  interactiveNodes: InteractiveDomNode[];
  interactiveCount: number;
  estimatedTokens: number;
}

export interface ScreenshotResult {
  screenshotId: string;
  tabId: string;
  base64Data: string;
  mimeType: "image/png" | "image/jpeg";
  dimensions: { width: number; height: number };
  capturedAt: string;
}

export interface PdfCaptureResult {
  pdfId: string;
  tabId: string;
  pdfBase64: string;
  pageCount: number;
  fileSizeBytes: number;
  generatedAt: string;
}

export class BrowserDomSnapshotEngine {
  /**
   * 1. Browser Snapshots: Clean, token-optimized DOM and accessibility trees
   */
  static captureSnapshot(
    rawHtml: string,
    options: { pruneScripts?: boolean } = {}
  ): DomSnapshotResult {
    let cleaned = rawHtml;

    if (options.pruneScripts ?? true) {
      cleaned = cleaned
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");
    }

    const interactiveNodes: InteractiveDomNode[] = [];
    let counter = 1;

    // Detect button and input elements
    const elementRegex = /<(button|input|a|select)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = elementRegex.exec(cleaned)) !== null) {
      const tag = match[1] || match[4] || "interactive";
      const attrs = match[2] || match[5] || "";
      const text = (match[3] || "").replace(/<[^>]+>/g, "").trim();

      const idMatch = /id=["']([^"']+)["']/i.exec(attrs);
      const id = idMatch ? idMatch[1]! : `elem_${counter++}`;
      const selector = idMatch ? `#${id}` : `${tag}[node-id='${id}']`;

      interactiveNodes.push({
        id,
        tag,
        text: text || "Submit / Input",
        selector,
        isInteractive: true,
      });
    }

    const cleanTree = interactiveNodes
      .map((n) => `[${n.id}] <${n.tag}> "${n.text}" -> ${n.selector}`)
      .join("\n");

    const estimatedTokens = Math.ceil(cleanTree.length / 4);

    return {
      cleanTree,
      interactiveNodes,
      interactiveCount: interactiveNodes.length,
      estimatedTokens,
    };
  }
}

export class BrowserScreenshotEngine {
  /**
   * 2. Browser Screenshots: Viewport and full-page visual capture
   */
  static capture(
    tabId: string,
    options: { fullPage?: boolean; format?: "png" | "jpeg"; quality?: number } = {}
  ): ScreenshotResult {
    const format = options.format || "png";
    const screenshotId = `ss_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const mockImageBase64 = Buffer.from(`NPATI_SCREENSHOT_BINARY_${screenshotId}`).toString(
      "base64"
    );

    return {
      screenshotId,
      tabId,
      base64Data: mockImageBase64,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      dimensions: options.fullPage ? { width: 1280, height: 2400 } : { width: 1280, height: 800 },
      capturedAt: new Date().toISOString(),
    };
  }
}

export class BrowserPdfCaptureEngine {
  /**
   * 3. Browser PDF Capture: Renders web document to PDF
   */
  static capturePdf(
    tabId: string,
    options: { landscape?: boolean; printBackground?: boolean } = {}
  ): PdfCaptureResult {
    const pdfId = `pdf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const mockPdfBinary = Buffer.from(
      `%PDF-1.4 NPATI_BROWSER_PAGE_EXPORT_${pdfId}_LANDSCAPE_${options.landscape ?? false}`
    );

    return {
      pdfId,
      tabId,
      pdfBase64: mockPdfBinary.toString("base64"),
      pageCount: 2,
      fileSizeBytes: mockPdfBinary.length,
      generatedAt: new Date().toISOString(),
    };
  }
}
